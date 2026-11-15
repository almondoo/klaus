/**
 * 実行履歴の run を、再実行可能なフロー定義(YAML 用のオブジェクト)に昇格させる core ロジック(klaus promote の本体)。
 * 履歴エントリ(マスク済み)だけを入力に取る純粋関数群で、ファイル I/O は行わない。
 *
 * 推論規則(決定的・単純):
 * - リクエスト: 記録された method / URL / headers / body をそのまま再構成する。ホップバイホップ・計算ヘッダーは落とす。
 *   マスク値("***")は再現できないため {{env.TODO_*}} に置き換え、置き換え箇所を一覧で返す。
 * - アサーション: 観測したレスポンスから推論する(assert モードで強さを選べる)。
 *   status は観測値と一致、content-type は contains、JSON body は bodySchema(型と必須キーのみ。enum/const は使わない)
 *   と、安定していそうなスカラーの body equals のみ。
 * - チェイン: 先行ステップの JSON レスポンスのスカラー値が後続リクエストに完全一致で再登場したら capture と {{name}} に置き換える。
 */
import { stringify as stringifyYaml } from "yaml";
import type { HistoryEntry } from "./history.js";
import { resolveHistoryEntryStatus } from "./history-query.js";
import { exceedsDepth, formatJsonPath } from "./json-diff.js";

export type PromoteAssertMode = "status" | "schema" | "values" | "all";

export interface PromoteOptions {
  /** status: status のみ / schema: status + bodySchema + content-type / values: status + 安定スカラーの equals + content-type / all: すべて */
  assert: PromoteAssertMode;
  /** 指定時、URL の origin を {{name}} に置き換える(2つ目以降の origin は name_2, name_3 ...) */
  baseUrlVar?: string | undefined;
  /** false でチェイン推論を行わない */
  chain: boolean;
  /** 生成するフローの name。省略時は記録されたフロー名、無ければ host から決める */
  name?: string | undefined;
  /** run が複数フローを含む場合に対象を絞る */
  flow?: string | undefined;
  /**
   * 記録されたリクエスト値に含まれるリテラルの "{{" をそのまま出力することを許可する。既定(false)ではその場合に生成を拒否する
   * (klaus には "{{" のエスケープ構文が無く、生成したフローの実行時にテンプレートとして展開され、
   * OS 環境変数({{env.X}})が送信先へ漏れ得るため)
   */
  allowTemplateLiterals?: boolean | undefined;
}

export interface PromoteRunInput {
  runId: string;
  entries: readonly HistoryEntry[];
}

export interface PromotedStepInfo {
  name: string;
  method: string;
  /** 生成した YAML に書かれる URL(テンプレート置換後) */
  url: string;
  from: { runId: string; flow: string; step: string };
}

export interface PromotePlaceholder {
  /** OS 環境変数名({{env.<name>}} で参照される) */
  name: string;
  locations: string[];
}

export interface PromoteCaptureLink {
  name: string;
  from: { step: string; path: string };
  used: { step: string; location: string }[];
}

/** 秘密情報らしい値のためリテラルではなくプレースホルダーに置き換えた箇所 */
export interface PromoteRedaction {
  name: string;
  location: string;
  reason: "sensitive key" | "token-like value";
}

export interface PromoteSkipped {
  runId: string;
  flow: string;
  step: string;
  reason: string;
}

export interface PromotedFlow {
  name: string;
  steps: Record<string, unknown>[];
}

export interface PromoteResult {
  flowName: string;
  /** 既定の出力先(cwd 相対、POSIX 区切り)。1 ステップなら api/、複数ステップなら flows/ */
  suggestedPath: string;
  flow: PromotedFlow;
  steps: PromotedStepInfo[];
  placeholders: PromotePlaceholder[];
  captures: PromoteCaptureLink[];
  /** --base-url-var で置き換えた origin。環境ファイルに書くべき値 */
  baseUrls: { name: string; value: string }[];
  skipped: PromoteSkipped[];
  notes: string[];
  assert: PromoteAssertMode;
  /** 秘密情報らしい値を置き換えた箇所(対応するプレースホルダーは placeholders にも含まれる) */
  redacted: PromoteRedaction[];
  /** --allow-template-literals で出力した、リテラルの "{{" を含む箇所(既定では生成を拒否するため空) */
  templateLiterals: { step: string; location: string }[];
  /** 記録した通信から生成したファイルのため、コミット前に機微情報を確認すべきという注意 */
  notice: string;
}

/**
 * 失敗の種別。usage: 引数の誤り(実行 ID の不明・flow 指定の不足など。CLI は exit 1)/
 * content: 履歴の内容に起因する拒否(生成できるステップが無い・テンプレートのリテラル等。CLI は exit 2)
 */
export type PromoteOutcome =
  | { ok: true; result: PromoteResult }
  | { ok: false; message: string; kind: "usage" | "content" };

export const PROMOTE_NOTICE =
  "Generated from recorded traffic: review this file for sensitive data (tokens, passwords, personal data) before committing it.";

/** 単発リクエストの flow 名(runner.ts の executeSingleRequest が履歴に書く値) */
const SINGLE_FLOW_NAME = "(single)";

export const FLOW_SCHEMA_COMMENT =
  "# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json";

