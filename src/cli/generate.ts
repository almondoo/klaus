/**
 * `klaus generate` サブコマンドの実装。
 * OpenAPI(Swagger 2.0 / OpenAPI 3.x)の定義ファイルから、各オペレーション(paths × HTTP メソッド)ごとに
 * 単発チェックのフロー定義 YAML を1ファイルずつ生成する。生成物はあくまで骨組み(examples/api/*.yaml と
 * 同じ形の最小構成)であり、アサーションの充実や認証ヘッダーの追加は利用者側での加筆を前提とする。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
// @apidevtools/swagger-parser は devDependencies(tsup が dist にバンドルする実行時依存として import。
// yaml と同じ既定パターン)。$ref を解決した(dereference 済みの)ドキュメントを扱うため、
// 生成ロジック側では $ref を一切気にしなくてよい。
import SwaggerParser from "@apidevtools/swagger-parser";
import { stringify as stringifyYaml } from "yaml";
import { type FlowIssue, validateFlowYaml } from "../core/index.js";
import { fileExists, toDisplayPath } from "./fs-utils.js";
import { isJsonOutputMode } from "./reporters/text.js";

/** generate コマンドのオプション(commander から渡される値を正規化した形) */
export interface GenerateCommandOptions {
  outDir?: string;
  json?: boolean;
}

/** 1件分の生成エラー(spec 内の該当オペレーションに紐づく場合は path を持つ) */
export interface GenerateIssue {
  path?: string;
  message: string;
}

/** JSON モードの出力ペイロード。将来フィールドを変える場合は version を上げる */
export interface GenerateJsonReport {
  version: 1;
  generated: string[];
  skipped: string[];
  errors: GenerateIssue[];
}

const DEFAULT_OUT_DIR = "api";
const SCHEMA_COMMENT =
  "# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json";
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

/**
 * openapi-types は SwaggerParser の devDependency 経由でのみ解決可能で、このパッケージの
 * 直接の devDependency ではない(pnpm の strict node_modules ではファントム依存として型解決できない)。
 * そのため独自に、生成ロジックが実際に読む範囲だけの最小限の構造を定義する
 * (dereference 済みなので $ref フィールドは登場しない前提)。
 */
interface OpenApiExampleObject {
  value?: unknown;
}
interface OpenApiSchemaObject {
  type?: string;
  example?: unknown;
  default?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, OpenApiSchemaObject>;
  items?: OpenApiSchemaObject;
  format?: string;
}
interface OpenApiParameterObject {
  name: string;
  in: string;
  example?: unknown;
  examples?: Record<string, OpenApiExampleObject>;
  schema?: OpenApiSchemaObject;
}
interface OpenApiMediaTypeObject {
  example?: unknown;
  examples?: Record<string, OpenApiExampleObject>;
  schema?: OpenApiSchemaObject;
}
interface OpenApiRequestBodyObject {
  content?: Record<string, OpenApiMediaTypeObject>;
}
interface OpenApiOperationObject {
  operationId?: string;
  parameters?: OpenApiParameterObject[];
  requestBody?: OpenApiRequestBodyObject;
  responses?: Record<string, unknown>;
}
interface OpenApiPathItemObject {
  parameters?: OpenApiParameterObject[];
  [method: string]: unknown;
}
interface OpenApiDocument {
  /** OpenAPI 3.x であることの判定に使う("3.0.3" 等)。Swagger 2.0 では代わりに swagger フィールドを持つ */
  openapi?: string;
  paths?: Record<string, OpenApiPathItemObject>;
}

/** 1オペレーション分の、生成に必要な情報を集約した中間表現 */
interface GeneratedOperation {
  /** kebab-case 済みの id(ファイル名の basename・ステップ名の両方に使う) */
  id: string;
  flowName: string;
  method: (typeof HTTP_METHODS)[number];
  path: string;
  queryParameters: OpenApiParameterObject[];
  requestBody: OpenApiRequestBodyObject | undefined;
  responses: Record<string, unknown> | undefined;
}

