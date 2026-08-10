import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  type Document,
  isNode,
  LineCounter,
  parseDocument,
  parse as parseYaml,
  YAMLParseError,
} from "yaml";
import { ZodError } from "zod";
import { ParseError } from "./errors.js";
import {
  type AssertDef,
  type Environment,
  environmentSchema,
  type Flow,
  flowSchema,
  type Step,
} from "./schema.js";

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
  /** issue.path が指す YAML ノードの1始まり行番号。ノードを解決できない場合は付与しない */
  line?: number;
  /** issue.path が指す YAML ノードの1始まり列番号。line と対で付与する */
  column?: number;
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
  // step.use と request/ws/sse の排他(step.request/ws の排他より先に判定する必要がある。
  // どちらのメッセージも "mutually exclusive" を含むため、message の内容で区別する)
  if (last === "use" && issue.message.includes("mutually exclusive")) {
    return "example: keep either use or request/ws/sse, not both";
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

/** describeFlowSchemaIssues で行番号解決に使う、パース済み YAML Document とその LineCounter */
export interface FlowIssueLocationContext {
  document: Document;
  lineCounter: LineCounter;
}

/**
 * zod issue の path から該当する YAML ノードを解決し、1始まりの行・列番号を返す。
 * 完全なパスにノードが無い場合(必須キー欠落など)は、ノードが見つかるまで末尾から
 * セグメントを1つずつ削って親を辿る(= ネストしたパスの解決)。
 * ルートまで辿ってもノードが見つからない場合(空ファイル等)は undefined を返す。
 */
function resolveIssueLocation(
  context: FlowIssueLocationContext,
  path: ZodError["issues"][number]["path"],
): { line: number; column: number } | undefined {
  const { document, lineCounter } = context;
  for (let length = path.length; length >= 0; length--) {
    const prefix = path.slice(0, length);
    let node: unknown;
    try {
      node = document.getIn(prefix, true);
    } catch {
      // 中間ノードの型が想定外(コレクションでない等)で getIn が例外を投げても、
      // 行番号解決は諦めるだけにして呼び出し元には影響させない
      node = undefined;
    }
    if (isNode(node) && node.range) {
      const pos = lineCounter.linePos(node.range[0]);
      return { line: pos.line, column: pos.col };
    }
  }
  return undefined;
}

/** ZodError を klaus validate 向けの構造化 issue 一覧(path/message/hint/line/column)に変換する */
export function describeFlowSchemaIssues(
  error: ZodError,
  locationContext?: FlowIssueLocationContext,
): FlowIssue[] {
  return error.issues.map((issue) => {
    const hint = hintForIssue(issue);
    const path = issue.path.join(".");
    const location = locationContext
      ? resolveIssueLocation(locationContext, issue.path)
      : undefined;
    return {
      path,
      message: issue.message,
      ...(hint ? { hint } : {}),
      ...(location ? { line: location.line, column: location.column } : {}),
    };
  });
}

/** klaus validate 向けの検証結果(実行なしで検証する。parseFlowYaml と異なり例外を投げない) */
export type FlowValidationResult =
  | { valid: true; flow: Flow }
  | { valid: false; errors: FlowIssue[] };

/**
 * フロー定義 YAML の文字列を実行なしで検証する(構文エラー・スキーマ違反のどちらも構造化して返す)。
 * スキーマ違反の issue に行番号を付与するため、parseYaml ではなく parseDocument + LineCounter を使い、
 * 生成した Document から zod issue の path に対応するノードの位置を解決する(二重パースを避けるため
 * parse ではなく parseDocument に一本化している)。
 */
export function validateFlowYaml(content: string): FlowValidationResult {
  const lineCounter = new LineCounter();
  const document = parseDocument(content, { lineCounter });

  const [firstError] = document.errors;
  if (firstError) {
    const message =
      firstError instanceof YAMLParseError ? formatYamlSyntaxError(firstError) : firstError.message;
    return { valid: false, errors: [{ path: "", message }] };
  }

  const raw: unknown = document.toJS();
  const result = flowSchema.safeParse(raw);
  if (result.success) return { valid: true, flow: result.data };
  return {
    valid: false,
    errors: describeFlowSchemaIssues(result.error, { document, lineCounter }),
  };
}

/**
 * フロー定義 YAML ファイルを読み込み、実行なしで検証する(klaus validate から使う。例外を投げない)。
 * スキーマ検証が valid の場合、続けて use ステップの解決(materialize)も試みる。
 * validateFlowYaml と異なりファイルパスを持つため use の相対パス解決が可能。
 */
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

  const result = validateFlowYaml(content);
  if (!result.valid) return result;

  const absolutePath = resolve(filePath);
  try {
    const flow = await materializeFlow(result.flow, absolutePath, new Set([absolutePath]));
    return { valid: true, flow };
  } catch (error) {
    if (error instanceof UseResolutionError) {
      return {
        valid: false,
        errors: [
          {
            path: error.issuePath,
            message: error.message,
            ...(error.hint ? { hint: error.hint } : {}),
          },
        ],
      };
    }
    throw error;
  }
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

/**
 * ステップ参照(`use:`)の解決で発生するエラー。
 * validateFlowFile(構造化 issue を返す。例外を投げない)と loadFlow(ParseError を投げる)の
 * 両方から同じ解決ロジックを再利用できるよう、issue 化に必要な情報(path/hint)を保持しておき、
 * 呼び出し側でそれぞれの契約に変換する。
 */
class UseResolutionError extends Error {
  /** FlowIssue.path 相当(ドット区切り) */
  readonly issuePath: string;
  // exactOptionalPropertyTypes 対応: コンストラクタ引数の「省略」と「明示的な undefined」を
  // 区別しないため、プロパティ型にも | undefined を明示する(errors.ts の ParseError と同じ流儀)
  readonly hint?: string | undefined;

  constructor(message: string, issuePath: string, hint?: string) {
    super(message);
    this.name = "UseResolutionError";
    this.issuePath = issuePath;
    this.hint = hint;
  }
}

/** assert の配列フィールド(headers/body/events/messages)。参照先を先に、呼び出し側を後に連結する */
function mergeAssertArrayField<T>(
  referenced: T[] | undefined,
  caller: T[] | undefined,
): T[] | undefined {
  if (referenced === undefined && caller === undefined) return undefined;
  return [...(referenced ?? []), ...(caller ?? [])];
}

/**
 * 参照先ステップの assert と呼び出し側ステップの assert を加算マージする。
 * - 配列フィールド(headers/body/events/messages): 参照先→呼び出し側の順に連結する
 * - スカラー・単一オブジェクトフィールド(status/bodyText/duration/eventCount/messageCount/bodySchema):
 *   両方で定義されていたら「単体チェックの保証を弱める置換」とみなし、フィールド名を conflicts に集める
 *   (この場合 assert は返さない。呼び出し側で FlowIssue に変換する)
 */
function mergeAssert(
  referenced: AssertDef | undefined,
  caller: AssertDef | undefined,
): { assert?: AssertDef; conflicts: string[] } {
  if (referenced === undefined && caller === undefined) {
    return { conflicts: [] };
  }

  const conflicts: string[] = [];
  if (referenced?.status !== undefined && caller?.status !== undefined) conflicts.push("status");
  if (referenced?.bodyText !== undefined && caller?.bodyText !== undefined) {
    conflicts.push("bodyText");
  }
  if (referenced?.duration !== undefined && caller?.duration !== undefined) {
    conflicts.push("duration");
  }
  if (referenced?.eventCount !== undefined && caller?.eventCount !== undefined) {
    conflicts.push("eventCount");
  }
  if (referenced?.messageCount !== undefined && caller?.messageCount !== undefined) {
    conflicts.push("messageCount");
  }
  if (referenced?.bodySchema !== undefined && caller?.bodySchema !== undefined) {
    conflicts.push("bodySchema");
  }
  if (conflicts.length > 0) {
    return { conflicts };
  }

  const headers = mergeAssertArrayField(referenced?.headers, caller?.headers);
  const body = mergeAssertArrayField(referenced?.body, caller?.body);
  const events = mergeAssertArrayField(referenced?.events, caller?.events);
  const messages = mergeAssertArrayField(referenced?.messages, caller?.messages);
  const status = referenced?.status ?? caller?.status;
  const bodyText = referenced?.bodyText ?? caller?.bodyText;
  const duration = referenced?.duration ?? caller?.duration;
  const eventCount = referenced?.eventCount ?? caller?.eventCount;
  const messageCount = referenced?.messageCount ?? caller?.messageCount;
  const bodySchema = referenced?.bodySchema ?? caller?.bodySchema;

  const assert: AssertDef = {
    ...(headers !== undefined ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(events !== undefined ? { events } : {}),
    ...(messages !== undefined ? { messages } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(bodyText !== undefined ? { bodyText } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(eventCount !== undefined ? { eventCount } : {}),
    ...(messageCount !== undefined ? { messageCount } : {}),
    ...(bodySchema !== undefined ? { bodySchema } : {}),
  };
  return { assert, conflicts: [] };
}

/**
 * 1件の `use:` ステップを解決し、参照先ファイルの唯一のステップから request/sse を、
 * assert を加算マージして取り込んだ通常ステップを返す(name/capture は呼び出し側のまま)。
 * - パスはフローファイル基準の相対パス。絶対パスは拒否する
 * - 解決後のパスが process.cwd() の外に出る場合は拒否する(既存の信頼境界の思想を踏襲)
 * - 参照先が存在しない/YAML・スキーマ不正/ステップが1件でない場合は拒否する
 * - 参照先ステップがさらに use を持つ場合は再帰的に解決する。visited(呼び出し元から
 *   このステップまでの参照チェーン)に同じ絶対パスが既にあれば循環参照として拒否する
 * - 参照先の env は取り込まない(ステップのみ)
 */
async function resolveUseStep(
  step: Step,
  useTarget: string,
  filePath: string,
  stepIndex: number,
  visited: Set<string>,
): Promise<Step> {
  const issuePath = `steps.${stepIndex}.use`;

  if (isAbsolute(useTarget)) {
    throw new UseResolutionError(
      `step.use must be a path relative to the flow file (got an absolute path: "${useTarget}")`,
      issuePath,
      "example: use: ../api/login-check.yaml",
    );
  }

  const resolvedPath = resolve(dirname(filePath), useTarget);
  const cwd = resolve(process.cwd());
  const boundary = cwd.endsWith(sep) ? cwd : cwd + sep;
  if (resolvedPath !== cwd && !resolvedPath.startsWith(boundary)) {
    throw new UseResolutionError(
      `step.use resolves outside the project directory: "${useTarget}"`,
      issuePath,
      "example: keep use: targets inside the project directory (no ../ escaping the project root)",
    );
  }

  if (visited.has(resolvedPath)) {
    throw new UseResolutionError(
      `circular step.use reference detected: "${useTarget}"`,
      issuePath,
      "example: remove the circular use: reference",
    );
  }

  let referencedContent: string;
  try {
    referencedContent = await readFile(resolvedPath, "utf-8");
  } catch (error) {
    throw new UseResolutionError(
      `step.use target not found: "${useTarget}" (${error instanceof Error ? error.message : String(error)})`,
      issuePath,
      "example: check the path is correct and relative to this flow file",
    );
  }

  let referencedFlow: Flow;
  try {
    referencedFlow = parseFlowYaml(referencedContent, resolvedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UseResolutionError(`step.use target is invalid: ${message}`, issuePath);
  }

  if (referencedFlow.steps.length !== 1) {
    throw new UseResolutionError(
      `step.use target must contain exactly one step (got ${referencedFlow.steps.length}): "${useTarget}"`,
      issuePath,
      "example: use: only supports single-step flow files",
    );
  }

  const nextVisited = new Set(visited);
  nextVisited.add(resolvedPath);
  let resolvedReferencedFlow: Flow;
  try {
    resolvedReferencedFlow = await materializeFlow(referencedFlow, resolvedPath, nextVisited);
  } catch (error) {
    // 参照先ファイルの入れ子 use 解決で発生したエラーは、参照先ファイル基準の issuePath を
    // 持ったまま投げられてくる。呼び出し側(このステップ)の issuePath に付け替え、
    // message に実際に問題が起きたファイルパス(cwd 相対)を含めて再 throw することで、
    // エントリファイル基準の path と実ファイル名の両方を検証結果に残す
    if (error instanceof UseResolutionError) {
      const relativeReferencedPath = relative(cwd, resolvedPath) || resolvedPath;
      throw new UseResolutionError(
        `${error.message} (in "${relativeReferencedPath}")`,
        issuePath,
        error.hint,
      );
    }
    throw error;
  }
  // steps.length === 1 は直前で検証済み
  const referencedStep = resolvedReferencedFlow.steps[0] as Step;

  if (referencedStep.request === undefined) {
    throw new UseResolutionError(
      `step.use target must be an HTTP request step (ws steps are not supported): "${useTarget}"`,
      issuePath,
    );
  }

  const { assert: mergedAssert, conflicts } = mergeAssert(referencedStep.assert, step.assert);
  if (conflicts.length > 0) {
    throw new UseResolutionError(
      `step.assert conflicts with the use target's assert on: ${conflicts.join(", ")} ` +
        "(a caller-side assert cannot replace the referenced step's assert; remove the duplicated field from either side)",
      `steps.${stepIndex}.assert`,
    );
  }

  return {
    name: step.name,
    request: referencedStep.request,
    ...(referencedStep.sse !== undefined ? { sse: referencedStep.sse } : {}),
    ...(step.capture !== undefined ? { capture: step.capture } : {}),
    ...(mergedAssert !== undefined ? { assert: mergedAssert } : {}),
  };
}

/**
 * フロー内の `use:` ステップをすべて解決し、通常ステップに展開(materialize)した Flow を返す。
 * use を持たないステップはそのまま。loadFlow / validateFlowFile の両方から呼ばれる
 * (validateFlowYaml は filePath を持たないため対象外)。
 */
async function materializeFlow(flow: Flow, filePath: string, visited: Set<string>): Promise<Flow> {
  const steps: Step[] = [];
  for (let index = 0; index < flow.steps.length; index++) {
    const step = flow.steps[index] as Step;
    if (step.use === undefined) {
      steps.push(step);
      continue;
    }
    steps.push(await resolveUseStep(step, step.use, filePath, index, visited));
  }
  return { ...flow, steps };
}

/** フロー定義 YAML ファイルを読み込んで検証する(use ステップは参照先ファイルから展開して解決する) */
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
  const flow = parseFlowYaml(content, filePath);

  const absolutePath = resolve(filePath);
  try {
    return await materializeFlow(flow, absolutePath, new Set([absolutePath]));
  } catch (error) {
    if (error instanceof UseResolutionError) {
      throw new ParseError(error.message, filePath);
    }
    throw error;
  }
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