/** 再現できない(送信時に計算される・接続ごとに決まる)ためフローに書かないリクエストヘッダー(小文字) */
const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "content-length",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-connection",
]);

const MASK = "***";
const MAX_SCHEMA_ARRAY_ITEMS = 100;
const MAX_SCHEMA_DEPTH = 10;
const MAX_VALUE_ASSERTIONS = 20;
const MAX_VALUE_ARRAY_INDEX = 5;
const MAX_STABLE_INTEGER = 1000;
/** 値の走査(equals・キャプチャ候補)の最大の深さ。これより深い値は対象にしない */
const MAX_SCAN_DEPTH = 32;
/** リクエスト body の入れ子の上限。超えるとフロー化を拒否する(再帰的な変換・JSON 化でスタックを溢れさせないため) */
const MAX_REQUEST_BODY_DEPTH = 100;

// ---------------------------------------------------------------------------
// bodySchema 推論
// ---------------------------------------------------------------------------

type Schema = Record<string, unknown>;

function sameSchema(a: Schema, b: Schema): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function alternativesOf(schema: Schema): Schema[] {
  return Array.isArray(schema.anyOf) ? (schema.anyOf as Schema[]) : [schema];
}

/** 同種(object 同士・array 同士)で併合できるか */
function isMergeable(a: Schema, b: Schema): boolean {
  return a.type === b.type && (a.type === "object" || a.type === "array");
}

function mergeSameKind(a: Schema, b: Schema): Schema {
  if (a.type === "object") {
    const left = (a.properties ?? {}) as Record<string, Schema>;
    const right = (b.properties ?? {}) as Record<string, Schema>;
    const properties: Record<string, Schema> = {};
    for (const key of Object.keys(left)) {
      const other = right[key];
      properties[key] = other ? mergeSchemas(left[key] as Schema, other) : (left[key] as Schema);
    }
    for (const key of Object.keys(right)) {
      if (!(key in properties)) properties[key] = right[key] as Schema;
    }
    const rightRequired = new Set((b.required ?? []) as string[]);
    const required = ((a.required ?? []) as string[]).filter((key) => rightRequired.has(key));
    return {
      type: "object",
      ...(Object.keys(properties).length > 0 ? { properties } : {}),
      ...(required.length > 0 ? { required } : {}),
    };
  }
  const items =
    a.items && b.items
      ? mergeSchemas(a.items as Schema, b.items as Schema)
      : ((a.items ?? b.items) as Schema | undefined);
  return { type: "array", ...(items ? { items } : {}) };
}

/** 2つのスキーマを、どちらの値も通る1つのスキーマに併合する(配列要素の型を揃えるために使う) */
function mergeSchemas(a: Schema, b: Schema): Schema {
  if (sameSchema(a, b)) return a;
  const alternatives: Schema[] = [];
  for (const candidate of [...alternativesOf(a), ...alternativesOf(b)]) {
    const index = alternatives.findIndex(
      (existing) => sameSchema(existing, candidate) || isMergeable(existing, candidate),
    );
    if (index < 0) {
      alternatives.push(candidate);
    } else if (!sameSchema(alternatives[index] as Schema, candidate)) {
      alternatives[index] = mergeSameKind(alternatives[index] as Schema, candidate);
    }
  }
  return alternatives.length === 1 ? (alternatives[0] as Schema) : { anyOf: alternatives };
}

/**
 * 観測した JSON 値から JSON Schema を推論する。型と必須キー(観測できたキーすべて)のみで、
 * enum / const / format / 長さ・範囲の制約は付けない。数値は整数・小数を区別せず number とする
 * (JSON では 10 と 10.0 を区別できず、小数の有無で再実行時に落ちるのを避けるため)。
 * additionalProperties は制限しない(追加フィールドで落ちない)。配列は先頭 100 要素を併合した items で型付けする。
 */
export function inferJsonSchema(value: unknown, depth = 0): Schema {
  if (value === null) return { type: "null" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "string") return { type: "string" };
  if (depth >= MAX_SCHEMA_DEPTH) return {};
  if (Array.isArray(value)) {
    let items: Schema | undefined;
    for (const item of value.slice(0, MAX_SCHEMA_ARRAY_ITEMS)) {
      const inferred = inferJsonSchema(item, depth + 1);
      items = items ? mergeSchemas(items, inferred) : inferred;
    }
    return { type: "array", ...(items ? { items } : {}) };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return { type: "object" };
    const properties: Record<string, Schema> = {};
    for (const [key, child] of entries) properties[key] = inferJsonSchema(child, depth + 1);
    return { type: "object", properties, required: entries.map(([key]) => key) };
  }
  return {};
}

// ---------------------------------------------------------------------------
// 安定スカラーの検出
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUM_LIKE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const DATE_LIKE_PATTERN = /\d{4}-\d{2}-\d{2}/;
/** 値が秘密情報であることを示すキー名(リクエスト・レスポンス双方で使う。大文字小文字は無視) */
const SENSITIVE_KEY_PATTERN =
  /token|secret|passw(?:or)?d|pwd|credential|signature|cookie|bearer|session|key|auth(?!or(?!iz))/i;
