/**
 * OpenAPI(3.0 / 3.1)の仕様に対する、実行結果の応答検証とカバレッジ集計。
 *
 * - 仕様はローカルファイル(YAML / JSON)だけを読む。リモートの $ref は拒否し、ローカルファイルの $ref は
 *   拡張子(.yaml / .yml / .json)と件数・サイズの上限の範囲で解決する(循環参照は訪問済み管理で止める)。
 *   仕様の中身は一切実行しない。エラーメッセージには、参照先ファイルの内容を載せない
 * - リクエストは「サーバー URL の接頭辞 → パステンプレート + メソッド」でオペレーションに照合する
 *   (具体的なパスをテンプレートより優先する)。照合は OpenApiOperation を返す単純な関数に分けてあり、
 *   将来リクエスト側の検証(パラメーター・リクエストボディ)を足すときはその結果を使えばよい
 * - 応答の検証は Ajv(2020-12)で行う。3.0 のスキーマは必要なキーワードだけ変換する(readOnly / writeOnly や
 *   format の扱いは docs/guide/cli.md を参照)。スキーマのコンパイルはオペレーションごとに遅延させ、実行中は使い回す
 * - core は CLI / server に依存しない。環境変数も読まない
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { parse as parseYaml } from "yaml";
import { ParseError } from "./errors.js";
import { toDisplayPath } from "./path-guard.js";
import type {
  AssertionResult,
  OpenApiAssertionDetail,
  OpenApiRunSummary,
  OpenApiState,
  OpenApiViolation,
} from "./types.js";

/** 1 ファイルの最大サイズ(バイト) */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** 読み込むファイルの合計サイズ(バイト) */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** 読み込むファイルの最大数(ルート + $ref で辿るファイル) */
const MAX_FILES = 100;
/** $ref を探すために辿るノード数の上限(全ファイル合計) */
const MAX_NODES = 4_000_000;
/** $ref の連鎖(別名)を辿る最大段数 */
const MAX_REF_HOPS = 32;
/** スキーマ変換の最大ネスト */
const MAX_SCHEMA_DEPTH = 100;
/** 1 つの応答スキーマが参照できるスキーマ定義の最大数 */
const MAX_DEFS = 5000;
/** 仕様に含められるオペレーションの最大数 */
const MAX_OPERATIONS = 20_000;
/** アサーションに載せる違反の最大数 */
export const MAX_OPENAPI_VIOLATIONS = 20;
/** メッセージの見出しに並べる違反の数 */
const MESSAGE_VIOLATIONS = 3;
/** サマリーの一覧(covered / uncovered / unmatched / excluded)の最大件数 */
const MAX_SUMMARY_ROWS = 1000;
/** 警告の最大数 */
const MAX_WARNINGS = 50;

const SPEC_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// 仕様ファイルの読み込みと $ref
// ---------------------------------------------------------------------------

/** 参照先を表す(ファイルは実パス、pointer は JSON Pointer を分解したもの) */
interface RefTarget {
  file: string;
  pointer: string[];
}

/** 値を持たないキー・名前を持つキー: $ref を探すときに、その直下の子を「キーワード」として扱わない対象 */
const NAME_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
  "schemas",
  "responses",
  "parameters",
  "headers",
  "requestBodies",
  "securitySchemes",
  "links",
  "callbacks",
  "pathItems",
  "paths",
  "content",
  "mapping",
]);

/** $ref を探すとき、値のデータ(例・列挙値など)を辿らないためのキーワード */
const DATA_KEYS = new Set(["example", "examples", "enum", "const", "default"]);

function hasOwn(target: object, key: string): boolean {
  return Object.hasOwn(target, key);
}

/** JSON Pointer を辿る。存在しなければ undefined(プロトタイプのキーは辿らない) */
function getPointer(data: unknown, pointer: string[]): unknown {
  let current: unknown = data;
  for (const segment of pointer) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isRecord(current) && hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function parseRef(ref: string, fromFile: string): RefTarget {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) {
    const shown = ref.length > 120 ? `${ref.slice(0, 120)}...` : ref;
    throw new ParseError(
      `remote $ref is not supported (only local files can be referenced): ${shown}`,
    );
  }
  const hash = ref.indexOf("#");
  const filePart = hash < 0 ? ref : ref.slice(0, hash);
  const fragment = hash < 0 ? "" : ref.slice(hash + 1);
  if (fragment !== "" && !fragment.startsWith("/")) {
    throw new ParseError(`only JSON Pointer fragments are supported in $ref: ${ref}`);
  }
  const file = filePart === "" ? fromFile : resolve(dirname(fromFile), safeDecode(filePart));
  const pointer =
    fragment === ""
      ? []
      : fragment
          .slice(1)
          .split("/")
          .map((segment) => safeDecode(segment).replace(/~1/g, "/").replace(/~0/g, "~"));
  return { file, pointer };
}

/** データ(文書)の中の $ref 文字列をすべて集める。例・列挙値などのデータ部は辿らない */
function collectRefs(data: unknown, budget: { nodes: number }): string[] {
  const refs: string[] = [];
  const stack: { value: unknown; nameMap: boolean }[] = [{ value: data, nameMap: false }];
  while (stack.length > 0) {
    const { value, nameMap } = stack.pop() as { value: unknown; nameMap: boolean };
    budget.nodes += 1;
    if (budget.nodes > MAX_NODES) {
      throw new ParseError("the OpenAPI document is too large to process");
    }
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, nameMap: false });
      continue;
    }
    if (!isRecord(value)) continue;
    if (!nameMap && typeof value.$ref === "string") refs.push(value.$ref);
    for (const [key, child] of Object.entries(value)) {
      if (!nameMap && (DATA_KEYS.has(key) || key.startsWith("x-"))) continue;
      if (typeof child !== "object" || child === null) continue;
      stack.push({ value: child, nameMap: !nameMap && NAME_MAP_KEYS.has(key) });
    }
  }
  return refs;
}