/** camelCase / snake_case / スペース区切り等を kebab-case に正規化する */
function kebabCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/** OpenAPI の path テンプレート("/users/{id}")をファイル名向けにスラッグ化する({} を除去してから kebab-case 化) */
function slugifyPath(path: string): string {
  return kebabCase(path.replace(/[{}]/g, ""));
}

/** 同一 run 内での id 衝突を避ける(spec の operationId 重複や slug 衝突に備えた保険) */
function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** path-item レベルの共有 parameters とオペレーション固有の parameters をマージする(同名は後者が優先) */
function mergeParameters(
  shared: OpenApiParameterObject[] | undefined,
  own: OpenApiParameterObject[] | undefined,
): OpenApiParameterObject[] {
  const merged = new Map<string, OpenApiParameterObject>();
  for (const parameter of shared ?? []) {
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  for (const parameter of own ?? []) {
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  }
  return [...merged.values()];
}

/** spec のドキュメントから、生成対象となる全オペレーション(paths × HTTP メソッド)を列挙する */
function collectOperations(document: OpenApiDocument): GeneratedOperation[] {
  const operations: GeneratedOperation[] = [];
  const usedIds = new Set<string>();

  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const raw = pathItem[method];
      if (typeof raw !== "object" || raw === null) continue;
      const operation = raw as OpenApiOperationObject;

      const baseId = operation.operationId
        ? kebabCase(operation.operationId)
        : `${method}-${slugifyPath(path)}`;
      const id = uniqueId(baseId, usedIds);
      usedIds.add(id);

      operations.push({
        id,
        flowName: operation.operationId ?? `${method.toUpperCase()} ${path}`,
        method,
        path,
        queryParameters: mergeParameters(pathItem.parameters, operation.parameters).filter(
          (parameter) => parameter.in === "query",
        ),
        requestBody: operation.requestBody,
        responses: operation.responses,
      });
    }
  }
  return operations;
}

/** example / examples / schema.example / schema.default の優先順でパラメータの example 値を探す */
function exampleForParameter(parameter: OpenApiParameterObject): unknown {
  if (parameter.example !== undefined) return parameter.example;
  const firstExample = parameter.examples && Object.values(parameter.examples)[0];
  if (firstExample?.value !== undefined) return firstExample.value;
  if (parameter.schema?.example !== undefined) return parameter.schema.example;
  if (parameter.schema?.default !== undefined) return parameter.schema.default;
  return undefined;
}

/** example / examples / schema.example の優先順で requestBody media type の example 値を探す */
function exampleForMediaType(media: OpenApiMediaTypeObject): unknown {
  if (media.example !== undefined) return media.example;
  const firstExample = media.examples && Object.values(media.examples)[0];
  if (firstExample?.value !== undefined) return firstExample.value;
  if (media.schema?.example !== undefined) return media.schema.example;
  return undefined;
}

/**
 * example が無い schema から、最小限のプレースホルダ値を作る。
 * 循環参照(dereference 済みのため理論上あり得る)による無限再帰を避けるため、深さと訪問済みオブジェクトで打ち切る。
 * オブジェクトは required なプロパティのみを埋める(骨組みとして最小限にする方針)。
 *
 * seen は「祖先チェーン」として扱う: 自分自身を追加した後に子孫を処理し、戻る前に必ず削除する。
 * こうすることで、同一オブジェクトを兄弟プロパティが複数回参照する非循環パターン
 * (SwaggerParser.dereference は $ref 解決後も参照同一性を保つため一般的に起こり得る)を
 * 誤って循環と判定してしまうのを防ぐ。真の循環(自分自身が祖先チェーンに現れる)のみ打ち切り対象になる。
 */