/** 値が秘密情報ではないが揮発しやすいキー名 */
const VOLATILE_KEY_PATTERN = /uuid|guid|nonce|hash|etag|timestamp|expires|created|updated/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** キー名が揮発しそうな値(id・時刻・秘密情報等)を示すか */
function isVolatileKey(key: string): boolean {
  return (
    key === "id" ||
    key.endsWith("_id") ||
    /[a-z]Id$/.test(key) ||
    key.endsWith("_at") ||
    /[a-z]At$/.test(key) ||
    VOLATILE_KEY_PATTERN.test(key) ||
    isSensitiveKey(key)
  );
}

const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const SECRET_PREFIX_PATTERN =
  /^(?:(?:sk|pk|rk)_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})$/;

/** 1 文字あたりのシャノンエントロピー(ビット) */
function entropyPerChar(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** 秘密情報(トークン・API キー)らしい文字列か: JWT、既知のキー接頭辞、または長く高エントロピーな英数字列(UUID は除く) */
function looksLikeSecret(value: string): boolean {
  if (value.length < 12 || value.includes(MASK) || value.includes("{{")) return false;
  if (JWT_PATTERN.test(value) || SECRET_PREFIX_PATTERN.test(value)) return true;
  if (value.length < 32 || UUID_PATTERN.test(value)) return false;
  if (!/^[A-Za-z0-9+/_=.-]+$/.test(value) || !/\d/.test(value) || !/[A-Za-z]/.test(value)) {
    return false;
  }
  return entropyPerChar(value) >= 3.5;
}

/** 値の見た目が揮発しそうな文字列か(UUID・日時・長い数値・16進・長い英数字・マスク値・JWT・秘密情報らしい文字列) */
function looksVolatileString(value: string): boolean {
  return (
    value.includes(MASK) ||
    UUID_PATTERN.test(value) ||
    DATE_LIKE_PATTERN.test(value) ||
    /^\d{8,}$/.test(value) ||
    /^[0-9a-f]{16,}$/i.test(value) ||
    /^[A-Za-z0-9+/_=-]{20,}$/.test(value) ||
    value.startsWith("eyJ") ||
    looksLikeSecret(value)
  );
}

/** equals で固定してよい(安定していそうな)スカラーか: 真偽値・小さな整数・短い enum 風の文字列 */
function isStableScalar(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") {
    return Number.isInteger(value) && Math.abs(value) <= MAX_STABLE_INTEGER;
  }
  if (typeof value === "string") {
    if (!ENUM_LIKE_PATTERN.test(value) || looksVolatileString(value)) return false;
    return (value.match(/\d/g)?.length ?? 0) <= 3;
  }
  return false;
}

/**
 * JSON body から、equals で固定する安定スカラーを JSONPath 付きで列挙する(最大 MAX_VALUE_ASSERTIONS 件)。
 * 秘密情報を示すキー(祖先のどれかが該当する場合を含む)の下の値は、型を問わず対象外。
 * 深さ MAX_SCAN_DEPTH を超える値も対象外(再帰の深さを抑える)。
 */
export function collectStableValues(body: unknown): { path: string; equals: unknown }[] {
  const found: { path: string; equals: unknown }[] = [];
  const visit = (
    value: unknown,
    segments: (string | number)[],
    key: string | undefined,
    sensitive: boolean,
  ): void => {
    if (found.length >= MAX_VALUE_ASSERTIONS || segments.length > MAX_SCAN_DEPTH) return;
    if (Array.isArray(value)) {
      value.slice(0, MAX_VALUE_ARRAY_INDEX).forEach((item, index) => {
        visit(item, [...segments, index], key, sensitive);
      });
    } else if (value !== null && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, [...segments, childKey], childKey, sensitive || isSensitiveKey(childKey));
      }
    } else if (segments.length > 0 && isStableScalar(value)) {
      if (sensitive) return;
      // booleans は id 系のキー名でも値が揮発しないので、id・時刻系のキー名では除外しない
      if (typeof value !== "boolean" && key !== undefined && isVolatileKey(key)) return;
      found.push({ path: formatJsonPath(segments), equals: value });
    }
  };
  visit(body, [], undefined, false);
  return found;
}

// ---------------------------------------------------------------------------
// チェイン推論
// ---------------------------------------------------------------------------

interface CaptureCandidate {
  stepIndex: number;
  path: string;
  key: string | undefined;
  /** パスのセグメント数(同じ値が複数箇所にあるとき浅い方を採用するための比較用) */
  depth: number;
}

/** チェインの対象とみなせるほど特徴的な値か: UUID、または 8 文字以上で数字を含む(20 文字以上なら数字は不要) */
function isDistinctiveValue(value: string): boolean {
  if (value.includes(MASK)) return false;
  if (UUID_PATTERN.test(value)) return true;
  if (value.length < 8) return false;
  return /\d/.test(value) || value.length >= 20;
}

/** JSON レスポンスのスカラー(文字列・数値)を、特徴的なものだけ「値の文字列表現 → 出所」として列挙する */
function collectCaptureCandidates(body: unknown, stepIndex: number): Map<string, CaptureCandidate> {
  const found = new Map<string, CaptureCandidate>();
  if (body === null || typeof body !== "object") return found;
  const visit = (value: unknown, segments: (string | number)[], key: string | undefined): void => {
    if (segments.length > MAX_SCAN_DEPTH) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(item, [...segments, index], undefined);
      });
    } else if (value !== null && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, [...segments, childKey], childKey);
      }
    } else if (typeof value === "string" || typeof value === "number") {
      const text = String(value);
      if (!isDistinctiveValue(text)) return;
      const path = formatJsonPath(segments);
      const existing = found.get(text);
      // 同じ値が複数箇所にあれば、パスが短い方(同じなら先に見つかった方)を採用する
      if (!existing || segments.length < existing.depth) {
        found.set(text, { stepIndex, path, key, depth: segments.length });
      }
    }
  };
  visit(body, [], undefined);
  return found;
}