/** 読み込んだ仕様ファイル群($ref で辿れるファイルを含む) */
class SpecFiles {
  readonly files = new Map<string, unknown>();
  /** $ref が指す表記上のパス → 実パス(シンボリックリンク経由の参照を、読み込み済みのファイルに引き当てる) */
  private readonly aliases = new Map<string, string>();
  readonly warnings: string[] = [];
  readonly rootPath: string;

  private constructor(rootPath: string) {
    this.rootPath = rootPath;
  }

  static async load(path: string, cwd: string): Promise<SpecFiles> {
    const rootPath = await SpecFiles.realPathOf(path, cwd);
    const specs = new SpecFiles(rootPath);
    const state = { bytes: 0, nodes: 0 };
    const refsByFile = new Map<string, string[]>();
    const queue = [rootPath];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (specs.files.has(file)) continue;
      if (specs.files.size >= MAX_FILES) {
        throw new ParseError(
          `too many files are referenced from the OpenAPI document (max ${MAX_FILES})`,
        );
      }
      const data = await SpecFiles.readFile(file, state, cwd);
      specs.files.set(file, data);
      const refs = collectRefs(data, state);
      refsByFile.set(file, refs);
      for (const ref of refs) {
        const target = parseRef(ref, file);
        if (target.file !== file && !specs.aliases.has(target.file)) {
          const real = await SpecFiles.realPathOf(target.file, cwd, file);
          specs.aliases.set(target.file, real);
          if (!specs.files.has(real)) queue.push(real);
        }
      }
    }
    // すべての $ref の行き先が存在することを実行前に確かめる(実行中に初めて壊れた参照が見つかるのを避ける)
    for (const [file, refs] of refsByFile) {
      for (const ref of refs) {
        const target = parseRef(ref, file);
        const targetFile = specs.resolveLoaded(target.file) as string;
        if (getPointer(specs.files.get(targetFile), target.pointer) === undefined) {
          throw new ParseError(`$ref "${ref}" cannot be resolved`, toDisplayPath(cwd, file));
        }
      }
    }
    return specs;
  }

  /** 実パスを返す。存在しない・拡張子が YAML/JSON でないものは ParseError */
  private static async realPathOf(path: string, cwd: string, referrer?: string): Promise<string> {
    const shown = toDisplayPath(cwd, path);
    const from = referrer !== undefined ? toDisplayPath(cwd, referrer) : undefined;
    if (!SPEC_EXTENSIONS.has(extname(path).toLowerCase())) {
      throw new ParseError(
        `only .yaml, .yml and .json files can be used as OpenAPI documents or $ref targets: ${shown}`,
        from,
      );
    }
    let real: string;
    try {
      real = await realpath(resolve(cwd, path));
    } catch {
      throw new ParseError(`OpenAPI document not found: ${shown}`, from);
    }
    if (!SPEC_EXTENSIONS.has(extname(real).toLowerCase())) {
      throw new ParseError(
        `only .yaml, .yml and .json files can be used as OpenAPI documents or $ref targets: ${shown}`,
        from,
      );
    }
    return real;
  }

  private static async readFile(
    file: string,
    state: { bytes: number },
    cwd: string,
  ): Promise<unknown> {
    const shown = toDisplayPath(cwd, file);
    const info = await stat(file);
    if (!info.isFile()) throw new ParseError("not a regular file", shown);
    if (info.size > MAX_FILE_BYTES) {
      throw new ParseError(`file is too large (max ${MAX_FILE_BYTES} bytes)`, shown);
    }
    state.bytes += info.size;
    if (state.bytes > MAX_TOTAL_BYTES) {
      throw new ParseError("the referenced OpenAPI files are too large in total", shown);
    }
    let text: string;
    try {
      text = await readFile(file, "utf-8");
    } catch {
      throw new ParseError("failed to read file", shown);
    }
    try {
      return extname(file).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text);
    } catch (error) {
      // パーサーのメッセージには周辺の行が入るため、位置だけを伝える(参照先の内容を出さない)
      const pos = (error as { linePos?: { line: number; col: number }[] }).linePos?.[0];
      throw new ParseError(
        pos !== undefined
          ? `failed to parse as ${extname(file).slice(1)} (line ${pos.line}, column ${pos.col})`
          : "failed to parse as YAML/JSON",
        shown,
      );
    }
  }

  /** $ref の連鎖を辿って、最終的なノードとそのファイルを返す。循環・深すぎる場合は undefined */
  deref(node: unknown, file: string): { node: unknown; file: string } | undefined {
    let current = node;
    let currentFile = file;
    for (let hops = 0; hops <= MAX_REF_HOPS; hops++) {
      if (!isRecord(current) || typeof current.$ref !== "string") {
        return { node: current, file: currentFile };
      }
      let target: RefTarget;
      try {
        target = parseRef(current.$ref, currentFile);
      } catch {
        return undefined;
      }
      const targetFile = this.resolveLoaded(target.file);
      if (targetFile === undefined) return undefined;
      current = getPointer(this.files.get(targetFile), target.pointer);
      currentFile = targetFile;
    }
    return undefined;
  }

  /** parseRef が返したファイルパス(実パスとは限らない)を、読み込み済みのキー(実パス)に引き当てる */
  resolveLoaded(path: string): string | undefined {
    if (this.files.has(path)) return path;
    return this.aliases.get(path);
  }
}