function buildPlaceholder(
  schema: OpenApiSchemaObject | undefined,
  depth = 0,
  seen: Set<OpenApiSchemaObject> = new Set(),
): unknown {
  if (!schema) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (depth >= 5 || seen.has(schema)) return schema.type === "array" ? [] : {};
  seen.add(schema);
  try {
    if (schema.type === "object" || schema.properties) {
      const result: Record<string, unknown> = {};
      for (const name of schema.required ?? []) {
        const propertySchema = schema.properties?.[name];
        if (propertySchema) {
          result[name] = buildPlaceholder(propertySchema, depth + 1, seen);
        }
      }
      return result;
    }
    if (schema.type === "array") return [];
    if (schema.type === "integer" || schema.type === "number") return 0;
    if (schema.type === "boolean") return false;
    if (schema.type === "string") return "";
    return null;
  } finally {
    // サブツリーの処理が終わったら祖先チェーンから外す(この schema への「他の」参照経路まで循環扱いにしないため)
    seen.delete(schema);
  }
}

/** query パラメータの値(unknown)を request.query(string レコード)向けに文字列化する */
function stringifyQueryValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** requestBody から、生成する body 値と Content-Type ヘッダー値を決める(requestBody 自体が無ければ undefined) */
function buildRequestBody(
  requestBody: OpenApiRequestBodyObject | undefined,
): { body: unknown; contentType: string } | undefined {
  if (!requestBody?.content) return undefined;
  const contentType = requestBody.content["application/json"]
    ? "application/json"
    : Object.keys(requestBody.content)[0];
  if (!contentType) return undefined;
  const media = requestBody.content[contentType];
  if (!media) return undefined;

  const example = exampleForMediaType(media);
  const body = example !== undefined ? example : buildPlaceholder(media.schema);
  // example もプレースホルダも作れなかった場合(schema すら無い等)は body を省略する
  if (body === undefined) return undefined;
  return { body, contentType };
}

/** responses のキー(200, 201, 4XX, default 等)のうち、最小の 2xx を選ぶ。無ければ 200 */
function minimumSuccessStatus(responses: Record<string, unknown> | undefined): number {
  const codes = Object.keys(responses ?? {})
    .map((code) => Number.parseInt(code, 10))
    .filter((code) => Number.isInteger(code) && code >= 200 && code < 300);
  return codes.length > 0 ? Math.min(...codes) : 200;
}

/** 1オペレーション分のフロー定義 YAML 文字列(先頭の $schema コメント込み)を組み立てる */
function buildFlowYaml(operation: GeneratedOperation): string {
  const request: Record<string, unknown> = {
    method: operation.method.toUpperCase(),
    url: `{{baseUrl}}${operation.path}`,
  };

  const headers: Record<string, string> = {};
  const query: Record<string, string> = {};
  for (const parameter of operation.queryParameters) {
    const example = exampleForParameter(parameter);
    if (example === undefined) continue;
    query[parameter.name] = stringifyQueryValue(example);
  }
  if (Object.keys(query).length > 0) request.query = query;

  const requestBody = buildRequestBody(operation.requestBody);
  if (requestBody) {
    request.body = requestBody.body;
    headers["Content-Type"] = requestBody.contentType;
  }
  if (Object.keys(headers).length > 0) request.headers = headers;

  const flow = {
    name: operation.flowName,
    steps: [
      {
        name: operation.id,
        request,
        assert: { status: minimumSuccessStatus(operation.responses) },
      },
    ],
  };

  // lineWidth: 0 で折り返しを無効化する(長い URL 等が複数行に折れて可読性を落とすのを防ぐ)
  const yamlBody = stringifyYaml(flow, { lineWidth: 0 });
  return `${SCHEMA_COMMENT}\n${yamlBody}`;
}

/** FlowIssue の配列を1行のメッセージにまとめる(validate コマンドの表示と同じ形式を踏襲) */
function formatFlowIssues(issues: FlowIssue[]): string {
  return issues.map((issue) => `${issue.path || "(root)"}: ${issue.message}`).join("; ");
}

/**
 * spec 全体に関わるエラー(パース失敗・非対応バージョン)を JSON/text 両モードで出力する。
 * 生成そのものを行わないケース専用(generated/skipped は常に空)。
 * textMessage は text(stderr)モード向けの表現を分けたい場合に指定する(省略時は message を流用)。
 */