// ---------------------------------------------------------------------------
// 生成本体
// ---------------------------------------------------------------------------

const ORIGIN_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

function toUpperSnake(text: string): string {
  return text
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function slugify(text: string, max = 60): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

function hostOf(url: string): string | undefined {
  const match = ORIGIN_PATTERN.exec(url);
  if (!match) return undefined;
  const authority = match[0].replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/, "");
  return host === "" || host.includes(MASK) || host.includes("{{") ? undefined : host;
}

function lastPathSegment(url: string): string | undefined {
  const path = url.replace(ORIGIN_PATTERN, "").split(/[?#]/)[0] ?? "";
  const segments = path.split("/").filter((segment) => segment !== "");
  return segments.at(-1);
}

class PlaceholderRegistry {
  private readonly map = new Map<string, string[]>();

  /** 値の中の "***" をすべて {{env.NAME}} に置き換える。同じ値内の2つ目以降は NAME_2, NAME_3 ... */
  replace(value: string, base: string, location: string): string {
    if (!value.includes(MASK)) return value;
    let index = 0;
    return value.split(MASK).reduce((acc, part, i) => {
      if (i === 0) return part;
      index += 1;
      const name = index === 1 ? base : `${base}_${index}`;
      const locations = this.map.get(name) ?? [];
      if (!locations.includes(location)) locations.push(location);
      this.map.set(name, locations);
      return `${acc}{{env.${name}}}${part}`;
    }, "");
  }

  /** 値を置き換えずに、プレースホルダー名と場所だけを登録する(秘密情報らしい値の置き換え用) */
  register(name: string, location: string): void {
    const locations = this.map.get(name) ?? [];
    if (!locations.includes(location)) locations.push(location);
    this.map.set(name, locations);
  }

  list(): PromotePlaceholder[] {
    return [...this.map.entries()].map(([name, locations]) => ({ name, locations }));
  }
}

/** URL を origin / パスセグメント / クエリ値 / フラグメントに分けて、それぞれを変換して組み立て直す */
function transformUrl(
  url: string,
  handlers: {
    origin: (origin: string) => string;
    segment: (segment: string, index: number) => string;
    queryValue: (name: string, value: string) => string;
    /** "=" を持たないクエリ要素(`?***` や `?flag`)。要素全体を渡す */
    queryBare: (pair: string) => string;
    fragment: (fragment: string) => string;
  },
): string {
  const originMatch = ORIGIN_PATTERN.exec(url);
  const origin = originMatch?.[0] ?? "";
  let rest = url.slice(origin.length);
  let fragment: string | undefined;
  const hashIndex = rest.indexOf("#");
  if (hashIndex >= 0) {
    fragment = rest.slice(hashIndex + 1);
    rest = rest.slice(0, hashIndex);
  }
  let query: string | undefined;
  const queryIndex = rest.indexOf("?");
  if (queryIndex >= 0) {
    query = rest.slice(queryIndex + 1);
    rest = rest.slice(0, queryIndex);
  }
  // origin が無い(テンプレート始まり等)場合、先頭が "{{...}}" でもパスとして扱う
  const segments = rest.split("/").map((segment, index) => handlers.segment(segment, index));
  let result = (origin ? handlers.origin(origin) : "") + segments.join("/");
  if (query !== undefined) {
    const pairs = query.split("&").map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return handlers.queryBare(pair);
      const name = pair.slice(0, eq);
      return `${name}=${handlers.queryValue(name, pair.slice(eq + 1))}`;
    });
    result += `?${pairs.join("&")}`;
  }
  if (fragment !== undefined) result += `#${handlers.fragment(fragment)}`;
  return result;
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

interface PendingStep {
  source: { runId: string; entry: HistoryEntry };
  name: string;
}

/** 捕捉名の払い出し(フロー内で一意) */
class CaptureNamer {
  private readonly byKey = new Map<string, string>();
  private readonly used = new Set<string>();

  constructor(reserved: readonly string[]) {
    for (const name of reserved) this.used.add(name);
  }

  nameFor(candidate: CaptureCandidate, stepName: string): string {
    const key = `${candidate.stepIndex}|${candidate.path}`;
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const sanitize = (text: string): string => text.replace(/[^A-Za-z0-9_]+/g, "_");
    const leaf =
      candidate.key && /[A-Za-z]/.test(candidate.key) ? sanitize(candidate.key) : "value";
    const stepPrefix = sanitize(stepName);
    let name = leaf;
    if (this.used.has(name)) name = `${stepPrefix}_${leaf}`;
    for (let suffix = 2; this.used.has(name); suffix++) name = `${stepPrefix}_${leaf}_${suffix}`;
    this.used.add(name);
    this.byKey.set(key, name);
    return name;
  }
}

/** 1 つの run から取り出す対象エントリを決める(flow 絞り込み・--data 実行は最初のイテレーションのみ) */
function selectEntries(
  run: PromoteRunInput,
  flow: string | undefined,
  notes: string[],
): { ok: true; entries: HistoryEntry[] } | { ok: false; message: string; kind: "usage" } {
  // 同一 startedAt のステップは入力順(追記順。呼び出し側は selectRunEntries で並べる)を保つ安定ソート
  let entries = [...run.entries].sort((a, b) =>
    a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0,
  );
  if (flow !== undefined) {
    entries = entries.filter((entry) => entry.flow === flow);
    if (entries.length === 0) {
      return {
        ok: false,
        message: `run "${run.runId}" has no entries for flow "${flow}"`,
        kind: "usage",
      };
    }
  } else {
    const flows = [...new Set(entries.map((entry) => entry.flow))];
    if (flows.length > 1) {
      return {
        ok: false,
        message: `run "${run.runId}" contains multiple flows (${flows.map((name) => `"${name}"`).join(", ")}); pick one with --flow <name>`,
        kind: "usage",
      };
    }
  }
  const iterations = entries.flatMap((entry) =>
    entry.iteration !== undefined ? [entry.iteration] : [],
  );
  if (iterations.length > 0) {
    const first = Math.min(...iterations);
    entries = entries.filter((entry) => entry.iteration === undefined || entry.iteration === first);
    notes.push(`run ${run.runId} is a --data run; only iteration ${first} was promoted`);
  }
  return { ok: true, entries };
}

/** 保守的な YAML コメント・メッセージ用に location を整形する */
function describeLocations(items: { step: string; location: string }[]): string {
  return items.map((item) => `step "${item.step}" ${item.location}`).join("; ");
}

const AUTH_SCHEME_PATTERN = /^(Bearer|Basic|Digest|Token|ApiKey|Negotiate|Bot) (.+)$/is;

/** 履歴の run(複数可。与えた順に連結する。各 run のエントリは追記順で渡すこと)からフロー定義を組み立てる */
export function promoteRuns(
  runs: readonly PromoteRunInput[],
  options: PromoteOptions,
): PromoteOutcome {
  const notes: string[] = [];
  const skipped: PromoteSkipped[] = [];
  const pending: PendingStep[] = [];

  for (const run of runs) {
    const selected = selectEntries(run, options.flow, notes);
    if (!selected.ok) return selected;
    for (const entry of selected.entries) {
      const reason = skipReason(entry);
      if (reason) {
        skipped.push({ runId: run.runId, flow: entry.flow, step: entry.step, reason });
      } else {
        pending.push({ source: { runId: run.runId, entry }, name: entry.step });
      }
    }
  }
  if (pending.length === 0) {
    return {
      ok: false,
      message: "no promotable steps (every recorded step was skipped)",
      kind: "content",
    };
  }
  for (const { source } of pending) {
    if (exceedsDepth(source.entry.request?.body, MAX_REQUEST_BODY_DEPTH)) {
      return {
        ok: false,
        message: `step "${source.entry.step}" has a request body nested deeper than ${MAX_REQUEST_BODY_DEPTH} levels`,
        kind: "content",
      };
    }
  }

  assignStepNames(pending);

  const placeholders = new PlaceholderRegistry();
  const redacted: PromoteRedaction[] = [];
  const templateLiterals: { step: string; location: string }[] = [];
  /** 再現できない・安全に出力できない入力(マスクされたキー等)。1 件でもあれば生成を拒否する */
  const fatal: string[] = [];
  const baseUrls: { name: string; value: string }[] = [];
  const baseUrlName = (origin: string): string => {
    const existing = baseUrls.find((item) => item.value === origin);
    if (existing) return existing.name;
    const name =
      baseUrls.length === 0
        ? (options.baseUrlVar as string)
        : `${options.baseUrlVar}_${baseUrls.length + 1}`;
    baseUrls.push({ name, value: origin });
    return name;
  };

  // テンプレート関数と env 名前空間は描画時にキャプチャより優先されるため、キャプチャ名として使わない
  const captureNamer = new CaptureNamer([
    "newUuid",
    "newDate",
    "newTimestamp",
    "env",
    ...(options.baseUrlVar ? [options.baseUrlVar] : []),
  ]);
  const captureLinks = new Map<string, PromoteCaptureLink>();
  const captureDefs: Record<string, string>[] = pending.map(() => ({}));
  // そのステップまでのリクエストに(JSON 化して)そのまま現れる値は、サーバー生成ではなく
  // 利用者が与えた値(または単なるエコー)とみなして、そのステップの候補から外す
  let requestsSoFar = "";
  const candidatesByStep = pending.map(({ source }, index) => {
    requestsSoFar += `${JSON.stringify(source.entry.request ?? null)}\n`;
    const found =
      options.chain && source.entry.response && typeof source.entry.response.body === "object"
        ? collectCaptureCandidates(source.entry.response.body, index)
        : new Map<string, CaptureCandidate>();
    for (const value of [...found.keys()]) {
      if (requestsSoFar.includes(JSON.stringify(value).slice(1, -1))) found.delete(value);
    }
    return found;
  });

  const steps: Record<string, unknown>[] = [];
  const stepInfos: PromotedStepInfo[] = [];

  pending.forEach(({ source, name }, index) => {
    const entry = source.entry;
    const request = entry.request as NonNullable<HistoryEntry["request"]>;

    // 先行ステップの候補。同じ値が複数ステップにあれば直近のステップを優先する
    const candidates = new Map<string, CaptureCandidate>();
    for (let j = 0; j < index; j++) {
      for (const [value, candidate] of candidatesByStep[j] ?? []) candidates.set(value, candidate);
    }
    const useCapture = (value: string, location: string): string | undefined => {
      const candidate = candidates.get(value);
      if (!candidate) return undefined;
      const fromStep = pending[candidate.stepIndex] as PendingStep;
      const captureName = captureNamer.nameFor(candidate, fromStep.name);
      (captureDefs[candidate.stepIndex] as Record<string, string>)[captureName] = candidate.path;
      const linkKey = `${candidate.stepIndex}|${candidate.path}`;
      const link = captureLinks.get(linkKey) ?? {
        name: captureName,
        from: { step: fromStep.name, path: candidate.path },
        used: [],
      };
      link.used.push({ step: name, location });
      captureLinks.set(linkKey, link);
      return `{{${captureName}}}`;
    };

    /** 記録値にリテラルの "{{" があれば記録する(klaus は "{{" をエスケープできず、実行時に展開されるため) */
    const checkTemplateLiteral = (text: string, location: string): void => {
      if (text.includes("{{")) templateLiterals.push({ step: name, location });
    };

    /** 秘密情報らしい値をプレースホルダーに置き換える。forced は秘密情報を示すキー・ヘッダー配下の値 */
    const redact = (
      text: string,
      base: string,
      location: string,
      forced: boolean,
      allowScheme: boolean,
    ): string => {
      if (text === "") return text;
      const place = (suffix: number, reason: PromoteRedaction["reason"]): string => {
        const placeholderName = suffix === 1 ? base : `${base}_${suffix}`;
        placeholders.register(placeholderName, `step "${name}": ${location}`);
        redacted.push({ name: placeholderName, location: `step "${name}": ${location}`, reason });
        return `{{env.${placeholderName}}}`;
      };
      if (forced) {
        // マスク値・キャプチャ参照・環境変数参照に置き換え済みなら、新たなリテラルは残っていない
        if (text.includes("{{")) return text;
        const scheme = allowScheme ? AUTH_SCHEME_PATTERN.exec(text) : null;
        if (scheme) return `${scheme[1]} ${place(1, "sensitive key")}`;
        return place(1, "sensitive key");
      }
      if (!text.includes(" ")) return looksLikeSecret(text) ? place(1, "token-like value") : text;
      let count = 0;
      return text
        .split(" ")
        .map((token) => {
          if (!looksLikeSecret(token)) return token;
          count += 1;
          return place(count, "token-like value");
        })
        .join(" ");
    };

    // URL
    checkTemplateLiteral(request.url, "url");
    const url = transformUrl(request.url, {
      origin: (origin) => {
        const replaced = placeholders.replace(
          origin,
          "TODO_URL_ORIGIN",
          `step "${name}": url origin`,
        );
        if (options.baseUrlVar && replaced === origin && !origin.includes("{{")) {
          return `{{${baseUrlName(origin)}}}`;
        }
        return replaced;
      },
      segment: (segment, i) => {
        const chained = options.chain ? useCapture(decodeSafe(segment), `url path`) : undefined;
        if (chained) return chained;
        const masked = placeholders.replace(
          segment,
          `TODO_URL_PATH_${i}`,
          `step "${name}": url path`,
        );
        return redact(masked, `TODO_URL_PATH_${i}`, "url path", false, false);
      },
      queryValue: (queryName, value) => {
        if (queryName.includes(MASK)) {
          fatal.push(
            `step "${name}" url query name contains a masked value (***) and cannot be reproduced`,
          );
          return value;
        }
        const chained = options.chain
          ? useCapture(decodeSafe(value), `url query "${queryName}"`)
          : undefined;
        if (chained) return chained;
        const base = `TODO_QUERY_${toUpperSnake(queryName) || "VALUE"}`;
        const masked = placeholders.replace(
          value,
          base,
          `step "${name}": url query "${queryName}"`,
        );
        return redact(masked, base, `url query "${queryName}"`, isSensitiveKey(queryName), false);
      },
      queryBare: (pair) => {
        if (!pair.includes(MASK)) return pair;
        return placeholders.replace(pair, "TODO_QUERY_PARAM", `step "${name}": url query`);
      },
      fragment: (fragment) =>
        placeholders.replace(fragment, "TODO_URL_FRAGMENT", `step "${name}": url fragment`),
    });

    // ヘッダー
    const headers: Record<string, string> = {};
    for (const [headerName, value] of Object.entries(request.headers)) {
      if (DROPPED_REQUEST_HEADERS.has(headerName.toLowerCase())) continue;
      if (headerName.includes(MASK)) {
        fatal.push(
          `step "${name}" header name contains a masked value (***) and cannot be reproduced`,
        );
        continue;
      }
      checkTemplateLiteral(value, `header "${headerName}"`);
      let next = value;
      if (options.chain) {
        // 値全体、または "Bearer <token>" のように空白区切りの最後のトークンが一致する場合
        const whole = useCapture(value, `header "${headerName}"`);
        if (whole) {
          next = whole;
        } else if (value.includes(" ")) {
          const cut = value.lastIndexOf(" ");
          const token = useCapture(value.slice(cut + 1), `header "${headerName}"`);
          if (token) next = `${value.slice(0, cut + 1)}${token}`;
        }
      }
      const base = `TODO_${toUpperSnake(headerName) || "HEADER"}`;
      next = placeholders.replace(next, base, `step "${name}": header ${headerName}`);
      headers[headerName] = redact(
        next,
        base,
        `header ${headerName}`,
        isSensitiveKey(headerName),
        true,
      );
    }

    // body
    const body = transformBody(request.body, [], {
      key: (key, segments) => {
        if (key.includes(MASK)) {
          fatal.push(
            `step "${name}" body key at ${formatJsonPath(segments)} contains a masked value (***) and cannot be reproduced`,
          );
        }
      },
      string: (text, segments) => {
        const location = segments.length === 0 ? "body" : `body ${formatJsonPath(segments)}`;
        checkTemplateLiteral(text, location);
        const base = bodyPlaceholderName(segments);
        const sensitive = segments.some(
          (segment) => typeof segment === "string" && isSensitiveKey(segment),
        );
        let next = text;
        if (options.chain) {
          const whole = useCapture(text, location);
          if (whole) {
            next = whole;
          } else if (text.includes(" ")) {
            next = text
              .split(" ")
              .map((token) => useCapture(token, location) ?? token)
              .join(" ");
          }
        }
        next = placeholders.replace(next, base, `step "${name}": ${location}`);
        return redact(next, base, location, sensitive, false);
      },
    });

    const isSse = entry.events !== undefined;
    const step: Record<string, unknown> = {
      name,
      request: {
        method: request.method,
        url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
        ...(body !== undefined ? { body } : {}),
      },
      ...(isSse ? { sse: {} } : {}),
    };
    const assert = inferAssertions(entry, options.assert, isSse, name, notes);
    if (assert) step.assert = assert;
    steps.push(step);
    stepInfos.push({
      name,
      method: request.method,
      url,
      from: { runId: source.runId, flow: entry.flow, step: entry.step },
    });
  });

  if (fatal.length > 0) {
    return { ok: false, message: fatal.join("; "), kind: "content" };
  }
  if (templateLiterals.length > 0) {
    if (options.allowTemplateLiterals !== true) {
      return {
        ok: false,
        message: `recorded request values contain a literal "{{" (${describeLocations(templateLiterals)}); klaus would expand them as templates when the flow runs (for example {{env.X}} would send an OS environment variable to the server). Refusing to generate; pass --allow-template-literals to emit them anyway`,
        kind: "content",
      };
    }
    notes.push(
      `WARNING: ${templateLiterals.length} recorded value(s) contain a literal "{{" and were emitted as-is; they will be expanded as templates when the flow runs: ${describeLocations(templateLiterals)}`,
    );
  }

  // capture は遅延して確定するため、最後にステップへ差し込む(request の次に置いてキー順を読みやすくする)
  const finalSteps = steps.map((step, index) => {
    const capture = captureDefs[index] as Record<string, string>;
    if (Object.keys(capture).length === 0) return step;
    const { assert, ...rest } = step;
    return { ...rest, capture, ...(assert !== undefined ? { assert } : {}) };
  });

  const distinctFlows = [...new Set(pending.map(({ source }) => source.entry.flow))].filter(
    (flow) => flow !== SINGLE_FLOW_NAME,
  );
  const firstUrl = (pending[0] as PendingStep).source.entry.request?.url ?? "";
  const flowName =
    options.name ??
    (distinctFlows.length === 1 &&
    pending.every(({ source }) => source.entry.flow === distinctFlows[0])
      ? (distinctFlows[0] as string)
      : `promoted ${hostOf(firstUrl) ?? "requests"}`);

  const result: PromoteResult = {
    flowName,
    suggestedPath: `${finalSteps.length === 1 ? "api" : "flows"}/${slugify(flowName) || "promoted"}.yaml`,
    flow: { name: flowName, steps: finalSteps },
    steps: stepInfos,
    placeholders: placeholders.list(),
    captures: [...captureLinks.values()],
    baseUrls,
    skipped,
    notes,
    assert: options.assert,
    redacted,
    templateLiterals: options.allowTemplateLiterals === true ? templateLiterals : [],
    notice: PROMOTE_NOTICE,
  };
  return { ok: true, result };
}

function skipReason(entry: HistoryEntry): string | undefined {
  const status = resolveHistoryEntryStatus(entry);
  if (status === "skipped" || !entry.request) return "skipped step (no request was recorded)";
  if (status === "error") {
    // 応答つきで error になったステップ(capture の失敗など)も含め、error のステップからはアサーションを作らず昇格しない
    // (失敗した検査の応答を「正しい基準」として固定してしまうのを避ける)
    return `step ended in error${entry.error ? ` (${entry.error})` : ""}; steps that ended in error are not promoted`;
  }
  if (entry.request.method === "WS") return "WebSocket steps are not promoted";
  if (!entry.response) return "no response was recorded";
  return undefined;
}

/** 単発リクエスト(step 名が常に "request")は method とパスから名前を付け、フロー内で重複する名前には -2, -3 ... を付ける */
function assignStepNames(pending: PendingStep[]): void {
  const used = new Set<string>();
  for (const item of pending) {
    const entry = item.source.entry;
    let base = entry.step;
    if (entry.flow === SINGLE_FLOW_NAME && entry.request) {
      const target = slugify(
        lastPathSegment(entry.request.url) ?? hostOf(entry.request.url) ?? "",
        40,
      );
      base = `${entry.request.method.toLowerCase()}${target ? `-${target}` : ""}`;
    }
    let name = base;
    for (let suffix = 2; used.has(name); suffix++) name = `${base}-${suffix}`;
    used.add(name);
    item.name = name;
  }
}

function bodyPlaceholderName(segments: readonly (string | number)[]): string {
  const suffix = segments
    .map((segment) => toUpperSnake(String(segment)))
    .filter(Boolean)
    .join("_");
  return suffix ? `TODO_BODY_${suffix}` : "TODO_BODY";
}

/**
 * 値を深く辿って文字列だけを変換した新しい値を返す(元の値は変更しない)。再帰の深さは呼び出し側が
 * MAX_REQUEST_BODY_DEPTH 以下であることを確認済みの前提。key はオブジェクトキーごとに呼ばれる
 */
function transformBody(
  value: unknown,
  segments: (string | number)[],
  handlers: {
    string: (text: string, segments: (string | number)[]) => string;
    key: (key: string, segments: (string | number)[]) => void;
  },
): unknown {
  if (typeof value === "string") return handlers.string(value, segments);
  if (Array.isArray(value)) {
    return value.map((item, index) => transformBody(item, [...segments, index], handlers));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      handlers.key(key, [...segments, key]);
      result[key] = transformBody(child, [...segments, key], handlers);
    }
    return result;
  }
  return value;
}

