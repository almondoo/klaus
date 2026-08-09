import { readFile } from "node:fs/promises";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { ZodError } from "zod";
import { ParseError } from "./errors.js";
import { type Environment, environmentSchema, type Flow, flowSchema } from "./schema.js";

/** zod のエラーを人間可読な1行にまとめる */
export function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** YAMLParseError を位置情報付きの人間可読なメッセージに整形する(toParseError・validateFlowYaml で共用) */
function formatYamlSyntaxError(error: YAMLParseError): string {
  const pos = error.linePos?.[0];
  const location = pos ? ` (line ${pos.line}, column ${pos.col})` : "";
  return `YAML syntax error${location}: ${error.message}`;
}

/** YAML の構文エラーをファイル名・位置付きのメッセージに整形して ParseError を投げる */
function toParseError(error: unknown, filePath?: string): ParseError {
  if (error instanceof YAMLParseError) {
    return new ParseError(formatYamlSyntaxError(error), filePath);
  }
  if (error instanceof ZodError) {
    return new ParseError(`schema validation failed: ${formatZodError(error)}`, filePath);
  }
  if (error instanceof Error) {
    return new ParseError(error.message, filePath);
  }
  return new ParseError(String(error), filePath);
}

/** 1件の検証issue(klaus validate 向け)。path は zod issue の path をドット区切りにしたもの(ルートは空文字列) */
export interface FlowIssue {
  path: string;
  message: string;
  /** 主要な issue に対してのみ、1行の修正例ヒントを付与する */
  hint?: string;
}

/**
 * zod issue から「例: ...」形式の1行修正ヒントを作る。
 * 対象は主要ケースのみ(未知キー、method 不正/必須、request・ws の排他/どちらか必須、body/graphql の排他、
 * ws の URL スキーム不正、url 欠落、steps 空、step 名重複)。該当しない issue は undefined を返す。
 */
function hintForIssue(issue: ZodError["issues"][number]): string | undefined {
  const path = issue.path;
  const last = path[path.length - 1];
  const parent = path[path.length - 2];

  // strictObject による未知キー検出。typo の可能性があることも合わせて示す
  if (issue.code === "unrecognized_keys") {
    const keys = issue.keys.map((key) => `"${key}"`).join(", ");
    const location = path.length > 0 ? ` at "${path.join(".")}"` : " at the top level";
    return `unknown key(s) ${keys}${location}: check for a typo, or remove the key(s) if unused`;
  }
  // request.method が不正、または graphql 指定なしで method が省略されている場合
  if (last === "method") {
    return "example: method: GET";
  }
  // request.body と request.graphql の排他
  if (last === "graphql" && issue.message.includes("mutually exclusive")) {
    return "example: keep either body or graphql, not both";
  }
  // step.request と step.ws の排他
  if (last === "ws" && issue.message.includes("mutually exclusive")) {
    return "example: keep either request or ws, not both";
  }
  // step.request / step.ws のどちらも指定されていない
  if (last === "request" && issue.message.includes("is required")) {
    return "example: add either request: or ws: to the step";
  }
  // ws.url が ws://・wss:// 以外のスキーム
  if (last === "url" && issue.message.includes("ws:// or wss://")) {
    return 'example: url: "wss://example.com/socket"';
  }
  // url 欠落(request.url / ws.url が未指定)。親キーで request/ws を判別する
  if (last === "url") {
    return parent === "ws"
      ? 'example: url: "wss://example.com/socket"'
      : 'example: url: "https://example.com"';
  }
  // steps が空配列
  if (last === "steps" && issue.code === "too_small") {
    return "example: steps: [{ name: step1, request: { method: GET, url: https://example.com } }]";
  }
  // step 名がフロー内で重複
  if (last === "name" && issue.message.includes("duplicated")) {
    return "example: give this step a unique name, e.g. step2";
  }
  return undefined;
}

/** ZodError を klaus validate 向けの構造化 issue 一覧(path/message/hint)に変換する */
export function describeFlowSchemaIssues(error: ZodError): FlowIssue[] {
  return error.issues.map((issue) => {
    const hint = hintForIssue(issue);
    const path = issue.path.join(".");
    return hint ? { path, message: issue.message, hint } : { path, message: issue.message };
  });
}

/** klaus validate 向けの検証結果(実行なしで検証する。parseFlowYaml と異なり例外を投げない) */
export type FlowValidationResult =
  | { valid: true; flow: Flow }
  | { valid: false; errors: FlowIssue[] };

/** フロー定義 YAML の文字列を実行なしで検証する(構文エラー・スキーマ違反のどちらも構造化して返す) */
export function validateFlowYaml(content: string): FlowValidationResult {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (error) {
    const message =
      error instanceof YAMLParseError
        ? formatYamlSyntaxError(error)
        : error instanceof Error
          ? error.message
          : String(error);
    return { valid: false, errors: [{ path: "", message }] };
  }

  const result = flowSchema.safeParse(raw);
  if (result.success) return { valid: true, flow: result.data };
  return { valid: false, errors: describeFlowSchemaIssues(result.error) };
}

/** フロー定義 YAML ファイルを読み込み、実行なしで検証する(klaus validate から使う。例外を投げない) */
export async function validateFlowFile(filePath: string): Promise<FlowValidationResult> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    return {
      valid: false,
      errors: [
        {
          path: "",
          message: `failed to read file: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  return validateFlowYaml(content);
}

/** フロー定義 YAML の文字列を検証済みの Flow に変換する */
export function parseFlowYaml(content: string, filePath?: string): Flow {
  try {
    const raw: unknown = parseYaml(content);
    return flowSchema.parse(raw);
  } catch (error) {
    throw toParseError(error, filePath);
  }
}

/** 環境ファイル YAML の文字列を検証済みの Environment に変換する */
export function parseEnvironmentYaml(content: string, filePath?: string): Environment {
  try {
    const raw: unknown = parseYaml(content);
    return environmentSchema.parse(raw);
  } catch (error) {
    throw toParseError(error, filePath);
  }
}

/** フロー定義 YAML ファイルを読み込んで検証する */
export async function loadFlow(filePath: string): Promise<Flow> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new ParseError(
      `failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    );
  }
  return parseFlowYaml(content, filePath);
}

/** 環境ファイル YAML を読み込んで検証する */
export async function loadEnvironmentFile(filePath: string): Promise<Environment> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new ParseError(
      `failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    );
  }
  return parseEnvironmentYaml(content, filePath);
}