function reportSpecError(message: string, useJson: boolean, textMessage: string = message): void {
  if (useJson) {
    const report: GenerateJsonReport = {
      version: 1,
      generated: [],
      skipped: [],
      errors: [{ message }],
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stderr.write(`klaus: ${textMessage}\n`);
  }
}

/** OpenAPI 3.x 判定に使う正規表現("3.0.3" 等の 3 系メジャーバージョンのみ許可) */
const OPENAPI_3X_VERSION = /^3(\.|$)/;

/** generate が対応していない spec バージョン(現状は Swagger 2.0)向けの actionable なエラーメッセージ */
const UNSUPPORTED_SPEC_VERSION_MESSAGE =
  "klaus generate only supports OpenAPI 3.x definitions. Convert the Swagger 2.0 definition to " +
  "OpenAPI 3.x (e.g. with swagger2openapi) before running this command.";

/** TTY 向けのテキスト出力 */
function printText(generated: string[], skipped: string[], errors: GenerateIssue[]): void {
  for (const path of generated) {
    process.stdout.write(`generated: ${path}\n`);
  }
  for (const path of skipped) {
    process.stdout.write(`skipped (already exists): ${path}\n`);
  }
  for (const error of errors) {
    const location = error.path ? `${error.path}: ` : "";
    process.stdout.write(`error: ${location}${error.message}\n`);
  }
}

/**
 * generate コマンド本体。
 * 1. spec を SwaggerParser.dereference でパース・検証($ref 解決込み)。失敗したら exit 2
 * 2. 各オペレーションごとにフロー YAML を組み立て、validateFlowYaml を通ったものだけ書き込む
 * 3. 既存ファイルは上書きせずスキップする
 * 戻り値は exit code(全生成成功なら 0、spec 不正または生成物が検証を通らなければ 2)。
 * spec 読み込み・パース以外の予期しない例外は呼び出し元へ投げる(呼び出し元で exit 1 に変換する契約)。
 */
export async function generateCommand(
  specPath: string,
  options: GenerateCommandOptions,
): Promise<number> {
  const cwd = process.cwd();
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const useJson = isJsonOutputMode(options.json);

  let document: OpenApiDocument;
  try {
    const parsed = await SwaggerParser.dereference(specPath);
    document = parsed as unknown as OpenApiDocument;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportSpecError(message, useJson, `invalid OpenAPI definition: ${message}`);
    return 2;
  }

  // Swagger 2.0(swagger: "2.0")等、OpenAPI 3.x 以外は SwaggerParser.dereference 自体は成功してしまう
  // (dereference は $ref 解決のみでバージョン検証はしない)。3.x 専用の request.body 組み立てロジック
  // (requestBody / parameter.schema 前提)では Swagger 2.0 の `in: body` パラメータを拾えず、body が
  // 欠落した不完全な YAML を無警告で生成してしまうため、ここで明示的に弾く。
  if (typeof document.openapi !== "string" || !OPENAPI_3X_VERSION.test(document.openapi)) {
    reportSpecError(UNSUPPORTED_SPEC_VERSION_MESSAGE, useJson);
    return 2;
  }

  const generated: string[] = [];
  const skipped: string[] = [];
  const errors: GenerateIssue[] = [];

  for (const operation of collectOperations(document)) {
    // --out-dir に絶対パスを渡された場合でも cwd と二重結合しないよう、絶対/相対で組み立て方を分ける
    // (path.join は第2引数が "/" 始まりでも単純結合するだけで絶対パスとして扱ってくれないため)
    const fullPath = isAbsolute(outDir)
      ? join(outDir, `${operation.id}.yaml`)
      : join(cwd, outDir, `${operation.id}.yaml`);
    const displayPath = toDisplayPath(cwd, fullPath);

    if (await fileExists(fullPath)) {
      skipped.push(displayPath);
      continue;
    }

    const content = buildFlowYaml(operation);
    const validation = validateFlowYaml(content);
    if (!validation.valid) {
      errors.push({ path: displayPath, message: formatFlowIssues(validation.errors) });
      continue;
    }

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    generated.push(displayPath);
  }

  if (useJson) {
    const report: GenerateJsonReport = { version: 1, generated, skipped, errors };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    printText(generated, skipped, errors);
  }

  return errors.length > 0 ? 2 : 0;
}