function inferAssertions(
  entry: HistoryEntry,
  mode: PromoteAssertMode,
  isSse: boolean,
  stepName: string,
  notes: string[],
): Record<string, unknown> | undefined {
  const response = entry.response;
  if (!response) return undefined;
  const assert: Record<string, unknown> = { status: response.status };
  if (mode === "status") return assert;

  const contentTypeKey = Object.keys(response.headers).find(
    (key) => key.toLowerCase() === "content-type",
  );
  const contentType = contentTypeKey ? response.headers[contentTypeKey] : undefined;
  if (contentType && !isSse) {
    const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
    if (mime) assert.headers = [{ name: "content-type", contains: mime }];
  }

  if (isSse) return assert;

  const body = response.body;
  const isJsonBody = body !== null && body !== undefined && typeof body !== "string";
  if (!isJsonBody) {
    if (body !== "" && body !== undefined) {
      notes.push(
        `step "${stepName}": the response body is not JSON, so only status and content-type are asserted`,
      );
    }
    return assert;
  }

  if (mode === "schema" || mode === "all") assert.bodySchema = inferJsonSchema(body);
  if (mode === "values" || mode === "all") {
    const values = collectStableValues(body);
    if (values.length > 0) assert.body = values.map(({ path, equals }) => ({ path, equals }));
  }
  return assert;
}