// ---------------------------------------------------------------------------
// スキーマ変換(OpenAPI → JSON Schema 2020-12)
// ---------------------------------------------------------------------------

/** 値がサブスキーマ 1 つのキーワード */
const SINGLE_SCHEMA_KEYS = new Set([
  "items",
  "additionalProperties",
  "additionalItems",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
]);
/** 値がサブスキーマの配列のキーワード */
const ARRAY_SCHEMA_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
/** 値が「名前 → サブスキーマ」のキーワード */
const MAP_SCHEMA_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
/** 検証に関係しないため取り除くキーワード(注釈・識別用) */
const DROPPED_KEYS = new Set([
  "discriminator",
  "xml",
  "externalDocs",
  "example",
  "$schema",
  "$id",
  "$anchor",
  "$dynamicAnchor",
]);
/** サポートしないため取り除き、警告にするキーワード */
const UNSUPPORTED_KEYS = new Set(["$dynamicRef", "$recursiveRef"]);

class SchemaBuilder {
  private readonly defs: Record<string, unknown> = {};
  private readonly ids = new Map<string, string>();
  private readonly queue: { id: string; file: string; node: unknown }[] = [];

  constructor(
    private readonly specs: SpecFiles,
    private readonly oas30: boolean,
    private readonly warn: (message: string) => void,
  ) {}

  /** ルートのスキーマ(+ 参照されるスキーマを $defs に集めたもの)を、単体で Ajv に渡せる形にして返す */
  build(node: unknown, file: string): Json | boolean {
    const root = this.convert(node, file, 0);
    while (this.queue.length > 0) {
      const item = this.queue.shift() as { id: string; file: string; node: unknown };
      this.defs[item.id] = this.convert(item.node, item.file, 0);
    }
    if (typeof root === "boolean") return root;
    const rootDefs = isRecord(root.$defs) ? root.$defs : {};
    return { ...root, $defs: { ...rootDefs, ...this.defs } };
  }

  private convert(node: unknown, file: string, depth: number): Json | boolean {
    if (depth > MAX_SCHEMA_DEPTH) throw new Error("the schema is nested too deeply");
    if (typeof node === "boolean") return node;
    if (!isRecord(node)) return {};
    if (typeof node.$ref === "string") {
      const target = this.refTo(node.$ref, file);
      // 3.0 では $ref の兄弟キーワードは無視される。3.1 では兄弟も有効
      if (this.oas30) return target;
      const { $ref: _ref, ...siblings } = node;
      return { ...this.convertKeywords(siblings, file, depth), ...target };
    }
    return this.convertKeywords(node, file, depth);
  }

  private refTo(ref: string, file: string): Json {
    const seen = new Set<string>();
    let currentRef = ref;
    let currentFile = file;
    for (let hops = 0; hops <= MAX_REF_HOPS; hops++) {
      let target: RefTarget;
      try {
        target = parseRef(currentRef, currentFile);
      } catch {
        this.warn(`a $ref in the schema cannot be used and is treated as "any value": ${ref}`);
        return {};
      }
      const targetFile = this.specs.resolveLoaded(target.file);
      const node =
        targetFile === undefined
          ? undefined
          : getPointer(this.specs.files.get(targetFile), target.pointer);
      if (targetFile === undefined || node === undefined) {
        this.warn(`a $ref in the schema cannot be resolved and is treated as "any value": ${ref}`);
        return {};
      }
      const key = `${targetFile}#/${target.pointer.join("/")}`;
      if (isRecord(node) && typeof node.$ref === "string") {
        if (seen.has(key)) {
          this.warn(
            `a $ref cycle without any schema was found and is treated as "any value": ${ref}`,
          );
          return {};
        }
        seen.add(key);
        currentRef = node.$ref;
        currentFile = targetFile;
        continue;
      }
      let id = this.ids.get(key);
      if (id === undefined) {
        if (this.ids.size >= MAX_DEFS) throw new Error("the schema references too many schemas");
        id = `d${this.ids.size}`;
        this.ids.set(key, id);
        this.queue.push({ id, file: targetFile, node });
      }
      return { $ref: `#/$defs/${id}` };
    }
    this.warn(`a $ref chain is too long and is treated as "any value": ${ref}`);
    return {};
  }