// ---------------------------------------------------------------------------
// YAML 出力
// ---------------------------------------------------------------------------

/**
 * 昇格結果を YAML 文字列にする。先頭は generate / init と同じ $schema コメント、続けて
 * 生成元・埋めるべきプレースホルダー・環境ファイルに書く値・推論したチェインをコメントで残す
 * (コメントにシークレットは含まれない)。
 */
export function renderPromotedYaml(result: PromoteResult, sourceRunIds: readonly string[]): string {
  const lines = [
    FLOW_SCHEMA_COMMENT,
    `# Generated by klaus promote from run ${sourceRunIds.join(", ")}. Review before committing.`,
    `# Assertions inferred with --assert ${result.assert}.`,
    `# NOTICE: ${result.notice}`,
  ];
  if (result.templateLiterals.length > 0) {
    lines.push(
      '# WARNING: these recorded values contain a literal "{{" and are expanded as templates when the flow runs (generated with --allow-template-literals):',
    );
    for (const item of result.templateLiterals)
      lines.push(`#   step "${item.step}" ${item.location}`);
  }
  if (result.placeholders.length > 0) {
    lines.push(
      "# Set these OS environment variables before running (values that were masked in history, or that look sensitive):",
    );
    for (const placeholder of result.placeholders) {
      lines.push(`#   ${placeholder.name}  (${placeholder.locations.join("; ")})`);
    }
  }
  if (result.baseUrls.length > 0) {
    lines.push("# Define these in the environment file (environments/<name>.yaml or --env-file):");
    for (const baseUrl of result.baseUrls) lines.push(`#   ${baseUrl.name}: ${baseUrl.value}`);
  }
  if (result.captures.length > 0) {
    lines.push(
      "# Inferred captures (a value from an earlier response reappears in a later request; verify):",
    );
    for (const capture of result.captures) {
      const uses = capture.used.map((use) => `step "${use.step}" ${use.location}`).join(", ");
      lines.push(
        `#   ${capture.name}: step "${capture.from.step}" ${capture.from.path} -> ${uses}`,
      );
    }
  }
  // コメント行に履歴由来の文字列(キー名・ステップ名)が入るため、改行で YAML 構造を壊さないよう1行に畳む
  const header = lines.map((line) => line.replace(/[\r\n]+/g, " ")).join("\n");
  return `${header}\n${stringifyYaml(result.flow, { lineWidth: 0 })}`;
}