  private convertKeywords(node: Json, file: string, depth: number): Json {
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "__proto__" || DROPPED_KEYS.has(key)) continue;
      if (UNSUPPORTED_KEYS.has(key)) {
        this.warn(`the schema keyword ${key} is not supported and is ignored`);
        continue;
      }
      if (
        this.oas30 &&
        (key === "nullable" || key === "exclusiveMinimum" || key === "exclusiveMaximum")
      ) {
        continue;
      }
      if (SINGLE_SCHEMA_KEYS.has(key)) {
        out[key] = Array.isArray(value)
          ? value.map((item) => this.convert(item, file, depth + 1))
          : this.convert(value, file, depth + 1);
      } else if (ARRAY_SCHEMA_KEYS.has(key) && Array.isArray(value)) {
        out[key] = value.map((item) => this.convert(item, file, depth + 1));
      } else if (MAP_SCHEMA_KEYS.has(key) && isRecord(value)) {
        const mapped: Json = {};
        for (const [name, child] of Object.entries(value)) {
          if (name === "__proto__") continue;
          mapped[name] = this.convert(child, file, depth + 1);
        }
        out[key] = mapped;
      } else if (key === "dependencies" && isRecord(value)) {
        const mapped: Json = {};
        for (const [name, child] of Object.entries(value)) {
          if (name === "__proto__") continue;
          mapped[name] = Array.isArray(child) ? child : this.convert(child, file, depth + 1);
        }
        out[key] = mapped;
      } else if (key === "required" && Array.isArray(value)) {
        // 応答では writeOnly のプロパティは返らないため、必須から外す
        out[key] = value.filter(
          (name) => !(typeof name === "string" && this.isWriteOnly(node, name, file)),
        );
      } else {
        out[key] = value;
      }
    }
    if (this.oas30) this.applyOas30(node, out);
    return out;
  }

  private isWriteOnly(node: Json, name: string, file: string): boolean {
    const properties = node.properties;
    if (!isRecord(properties) || !hasOwn(properties, name)) return false;
    const resolved = this.specs.deref(properties[name], file);
    return resolved !== undefined && isRecord(resolved.node) && resolved.node.writeOnly === true;
  }

  /** 3.0 固有のキーワード(nullable / exclusiveMinimum・exclusiveMaximum の真偽値)を 2020-12 に変換する */
  private applyOas30(node: Json, out: Json): void {
    if (node.nullable === true && out.type !== undefined) {
      const types = Array.isArray(out.type) ? [...out.type] : [out.type];
      if (!types.includes("null")) types.push("null");
      out.type = types;
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    }
    if (node.exclusiveMinimum === true && typeof node.minimum === "number") {
      out.exclusiveMinimum = node.minimum;
      delete out.minimum;
    }
    if (node.exclusiveMaximum === true && typeof node.maximum === "number") {
      out.exclusiveMaximum = node.maximum;
      delete out.maximum;
    }
  }
}

// ---------------------------------------------------------------------------
// オペレーションの照合
// ---------------------------------------------------------------------------

/** サーバー URL を接頭辞として照合するためのパターン */
interface ServerPattern {
  /** サーバー URL のオリジン部(相対 URL のサーバーには無い) */
  origin?: RegExp;
  /** サーバー URL のパス部(末尾の / は除く)。リクエストのパスの先頭に一致させる */
  path: RegExp;
}

/** 正規化したリクエスト先(origin が無いのは、URL の先頭が未解決の変数のとき) */
interface RequestTarget {
  origin?: string;
  path: string;
}

function normalizeOrigin(origin: string): string {
  return origin
    .toLowerCase()
    .replace(/^(https:\/\/[^/]*?):443$/, "$1")
    .replace(/^(http:\/\/[^/]*?):80$/, "$1");
}

/** リクエスト URL を、照合に使う「オリジン + パス」に分ける(クエリ・フラグメント・ユーザー情報は除く) */
function parseRequestTarget(url: string): RequestTarget {
  const full = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(url);
  if (full !== null) {
    const authority = (full[2] as string).replace(/^.*@/, "");
    const path = (full[3] as string) || "/";
    // ホストに未解決のテンプレート変数が残っている場合は、オリジンを判定せずパスだけで照合する
    if (authority.includes("{{")) return { path };
    return { origin: normalizeOrigin(`${(full[1] as string).toLowerCase()}://${authority}`), path };
  }
  const relative = /^(?:\{\{[^}]*\}\})?([^?#]*)/.exec(url);
  const path = relative?.[1] ?? "";
  return { path: path === "" ? "/" : path.startsWith("/") ? path : `/${path}` };
}

function templateRegex(text: string, variable: (name: string) => string): string {
  return text
    .split(/(\{[^{}]+\})/)
    .map((part) =>
      part.startsWith("{") && part.endsWith("}") ? variable(part.slice(1, -1)) : escapeRegExp(part),
    )
    .join("");
}

function buildServerPattern(server: unknown): ServerPattern | undefined {
  if (!isRecord(server) || typeof server.url !== "string") return undefined;
  const variables = isRecord(server.variables) ? server.variables : {};
  const variable = (name: string): string => {
    const def = hasOwn(variables, name) ? variables[name] : undefined;
    const allowed =
      isRecord(def) && Array.isArray(def.enum)
        ? def.enum.filter((value): value is string => typeof value === "string")
        : [];
    if (allowed.length > 0) return `(?:${allowed.map(escapeRegExp).join("|")})`;
    const fallback = isRecord(def) && typeof def.default === "string" ? def.default : "";
    return fallback.includes("/") ? ".+?" : "[^/?#]+";
  };
  let originText: string | undefined;
  let pathText: string;
  if (server.url.startsWith("/")) {
    pathText = server.url;
  } else {
    const split = /^([^/]*:\/\/[^/]*)(.*)$/.exec(server.url);
    if (split === null) {
      pathText = `/${server.url}`;
    } else {
      originText = normalizeOrigin(split[1] as string);
      pathText = split[2] as string;
    }
  }
  const trimmed = pathText.replace(/\/+$/, "");
  return {
    ...(originText !== undefined
      ? { origin: new RegExp(`^${templateRegex(originText, variable)}$`, "i") }
      : {}),
    path: new RegExp(`^${templateRegex(trimmed, variable)}(?=/|$)`, "i"),
  };
}

/** パスのセグメント(末尾の / は無視する) */
function splitSegments(path: string): string[] {
  const segments = path
    .split("/")
    .filter((segment, index, all) => !(index === all.length - 1 && segment === ""));
  return segments[0] === "" ? segments.slice(1) : segments;
}

/** セグメントごとの具体性(0: 固定文字のみ / 1: 固定文字と変数の混在 / 2: 変数のみ) */
function segmentRank(segment: string): number {
  if (!segment.includes("{")) return 0;
  return /^\{[^{}]+\}$/.test(segment) ? 2 : 1;
}

function compareTemplates(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const diff = segmentRank(a[i] as string) - segmentRank(b[i] as string);
    if (diff !== 0) return diff;
  }
  return a.join("/").localeCompare(b.join("/"));
}

interface SegmentMatcher {
  test(segment: string): boolean;
}

function buildSegmentMatcher(templateSegment: string): SegmentMatcher {
  if (!templateSegment.includes("{")) {
    return { test: (segment) => safeDecode(segment) === templateSegment };
  }
  const regex = new RegExp(`^${templateRegex(templateSegment, () => "[^/]+")}$`);
  return { test: (segment) => regex.test(safeDecode(segment)) };
}

/** 仕様の 1 オペレーション */
export interface OpenApiOperation {
  /** `GET /users/{id}` */
  id: string;
  method: string;
  path: string;
  document: string;
  /** 仕様に書かれた応答のキー(大文字。`200` / `2XX` / `DEFAULT`) */
  documented: string[];
}

interface OperationEntry extends OpenApiOperation {
  segments: string[];
  matchers: SegmentMatcher[];
  servers: ServerPattern[];
  responses: Map<string, { node: unknown; file: string }>;
  /** 応答キー + メディアタイプごとのコンパイル済み validator(コンパイルできなければ Error) */
  validators: Map<string, Ajv2020Validate | Error>;
  owner: OpenApiDocument;
  file: string;
}

type Ajv2020Validate = ReturnType<Ajv2020["compile"]>;

/** 応答の検証に渡す入力 */
export interface OpenApiResponseInput {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
}

interface CheckOutcome {
  state: OpenApiState;
  violations: OpenApiViolation[];
  /** violations に載せずに切り捨てた違反の数(大量の違反で、メモリを使い切らないため) */
  omitted?: number;
  /** skipped のときの理由 */
  note?: string;
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function mediaTypeOf(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

function isJsonMediaType(mediaType: string): boolean {
  return /^[^/]+\/(?:.+\+)?json$/.test(mediaType);
}

/** 宣言されたメディアタイプのうち、実際の応答に一致するもの(完全一致 → type/* → *\/*) */
function matchDeclaredMediaType(declared: string[], actual: string): string | undefined {
  const normalized = declared.map((key) => ({ key, media: mediaTypeOf(key) }));
  const exact = normalized.find((entry) => entry.media === actual);
  if (exact) return exact.key;
  const type = actual.split("/")[0];
  const wildcard = normalized.find((entry) => entry.media === `${type}/*`);
  if (wildcard) return wildcard.key;
  return normalized.find((entry) => entry.media === "*/*")?.key;
}

function formatAjvViolation(error: {
  instancePath: string;
  keyword: string;
  message?: string;
  params: Record<string, unknown>;
}): OpenApiViolation {
  let message = error.message ?? "is invalid";
  if (error.keyword === "required") {
    message = `must have required property '${String(error.params.missingProperty)}'`;
  } else if (error.keyword === "additionalProperties") {
    message = `must NOT have additional property '${String(error.params.additionalProperty)}'`;
  } else if (error.keyword === "enum" && Array.isArray(error.params.allowedValues)) {
    const values = JSON.stringify(error.params.allowedValues.slice(0, 10));
    message = `must be equal to one of the allowed values ${values}`;
  }
  return { location: "body", path: error.instancePath, message };
}

/** 1 つの OpenAPI 文書 */
export class OpenApiDocument {
  readonly file: string;
  readonly title: string | undefined;
  readonly version: string | undefined;
  readonly operations: OperationEntry[] = [];
  private readonly byMethod = new Map<string, OperationEntry[]>();
  private readonly ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
    allowUnionTypes: true,
    logger: false,
  });

  private constructor(
    file: string,
    private readonly specs: SpecFiles,
    private readonly oas30: boolean,
    private readonly warn: (message: string) => void,
    info: { title?: string; version?: string },
  ) {
    this.file = file;
    this.title = info.title;
    this.version = info.version;
  }

  static async load(
    path: string,
    options: { cwd: string; baseUrls: string[]; warn: (message: string) => void },
  ): Promise<OpenApiDocument> {
    const specs = await SpecFiles.load(path, options.cwd);
    const root = specs.files.get(specs.rootPath);
    const shown = toDisplayPath(options.cwd, specs.rootPath);
    if (!isRecord(root))
      throw new ParseError("not an OpenAPI document (expected a mapping)", shown);
    if (typeof root.swagger === "string") {
      throw new ParseError(
        "Swagger 2.0 documents are not supported (use OpenAPI 3.0 or 3.1)",
        shown,
      );
    }
    const version = typeof root.openapi === "string" ? /^3\.([01])\.\d+/.exec(root.openapi) : null;
    if (version === null) {
      throw new ParseError(
        'not an OpenAPI 3.0 / 3.1 document (the "openapi" field must be "3.0.x" or "3.1.x")',
        shown,
      );
    }
    if (!isRecord(root.paths) && !isRecord(root.webhooks)) {
      throw new ParseError('the "paths" field is missing', shown);
    }
    const info = isRecord(root.info) ? root.info : {};
    const document = new OpenApiDocument(shown, specs, version[1] === "0", options.warn, {
      ...(typeof info.title === "string" ? { title: info.title } : {}),
      ...(typeof info.version === "string" ? { version: info.version } : {}),
    });
    document.index(root, options.baseUrls);
    return document;
  }

  private index(root: Json, baseUrls: string[]): void {
    const docServers =
      Array.isArray(root.servers) && root.servers.length > 0 ? root.servers : [{ url: "/" }];
    const toPatterns = (servers: unknown[]): ServerPattern[] => [
      ...baseUrls.flatMap((url) => buildServerPattern({ url }) ?? []),
      ...servers.flatMap((server) => buildServerPattern(server) ?? []),
    ];
    const paths = isRecord(root.paths) ? root.paths : {};
    for (const [pathTemplate, rawItem] of Object.entries(paths)) {
      if (!pathTemplate.startsWith("/")) continue;
      const item = this.specs.deref(rawItem, this.specs.rootPath);
      if (item === undefined || !isRecord(item.node)) continue;
      for (const method of HTTP_METHODS) {
        const operation = item.node[method];
        if (!isRecord(operation)) continue;
        if (this.operations.length >= MAX_OPERATIONS) {
          throw new ParseError(`too many operations (max ${MAX_OPERATIONS})`, this.file);
        }
        const ownServers =
          Array.isArray(operation.servers) && operation.servers.length > 0
            ? operation.servers
            : Array.isArray(item.node.servers) && item.node.servers.length > 0
              ? item.node.servers
              : docServers;
        const responses = new Map<string, { node: unknown; file: string }>();
        if (isRecord(operation.responses)) {
          for (const [key, node] of Object.entries(operation.responses)) {
            if (key.startsWith("x-")) continue;
            responses.set(key.toUpperCase(), { node, file: item.file });
          }
        }
        const segments = splitSegments(pathTemplate);
        const entry: OperationEntry = {
          id: `${method.toUpperCase()} ${pathTemplate}`,
          method: method.toUpperCase(),
          path: pathTemplate,
          document: this.file,
          documented: [...responses.keys()],
          segments,
          matchers: segments.map(buildSegmentMatcher),
          servers: toPatterns(ownServers),
          responses,
          validators: new Map(),
          owner: this,
          file: item.file,
        };
        this.operations.push(entry);
        const list = this.byMethod.get(entry.method) ?? [];
        list.push(entry);
        this.byMethod.set(entry.method, list);
      }
    }
    for (const list of this.byMethod.values()) {
      list.sort((a, b) => compareTemplates(a.segments, b.segments));
    }
    if (this.operations.length === 0) {
      this.warn(`${this.file}: the document has no operations`);
    }
  }

  /** メソッドとリクエスト先に一致するオペレーション(具体的なパスを優先)。無ければ undefined */
  match(method: string, target: RequestTarget): OperationEntry | undefined {
    const candidates = this.byMethod.get(method.toUpperCase());
    if (candidates === undefined) return undefined;
    for (const operation of candidates) {
      for (const server of operation.servers) {
        if (
          server.origin !== undefined &&
          target.origin !== undefined &&
          !server.origin.test(target.origin)
        ) {
          continue;
        }
        const prefix = server.path.exec(target.path);
        if (prefix === null) continue;
        const remainder = target.path.slice(prefix[0].length) || "/";
        const segments = splitSegments(remainder);
        if (segments.length !== operation.matchers.length) continue;
        if (operation.matchers.every((matcher, index) => matcher.test(segments[index] as string))) {
          return operation;
        }
      }
    }
    return undefined;
  }

  private findResponse(
    operation: OperationEntry,
    status: number,
  ): { key: string; node: unknown; file: string } | undefined {
    for (const key of [String(status), `${Math.floor(status / 100)}XX`, "DEFAULT"]) {
      const found = operation.responses.get(key);
      if (found !== undefined) return { key, ...found };
    }
    return undefined;
  }

  /** 応答を、オペレーションに書かれた応答の定義と照らす */
  checkResponse(operation: OperationEntry, input: OpenApiResponseInput): CheckOutcome {
    const found = this.findResponse(operation, input.status);
    if (found === undefined) return { state: "undocumented", violations: [] };
    const resolved = this.specs.deref(found.node, found.file);
    if (resolved === undefined || !isRecord(resolved.node)) {
      return {
        state: "skipped",
        violations: [],
        note: `the ${found.key} response definition cannot be read`,
      };
    }
    const response = resolved.node;
    const violations: OpenApiViolation[] = [];
    let omitted = 0;

    // 必須の応答ヘッダー(値のスキーマは検証しない)
    if (isRecord(response.headers)) {
      for (const [name, rawHeader] of Object.entries(response.headers)) {
        if (name.toLowerCase() === "content-type") continue;
        const header = this.specs.deref(rawHeader, resolved.file);
        if (header === undefined || !isRecord(header.node) || header.node.required !== true)
          continue;
        if (findHeader(input.headers, name) === undefined) {
          violations.push({
            location: "header",
            path: name,
            message: `required response header "${name}" is missing`,
          });
        }
      }
    }

    // ボディ(宣言された content があり、本文が空でないときだけ)
    let note: string | undefined;
    const content = isRecord(response.content) ? response.content : undefined;
    const declared = content !== undefined ? Object.keys(content) : [];
    if (declared.length > 0 && input.bodyText !== "" && operation.method !== "HEAD") {
      const contentType = findHeader(input.headers, "content-type");
      if (contentType === undefined) {
        violations.push({
          location: "content-type",
          message: "the response has a body but no content-type header",
        });
      } else {
        const actual = mediaTypeOf(contentType);
        const key = matchDeclaredMediaType(declared, actual);
        if (key === undefined) {
          violations.push({
            location: "content-type",
            message: `content-type "${actual}" is not declared (declared: ${declared.slice(0, 10).join(", ")})`,
          });
        } else if (isJsonMediaType(actual)) {
          const outcome = this.checkBody(
            operation,
            found,
            resolved.file,
            content as Json,
            key,
            input,
          );
          violations.push(...outcome.violations);
          omitted += outcome.omitted ?? 0;
          note = outcome.note;
        }
      }
    }
    if (violations.length > 0) return { state: "invalid", violations, omitted };
    if (note !== undefined) return { state: "skipped", violations: [], note };
    return { state: "valid", violations: [] };
  }

  private checkBody(
    operation: OperationEntry,
    found: { key: string },
    file: string,
    content: Json,
    mediaKey: string,
    input: OpenApiResponseInput,
  ): { violations: OpenApiViolation[]; omitted?: number; note?: string } {
    const media = this.specs.deref(content[mediaKey], file);
    if (media === undefined || !isRecord(media.node) || media.node.schema === undefined) {
      return { violations: [] };
    }
    let value: unknown = input.body;
    if (typeof value === "string") {
      try {
        value = JSON.parse(input.bodyText);
      } catch {
        return {
          violations: [{ location: "body", path: "", message: "the body is not valid JSON" }],
        };
      }
    }
    const cacheKey = `${found.key}\u0000${mediaKey}`;
    let validator = operation.validators.get(cacheKey);
    if (validator === undefined) {
      try {
        const schema = new SchemaBuilder(this.specs, this.oas30, this.warn).build(
          media.node.schema,
          media.file,
        );
        validator = this.ajv.compile(schema);
      } catch (error) {
        validator = new Error(errorText(error));
        this.warn(
          `${operation.id}: the response schema cannot be compiled and is not validated: ${errorText(error)}`,
        );
      }
      operation.validators.set(cacheKey, validator);
    }
    if (validator instanceof Error) {
      return {
        violations: [],
        note: `the response schema cannot be compiled (${validator.message})`,
      };
    }
    if (validator(value)) return { violations: [] };
    // 違反は先頭の上限件数だけを整形する(総数は omitted で伝える)
    const errors = validator.errors ?? [];
    return {
      violations: errors.slice(0, MAX_OPENAPI_VIOLATIONS).map(formatAjvViolation),
      omitted: Math.max(0, errors.length - MAX_OPENAPI_VIOLATIONS),
    };
  }
}

// ---------------------------------------------------------------------------
// 実行全体の検証とカバレッジ
// ---------------------------------------------------------------------------

export interface OpenApiLoadOptions {
  /** 相対パスの基準(既定は process.cwd()) */
  cwd?: string;
  /** --openapi-base-url。仕様の servers に加えて、リクエスト URL の接頭辞として扱う */
  baseUrl?: string | undefined;
  /** --openapi-strict: 照合できないリクエスト・仕様にない応答・検証できない応答を失敗にする */
  strict?: boolean;
}

export interface OpenApiCheckInput {
  flow: string;
  step: string;
  method: string;
  url: string;
  response: OpenApiResponseInput;
}

/**
 * 実行全体で共有する OpenAPI の検証器。1 回の実行(--jobs による並列実行を含む)で 1 つ作る。
 * 検証はすべて同期的に行い、状態はステップの完了順に依らない形(Map / Set)で集める。
 */
export class OpenApiValidator {
  readonly documents: OpenApiDocument[];
  private readonly strict: boolean;
  private readonly hits = new Map<OperationEntry, Set<number>>();
  private readonly planned = new Set<OperationEntry>();
  private readonly unmatched = new Map<string, { method: string; url: string; count: number }>();
  private readonly excluded = new Map<
    string,
    { flow: string; step: string; reason: "sse" | "websocket" | "redirected" }
  >();
  private violationCount = 0;

  private constructor(
    documents: OpenApiDocument[],
    strict: boolean,
    private readonly warningSet: Set<string>,
  ) {
    this.documents = documents;
    this.strict = strict;
  }

  static async load(paths: string[], options: OpenApiLoadOptions = {}): Promise<OpenApiValidator> {
    const cwd = options.cwd ?? process.cwd();
    const warnings = new Set<string>();
    const warn = (message: string): void => {
      if (warnings.size < MAX_WARNINGS) warnings.add(`OpenAPI: ${message}`);
    };
    const documents: OpenApiDocument[] = [];
    for (const path of paths) {
      documents.push(
        await OpenApiDocument.load(path, {
          cwd,
          baseUrls: options.baseUrl !== undefined ? [options.baseUrl] : [],
          warn,
        }),
      );
    }
    return new OpenApiValidator(documents, options.strict === true, warnings);
  }

  /** 読み込み時と検証中(遅延コンパイルなど)に出た警告の一覧(重複を除く) */
  get warnings(): string[] {
    return [...this.warningSet];
  }

  private match(method: string, url: string): OperationEntry | undefined {
    const target = parseRequestTarget(url);
    for (const document of this.documents) {
      const found = document.match(method, target);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  private recordUnmatched(method: string, url: string): void {
    const target = parseRequestTarget(url);
    const shown = `${target.origin ?? ""}${target.path}`;
    const key = `${method.toUpperCase()} ${shown}`;
    const existing = this.unmatched.get(key);
    if (existing !== undefined) existing.count += 1;
    else if (this.unmatched.size < MAX_SUMMARY_ROWS * 2) {
      this.unmatched.set(key, { method: method.toUpperCase(), url: shown, count: 1 });
    }
  }

  /** SSE / WebSocket / リダイレクトを追ったステップを、検証の対象外として記録する */
  exclude(flow: string, step: string, reason: "sse" | "websocket" | "redirected"): void {
    const key = `${flow}\u0000${step}\u0000${reason}`;
    if (!this.excluded.has(key) && this.excluded.size < MAX_SUMMARY_ROWS * 2) {
      this.excluded.set(key, { flow, step, reason });
    }
  }

  /** --dry-run: 送らずに、リクエストが照合できるオペレーションを「計画済み」として記録する */
  plan(method: string, url: string): void {
    const found = this.match(method, url);
    if (found !== undefined) this.planned.add(found);
    else this.recordUnmatched(method, url);
  }

  /** 応答を検証し、アサーション結果を返す(照合できず strict でもなければ空) */
  check(input: OpenApiCheckInput): AssertionResult[] {
    const found = this.match(input.method, input.url);
    if (found === undefined) {
      this.recordUnmatched(input.method, input.url);
      if (!this.strict) return [];
      return [
        this.assertion(
          false,
          `OpenAPI: no operation matches ${input.method.toUpperCase()} ${this.shownUrl(input.url)} (--openapi-strict)`,
          {
            state: "unmatched",
          },
        ),
      ];
    }
    const statuses = this.hits.get(found) ?? new Set<number>();
    statuses.add(input.response.status);
    this.hits.set(found, statuses);

    const outcome = found.owner.checkResponse(found, input.response);
    const base = { operation: found.id, document: found.document, status: input.response.status };
    const label = `${found.id} -> ${input.response.status}`;
    switch (outcome.state) {
      case "valid":
        return [
          this.assertion(true, `OpenAPI: ${label} matches the specification`, {
            state: "valid",
            ...base,
          }),
        ];
      case "undocumented":
        return [
          this.assertion(
            !this.strict,
            `OpenAPI: status ${input.response.status} is not documented for ${found.id}${this.strict ? " (--openapi-strict)" : " (not validated)"}`,
            { state: "undocumented", ...base },
          ),
        ];
      case "skipped":
        return [
          this.assertion(
            !this.strict,
            `OpenAPI: ${label} was not validated: ${outcome.note ?? "unsupported"}`,
            {
              state: "skipped",
              ...base,
            },
          ),
        ];
      default: {
        this.violationCount += 1;
        const total = outcome.violations.length + (outcome.omitted ?? 0);
        const head = outcome.violations
          .slice(0, MESSAGE_VIOLATIONS)
          .map((violation) => this.describeViolation(violation))
          .join("; ");
        const more = total > MESSAGE_VIOLATIONS ? ` (+${total - MESSAGE_VIOLATIONS} more)` : "";
        return [
          this.assertion(false, `OpenAPI: ${label} violates the specification: ${head}${more}`, {
            state: "invalid",
            ...base,
            violations: outcome.violations.slice(0, MAX_OPENAPI_VIOLATIONS),
            violationCount: total,
          }),
        ];
      }
    }
  }

  private shownUrl(url: string): string {
    const target = parseRequestTarget(url);
    return `${target.origin ?? ""}${target.path}`;
  }

  private describeViolation(violation: OpenApiViolation): string {
    if (violation.location === "body") {
      return `body ${violation.path === "" ? "(root)" : violation.path}: ${violation.message}`;
    }
    return violation.location === "header"
      ? violation.message
      : `${violation.location}: ${violation.message}`;
  }

  private assertion(ok: boolean, message: string, detail: OpenApiAssertionDetail): AssertionResult {
    return { ok, kind: "openapi", message, openapi: detail };
  }

  /** 実行全体のカバレッジの集計。partial は一部のフローだけを実行したとき、planned は --dry-run のとき */
  summarize(options: {
    partial: boolean;
    planned: boolean;
    coverageMin?: number | undefined;
  }): OpenApiRunSummary {
    const all = this.documents.flatMap((document) => document.operations);
    const covered: OpenApiRunSummary["covered"] = [];
    const uncovered: OpenApiRunSummary["uncovered"] = [];
    for (const operation of all) {
      const statuses = this.hits.get(operation);
      if (statuses !== undefined) {
        covered.push({
          operation: operation.id,
          document: operation.document,
          statuses: [...statuses].sort((a, b) => a - b),
          documented: operation.documented,
        });
      } else if (this.planned.has(operation)) {
        covered.push({
          operation: operation.id,
          document: operation.document,
          statuses: [],
          documented: operation.documented,
        });
      } else {
        uncovered.push({ operation: operation.id, document: operation.document });
      }
    }
    const percent = all.length === 0 ? 100 : Math.round((covered.length / all.length) * 1000) / 10;
    const unmatched = [...this.unmatched.values()].sort(
      (a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method),
    );
    const excluded = [...this.excluded.values()].sort(
      (a, b) =>
        a.flow.localeCompare(b.flow) ||
        a.step.localeCompare(b.step) ||
        a.reason.localeCompare(b.reason),
    );
    const truncated =
      covered.length > MAX_SUMMARY_ROWS ||
      uncovered.length > MAX_SUMMARY_ROWS ||
      unmatched.length > MAX_SUMMARY_ROWS ||
      excluded.length > MAX_SUMMARY_ROWS;
    return {
      documents: this.documents.map((document) => ({
        file: document.file,
        ...(document.title !== undefined ? { title: document.title } : {}),
        ...(document.version !== undefined ? { version: document.version } : {}),
        operations: document.operations.length,
      })),
      operations: { total: all.length, covered: covered.length, percent },
      covered: covered.slice(0, MAX_SUMMARY_ROWS),
      uncovered: uncovered.slice(0, MAX_SUMMARY_ROWS),
      unmatched: unmatched.slice(0, MAX_SUMMARY_ROWS),
      excluded: excluded.slice(0, MAX_SUMMARY_ROWS),
      violations: this.violationCount,
      partial: options.partial,
      planned: options.planned,
      ...(options.coverageMin !== undefined
        ? { coverageMin: { percent: options.coverageMin, met: percent >= options.coverageMin } }
        : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }
}
