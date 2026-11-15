/**
 * klaus mcp が公開するツールの定義とハンドラ。
 * MCP の SDK には依存しない(SDK への登録・結果の直列化・エラーの写し替えは server.ts が行う)ので、
 * ハンドラは `(args, ctx)` の純粋な非同期関数として単体でテストできる。
 *
 * 守る原則(MCP はエージェントが操作する経路なので、CLI より厳しくする):
 * - 送信は core の安全柵を必ず通す。guard は klaus.config.yaml からだけ(呼び出しごとに読み直す)。allowProtected は渡さない
 * - 出力のマスクは常にオン(実行中に集めた secrets + Cookie ヘッダー)。履歴は常に記録する
 * - 書き込み(klaus_promote / klaus_snapshot_accept)は UI サーバーと同じ厳しい規則(新規ファイルのみ・許可された場所のみ・
 *   承認待ちの組のみ・保護環境は拒否)。実体は Hono 非依存の共有関数に置いてあり、ここでは再実装しない
 * - フローのパスは cwd 配下(シンボリックリンク解決後も)の .yaml / .yml に限る
 */
import { z } from "zod";
import { detectActor, MAX_ACTOR_NAME_LENGTH, resolveGitState } from "../cli/audit.js";
import { loadCliConfig, loadHttpOptions, resolveGuardOptions } from "../cli/config.js";
import { getProtectedMode } from "../core/env.js";
import {
  DEFAULT_IGNORED_HEADERS,
  type DryRunResult,
  diffRuns,
  dryRunLoadedFlows,
  errorCodeOf,
  exceedsDepth,
  executeSingleRequest,
  expandSecretVariants,
  type FlowResult,
  formatZodError,
  type GuardOptions,
  getHistoryPage,
  HISTORY_ENTRY_STATUSES,
  type HistoryActor,
  type HistoryEntry,
  type HttpConfig,
  type JsonPathPattern,
  KlausError,
  listSnapshotMismatches,
  loadEnvironmentFile,
  loadFlow,
  MAX_JSON_BODY_DEPTH,
  maskDeep,
  OpenApiValidator,
  parseJsonPathPattern,
  type RunResult,
  readAllHistoryEntries,
  requestSchema,
  resolveEnvironmentPath,
  resolveHistoryEntryStatus,
  resolveRunRef,
  runLoadedFlows,
  type StepResult,
  selectRunEntries,
  toDisplayPath,
  validateFlowFile,
} from "../core/index.js";
import { promoteHistoryToFile } from "../server/promote-write.js";
import { listEnvironments } from "../server/routes/environments.js";
import { listFlows } from "../server/routes/flows.js";
import { stripSnapshotCandidates } from "../server/routes/history.js";
import { MAX_PROMOTE_RUNS } from "../server/routes/history-promote.js";
import { acceptPendingSnapshot, findAcceptRefusal } from "../server/routes/snapshots.js";
import {
  ENV_NAME_PATTERN,
  hasControlCharacter,
  RUN_ID_PATTERN,
  resolveWithinCwd,
} from "../server/validation.js";
import {
  InvalidPathError,
  type PathSegment,
  parseHistoryPath,
  selectHistoryPath,
} from "./history-path.js";
import { ToolError, type ToolOutcome, toFailure } from "./result.js";

/** ハンドラが受け取る呼び出しごとの文脈 */
export interface ToolContext {
  /** プロジェクトのディレクトリ(process.cwd())。フロー・環境・履歴・設定の基準 */
  cwd: string;
  /** --read-only で起動したか(書き込みツールは登録されないが、ハンドラ側でも拒否する) */
  readOnly: boolean;
  /** initialize で名乗った MCP クライアントの名前。履歴の actor.name に使う */
  clientName?: string | undefined;
}

/** MCP のツール注釈(SDK の ToolAnnotations のうち使うもの) */
export interface ToolAnnotationValues {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotationValues;
  /** ファイルを書くツールか。--read-only では登録しない */
  write: boolean;
  /** 送信・書き込みを伴うため、サーバー側で直列キューを通すか */
  serialize: boolean;
  // メソッド記法にして引数を双変にする(ツールごとの引数型を ToolDefinition の配列にまとめて入れるため)
  handler(args: z.infer<S>, ctx: ToolContext): Promise<ToolOutcome>;
}

const ok = (data: unknown): ToolOutcome => ({ ok: true, data });

// ---------------------------------------------------------------------------
// 共通の検証・補助
// ---------------------------------------------------------------------------

const MAX_FILE_LENGTH = 512;
const MAX_FLOW_NAME_LENGTH = 256;
const MAX_NAME_LENGTH = 128;
const MAX_IGNORE_PATHS = 20;
/** klaus diff の既定と同じ、1 ステップ・1 セクションあたりに保持する差分の最大数 */
const MAX_DIFFERENCES = 50;
const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;
const YAML_FILE = /\.ya?ml$/i;

/**
 * エラーメッセージをエージェントへ返せる形にする。
 * - YAML の構文エラーはソース行の抜粋(空行のあとに続く)を含むことがあり、cwd 内の任意のファイルの内容が
 *   エラー経由で漏れ得るため、最初の段落だけを返す
 * - cwd の絶対パスは相対パスにする
 */
function scrubMessage(message: string, cwd: string): string {
  const firstParagraph = message.split("\n\n")[0] ?? message;
  return firstParagraph.split(`${cwd}/`).join("").split(cwd).join(".");
}

/** 期待される失敗(定義・設定・環境ファイルのエラーなど core の KlausError)を ToolError にする。それ以外は undefined */
function asExpectedFailure(error: unknown, cwd: string): ToolError | undefined {
  if (error instanceof ToolError) return error;
  if (error instanceof KlausError) {
    const errorCode = errorCodeOf(error);
    return new ToolError(scrubMessage(error.message, cwd), {
      ...(errorCode !== undefined ? { errorCode } : {}),
    });
  }
  return undefined;
}

/** ハンドラ内で投げられた期待される失敗を ToolFailure に変換する。予期しない例外はそのまま投げる(server.ts が扱う) */
function guarded<A>(
  handler: (args: A, ctx: ToolContext) => Promise<ToolOutcome>,
): (args: A, ctx: ToolContext) => Promise<ToolOutcome> {
  return async (args, ctx) => {
    try {
      return await handler(args, ctx);
    } catch (error) {
      const expected = asExpectedFailure(error, ctx.cwd);
      if (expected !== undefined) return toFailure(expected);
      throw error;
    }
  };
}

/** フローのパス(cwd 相対)を検証して絶対パスにする。cwd の外・.yaml/.yml 以外は拒否する */
function resolveFlowFile(cwd: string, file: string): { abs: string; display: string } {
  if (file.length === 0 || file.length > MAX_FILE_LENGTH || hasControlCharacter(file)) {
    throw new ToolError("file is invalid");
  }
  // UI サーバーと同じ境界判定(.. ・絶対パス・シンボリックリンク経由で cwd の外へ出るものを拒否)
  const abs = resolveWithinCwd(cwd, file);
  if (abs === null) {
    throw new ToolError(
      "refused: the file resolves outside the project directory (path traversal detected)",
      {
        errorCode: "guard.path",
        hint: "Only files inside the project directory can be used.",
      },
    );
  }
  // YAML ではないファイルを読ませると、構文エラー経由で内容が漏れ得るため、フロー定義の拡張子だけを受け付ける
  if (!YAML_FILE.test(abs)) {
    throw new ToolError("file must be a flow definition ending with .yaml or .yml", {
      errorCode: "guard.path",
    });
  }
  return { abs, display: toDisplayPath(cwd, abs) };
}

function validateEnvName(env: string | undefined): string | undefined {
  if (env === undefined) return undefined;
  if (!ENV_NAME_PATTERN.test(env)) {
    throw new ToolError("env is invalid (letters, digits, underscores and hyphens only)");
  }
  return env;
}

function validateRunId(value: string, label = "runId"): string {
  if (!RUN_ID_PATTERN.test(value)) throw new ToolError(`${label} is not a valid run ID`);
  return value;
}

function validateFlowName(flow: string | undefined): string | undefined {
  if (flow === undefined) return undefined;
  if (flow.length === 0 || flow.length > MAX_FLOW_NAME_LENGTH || hasControlCharacter(flow)) {
    throw new ToolError("flow is invalid");
  }
  return flow;
}

function assertWritable(ctx: ToolContext): void {
  if (ctx.readOnly) {
    throw new ToolError("klaus mcp was started with --read-only; this tool is disabled", {
      hint: "Ask the user to restart klaus mcp without --read-only if this write is intended.",
    });
  }
}

/** 安全柵の拒否に付ける案内。拒否は上書きできないので、回避せず利用者に伝えるよう促す */
function guardHint(errorCode: string | undefined): string | undefined {
  switch (errorCode) {
    case "guard.allowed-hosts":
      return "The destination is not in guard.allowedHosts of klaus.config.yaml. Do not try to work around this; tell the user, who can edit the configuration if the host should be allowed.";
    case "guard.protected":
    case "guard.readonly":
    case "guard.method-override":
      return "The selected environment is protected and klaus mcp has no option to override that. Do not try to work around this; tell the user, who can run `klaus run --allow-protected` from a terminal if it is intended.";
    default:
      return errorCode?.startsWith("guard.") === true
        ? "This is a safety guard refusal and klaus mcp has no option to override it. Do not try to work around it; tell the user."
        : undefined;
  }
}

interface Settings {
  guard: GuardOptions | undefined;
  http: HttpConfig | undefined;
  openapi: string[];
}

/**
 * klaus.config.yaml を毎回読み直し、guard / http / run.openapi を取り出す(編集が再起動なしで効くように)。
 * 読めない・不正な設定のまま送信すると guard を外した状態になり得るため、エラーにして何も送らない。
 */
async function loadSettings(cwd: string): Promise<Settings> {
  const config = await loadCliConfig(cwd);
  const http = await loadHttpOptions(cwd);
  const openapi = config?.run?.openapi;
  return {
    guard: resolveGuardOptions(config),
    http,
    openapi: openapi === undefined ? [] : Array.isArray(openapi) ? openapi : [openapi],
  };
}

function sanitizeActorName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const cleaned = [...name]
    .filter((char) => !hasControlCharacter(char))
    .join("")
    .trim()
    .slice(0, MAX_ACTOR_NAME_LENGTH);
  return cleaned === "" ? undefined : cleaned;
}

/**
 * 履歴の actor を決める。kind は常に agent。name は「initialize で名乗った MCP クライアント名」を最優先し、
 * 無ければ環境変数のマーカー(CLAUDECODE / AI_AGENT)から推定したエージェント名、それも無ければ "mcp"。
 * クライアントが自己申告する名前は信頼境界の外だが、履歴の補助情報にすぎず(制御文字は除く・長さは制限)、
 * 実行の可否には使わない。
 */
export function resolveMcpActor(
  clientName: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HistoryActor {
  const fromClient = sanitizeActorName(clientName);
  if (fromClient !== undefined) return { kind: "agent", name: fromClient };
  const detected = detectActor(env);
  return {
    kind: "agent",
    name: detected.kind === "agent" && detected.name !== undefined ? detected.name : "mcp",
  };
}

/** 結果の file(cwd からの絶対パス)を、絶対パスを出さないよう cwd 相対にする */
function relativizeFlowFiles<T extends { file: string }>(flows: T[], cwd: string): T[] {
  return flows.map((flow) => ({ ...flow, file: toDisplayPath(cwd, flow.file) }));
}

async function loadFlowOrFail(abs: string, cwd: string) {
  try {
    return await loadFlow(abs);
  } catch (error) {
    const expected = asExpectedFailure(error, cwd);
    if (expected === undefined) throw error;
    throw new ToolError(`flow definition error: ${expected.message}`, {
      hint: "Fix the flow file (klaus_validate_flow shows the details).",
    });
  }
}

// ---------------------------------------------------------------------------
// 結果の整形
// ---------------------------------------------------------------------------

function summarizeStep(step: StepResult, runId: string) {
  const failures = step.assertions
    .filter(
      (assertion) =>
        !assertion.ok && assertion.snapshot === undefined && assertion.openapi === undefined,
    )
    .map((assertion) => ({
      kind: assertion.kind,
      message: assertion.message,
      ...(assertion.expected !== undefined ? { expected: assertion.expected } : {}),
      ...(assertion.actual !== undefined ? { actual: assertion.actual } : {}),
    }));
  const snapshot = step.assertions.find((assertion) => assertion.snapshot !== undefined)?.snapshot;
  const openapi = step.assertions.find((assertion) => assertion.openapi !== undefined)?.openapi;
  return {
    name: step.name,
    status: step.status,
    durationMs: Math.round(step.durationMs),
    ...(step.request !== undefined ? { method: step.request.method, url: step.request.url } : {}),
    ...(step.response !== undefined ? { httpStatus: step.response.status } : {}),
    ...(step.attempts !== undefined ? { attempts: step.attempts } : {}),
    ...(step.error !== undefined ? { error: step.error } : {}),
    ...(step.errorCode !== undefined ? { errorCode: step.errorCode } : {}),
    // 履歴に実際に記録されたステップにだけ、klaus_history_show へ渡す引数を付ける(記録されない実行時エラーに付けると引けない)
    ...(step.historyRecorded === true ? { historyRef: { runId, step: step.name } } : {}),
    assertions: { total: step.assertions.length, failed: failures },
    // candidate(応答全体のコピー)は含めない。承認は klaus_snapshot_accept が履歴から読む
    ...(snapshot !== undefined
      ? {
          snapshot: {
            state: snapshot.state,
            key: snapshot.key,
            file: snapshot.file,
            ...(snapshot.differenceCount !== undefined
              ? { differenceCount: snapshot.differenceCount }
              : {}),
            ...(snapshot.differences !== undefined ? { differences: snapshot.differences } : {}),
          },
        }
      : {}),
    ...(openapi !== undefined ? { openapi } : {}),
  };
}

function summarizeFlowResult(flow: FlowResult, runId: string) {
  return {
    name: flow.name,
    file: flow.file,
    status: flow.status,
    ...(flow.iteration !== undefined ? { iteration: flow.iteration } : {}),
    durationMs: Math.round(flow.durationMs),
    steps: flow.steps.map((step) => summarizeStep(step, runId)),
  };
}

function summarizeRunResult(result: RunResult, cwd: string) {
  return {
    runId: result.runId,
    status: result.status,
    durationMs: Math.round(result.durationMs),
    flows: relativizeFlowFiles(result.flows, cwd).map((flow) =>
      summarizeFlowResult(flow, result.runId),
    ),
    ...(result.warnings !== undefined ? { warnings: result.warnings } : {}),
    ...(result.snapshots !== undefined ? { snapshots: result.snapshots } : {}),
    ...(result.openapi !== undefined ? { openapi: result.openapi } : {}),
  };
}

function summarizeDryRun(result: DryRunResult, cwd: string) {
  const steps = result.flows.flatMap((flow) => flow.steps);
  return {
    summary: {
      steps: steps.length,
      allowed: steps.filter((step) => step.guard.status === "allowed").length,
      refused: steps.filter((step) => step.guard.status === "refused").length,
      undetermined: steps.filter((step) => step.guard.status === "undetermined").length,
      expansionErrors: steps.filter((step) => step.error !== undefined).length,
    },
    flows: relativizeFlowFiles(result.flows, cwd),
  };
}

function summarizeHistoryEntry(entry: HistoryEntry) {
  const failedAssertions = entry.assertions.filter((assertion) => !assertion.ok).length;
  return {
    startedAt: entry.startedAt,
    runId: entry.runId,
    flow: entry.flow,
    step: entry.step,
    status: resolveHistoryEntryStatus(entry),
    durationMs: Math.round(entry.durationMs),
    ...(entry.iteration !== undefined ? { iteration: entry.iteration } : {}),
    ...(entry.request !== undefined
      ? { method: entry.request.method, url: entry.request.url }
      : {}),
    ...(entry.response !== undefined ? { httpStatus: entry.response.status } : {}),
    ...(failedAssertions > 0 ? { failedAssertions } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
    ...(entry.errorCode !== undefined ? { errorCode: entry.errorCode } : {}),
    ...(entry.env !== undefined ? { env: entry.env } : {}),
    ...(entry.file !== undefined ? { file: entry.file } : {}),
    ...(entry.actor !== undefined ? { actor: entry.actor } : {}),
  };
}

// ---------------------------------------------------------------------------
// 入力スキーマの共通部品
// ---------------------------------------------------------------------------

const fileSchema = z
  .string()
  .describe(
    "Path of a flow definition file relative to the project directory, for example api/users.yaml. Must be a .yaml or .yml file inside the project directory.",
  );

const envSchema = z
  .string()
  .optional()
  .describe(
    "Environment name (environments/<name>.yaml; letters, digits, underscores and hyphens). Omit to use the flow's own env.",
  );

const runIdSchema = (description: string) => z.string().describe(description);

// ---------------------------------------------------------------------------
// ツール定義
// ---------------------------------------------------------------------------

const READ_ONLY_LOCAL: ToolAnnotationValues = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const listFlowsTool: ToolDefinition = {
  name: "klaus_list_flows",
  description:
    "List the flow definition files (YAML) in the project directory with each flow's name and step count. Files that fail schema validation are listed with an error instead. Start here to find flows to validate, dry-run or run. Read-only.",
  inputSchema: z.object({}),
  annotations: READ_ONLY_LOCAL,
  write: false,
  serialize: false,
  handler: guarded(async (_args, ctx) => ok({ flows: await listFlows(ctx.cwd) })),
};

const validateFlowSchema = z.object({ file: fileSchema });
const validateFlowTool: ToolDefinition<typeof validateFlowSchema> = {
  name: "klaus_validate_flow",
  description:
    "Check a flow definition file against the schema without sending anything. Returns valid: true with the flow name and step count, or valid: false with errors (path, message, line, fix hint). Refuses paths outside the project directory and files that are not .yaml/.yml.",
  inputSchema: validateFlowSchema,
  annotations: READ_ONLY_LOCAL,
  write: false,
  serialize: false,
  handler: guarded(async (args, ctx) => {
    const file = resolveFlowFile(ctx.cwd, args.file);
    const result = await validateFlowFile(file.abs);
    if (result.valid) {
      return ok({
        file: file.display,
        valid: true,
        name: result.flow.name,
        steps: result.flow.steps.length,
      });
    }
    return ok({
      file: file.display,
      valid: false,
      errors: result.errors.map((issue) => ({
        ...issue,
        message: scrubMessage(issue.message, ctx.cwd),
      })),
    });
  }),
};

const listEnvironmentsTool: ToolDefinition = {
  name: "klaus_list_environments",
  description:
    "List the environments (environments/<name>.yaml) with their protection mode: none, protected (every request is refused), or readonly (only GET, HEAD and OPTIONS are sent); unknown if the file cannot be read. This tool returns names and protection only. Protection applies to runs that select that environment by name (klaus_run_flow, klaus_dry_run, klaus_request with env); it does not restrict hosts, which is the job of guard.allowedHosts. Read-only.",
  inputSchema: z.object({}),
  annotations: READ_ONLY_LOCAL,
  write: false,
  serialize: false,
  handler: guarded(async (_args, ctx) => {
    const environments = [];
    for (const { name } of await listEnvironments(ctx.cwd)) {
      try {
        const mode = getProtectedMode(
          await loadEnvironmentFile(resolveEnvironmentPath(ctx.cwd, name)),
        );
        environments.push({
          name,
          protection: mode === true ? "protected" : mode === "readonly" ? "readonly" : "none",
        });
      } catch (error) {
        // 保護状態を判定できないものは、保護なしと誤解させないよう unknown にする
        environments.push({
          name,
          protection: "unknown",
          error: scrubMessage(error instanceof Error ? error.message : String(error), ctx.cwd),
        });
      }
    }
    return ok({ environments });
  }),
};

const variablesSchema = z
  .record(z.string(), z.string())
  .optional()
  .describe(
    "Extra template variables (name to value), available as {{name}}. They are NOT masked in output or history, so never put secrets here; reference OS environment variables with {{env.NAME}} in the flow instead.",
  );

const dryRunSchema = z.object({ file: fileSchema, env: envSchema, variables: variablesSchema });
const dryRunTool: ToolDefinition<typeof dryRunSchema> = {
  name: "klaus_dry_run",
  description:
    "Show what a flow would send, without sending anything or writing history: each step's expanded request and the guard decision (allowed, refused with an errorCode, or undetermined when the host depends on an earlier response). Values that come from the selected environment file (including a protected one, and also when the step is refused) are shown expanded in the request; only values the run itself marks as secrets (for example {{env.NAME}} from OS environment variables) are masked. Use it before klaus_run_flow, especially when guard.allowedHosts is set. klaus mcp has no option to override a refused step.",
  inputSchema: dryRunSchema,
  annotations: READ_ONLY_LOCAL,
  write: false,
  serialize: false,
  handler: guarded(async (args, ctx) => {
    const file = resolveFlowFile(ctx.cwd, args.file);
    const env = validateEnvName(args.env);
    const settings = await loadSettings(ctx.cwd);
    const flow = await loadFlowOrFail(file.abs, ctx.cwd);
    const collectedSecrets: string[] = [];
    const result = await dryRunLoadedFlows([{ filePath: file.abs, flow }], {
      cwd: ctx.cwd,
      envNameOverride: env,
      variables: args.variables,
      // allowProtected は渡さない: klaus mcp は保護環境の拒否を上書きできない
      entryPoint: "mcp",
      guard: settings.guard,
      http: settings.http,
      onSecrets: (secrets) => {
        collectedSecrets.push(...secrets);
      },
    });
    const masked = maskDeep(result, expandSecretVariants(collectedSecrets));
    return ok(summarizeDryRun(masked, ctx.cwd));
  }),
};

const runFlowSchema = z.object({
  file: fileSchema,
  env: envSchema,
  variables: variablesSchema,
});
const runFlowTool: ToolDefinition<typeof runFlowSchema> = {
  name: "klaus_run_flow",
  description:
    "Run a flow definition: sends the real HTTP/SSE/WebSocket requests it defines and evaluates assertions, snapshots and OpenAPI validation (run.openapi). Steps that end passed, failed (assertions, snapshot or OpenAPI), or skipped, steps refused by a guard, and steps that received a response and then ended in error (for example a failed capture) are recorded in history; a step that ends with an error before or without a usable response (timeout, connection or mid-body network error, response too large, a template that cannot be expanded) is not recorded. Returns a summary per step (status, HTTP status, error, errorCode, failed assertions, snapshot and OpenAPI results); response bodies are not included. Each recorded step carries historyRef {runId, step} for klaus_history_show; a step without historyRef has no history entry. guard.allowedHosts from klaus.config.yaml applies to every step, and a step is refused when the run selects a protected environment ($protected); klaus mcp has no option to override a refusal, so a refused step is reported with its errorCode: tell the user instead of working around it. A missing snapshot baseline is written; a mismatch is reported, never updated. Steps may change data on the target API.",
  inputSchema: runFlowSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  write: false,
  serialize: true,
  handler: guarded(async (args, ctx) => {
    const file = resolveFlowFile(ctx.cwd, args.file);
    const env = validateEnvName(args.env);
    const settings = await loadSettings(ctx.cwd);
    const flow = await loadFlowOrFail(file.abs, ctx.cwd);
    const git = await resolveGitState(ctx.cwd);

    const collectedSecrets: string[] = [];
    let openapi: OpenApiValidator | undefined;
    let runResult: RunResult;
    try {
      // OpenAPI の検証器はワーカースレッドを持つため、実行の終わり方によらず必ず close する
      openapi =
        settings.openapi.length > 0 ? await OpenApiValidator.load(settings.openapi, {}) : undefined;
      runResult = await runLoadedFlows([{ filePath: file.abs, flow }], {
        cwd: ctx.cwd,
        envNameOverride: env,
        variables: args.variables,
        // allowProtected は渡さない: klaus mcp は保護環境の拒否を上書きできない(拒否メッセージも mcp 向けの案内になる)
        entryPoint: "mcp",
        guard: settings.guard,
        http: settings.http,
        actor: resolveMcpActor(ctx.clientName),
        git,
        history: true,
        // 基準が無ければ書く(対話的な CLI 実行と同じ)。不一致は報告するだけで、自動では更新しない
        snapshots: { update: false, ci: false },
        openapi,
        onWarning: (message) => {
          process.stderr.write(`klaus mcp: warning: ${message}\n`);
        },
        onSecrets: (secrets) => {
          collectedSecrets.push(...secrets);
        },
      });
    } finally {
      openapi?.close();
    }

    if (openapi !== undefined) {
      const summary = openapi.summarize({ partial: false, planned: false });
      const warnings = [...new Set([...(runResult.warnings ?? []), ...openapi.warnings])];
      runResult = {
        ...runResult,
        openapi: summary,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    // 出力は常にマスクする(実行中に集めた secrets + Cookie ヘッダー)。実行がすべて終わった後なので、集め漏れは無い
    const masked = maskDeep(runResult, expandSecretVariants(collectedSecrets));
    return ok(summarizeRunResult(masked, ctx.cwd));
  }),
};

const bodySchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.string(), z.unknown()),
]);

const requestToolSchema = z.object({
  method: z.string().describe("HTTP method, for example GET or POST (case-insensitive)."),
  url: z.string().describe("Request URL. {{...}} placeholders are expanded."),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe("Request headers (name to value). Values are template-expanded."),
  query: z
    .record(z.string(), z.string())
    .optional()
    .describe("Query string parameters merged into the URL (name to value)."),
  body: bodySchema
    .optional()
    .describe(
      `Request body. A string is sent as-is (set Content-Type in headers); an object, array, number, boolean or null is sent as JSON. An object or array nested deeper than ${MAX_JSON_BODY_DEPTH} levels is refused: send it as a string instead.`,
    ),
  env: z
    .string()
    .optional()
    .describe(
      "Environment (environments/<name>.yaml; letters, digits, underscores and hyphens) whose values {{name}} placeholders can use; its protection ($protected) applies to this request. Omit it to use no environment: then {{...}} only resolves from OS environment variables ({{env.NAME}}) and no environment protection applies.",
    ),
});
const requestTool: ToolDefinition<typeof requestToolSchema> = {
  name: "klaus_request",
  description: `Send one ad-hoc HTTP request, record it in history, and return the runId, status, response status, headers and body (secrets masked). Use it to explore an API; turn a good run into a flow with klaus_promote. {{...}} placeholders in url, headers, query and body are expanded from the selected environment (env) and from the OS environment variables of the klaus mcp process ({{env.NAME}}); any such variable can therefore be sent to any host the request is allowed to reach. Without env, no environment protection applies and the request can reach every host that guard.allowedHosts permits (every host if it is not set). A refused request (guard.allowedHosts, or a protected env) or a failed one (connection error, timeout) returns an error with errorCode when there is one; klaus mcp has no option to override a refusal, so tell the user instead of working around it. A response body nested deeper than ${MAX_JSON_BODY_DEPTH} levels is returned as text. HTTP error statuses such as 404 are normal results.`,
  inputSchema: requestToolSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  write: false,
  serialize: true,
  handler: guarded(async (args, ctx) => {
    const env = validateEnvName(args.env);
    // 深すぎる JSON は、マスク・履歴・結果の整形の再帰でスタックを使い果たし得るため、構造化したままでは受け付けない
    if (args.body !== undefined && exceedsDepth(args.body, MAX_JSON_BODY_DEPTH)) {
      throw new ToolError(
        `body is nested deeper than ${MAX_JSON_BODY_DEPTH} levels and is refused`,
        {
          hint: "Send the body as a string (set Content-Type in headers) instead of an object or array.",
        },
      );
    }
    const settings = await loadSettings(ctx.cwd);
    const request = {
      method: args.method,
      url: args.url,
      ...(args.headers !== undefined && Object.keys(args.headers).length > 0
        ? { headers: args.headers }
        : {}),
      ...(args.query !== undefined && Object.keys(args.query).length > 0
        ? { query: args.query }
        : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
    };
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) {
      throw new ToolError(`invalid request: ${formatZodError(parsed.error)}`);
    }

    const git = await resolveGitState(ctx.cwd);
    const collectedSecrets: string[] = [];
    const outcome = await executeSingleRequest({
      request,
      cwd: ctx.cwd,
      envName: env,
      history: true,
      guard: settings.guard,
      http: settings.http,
      // allowProtected を受け取らない単発実行に、mcp 向けの拒否の案内を出させる
      entryPoint: "mcp",
      actor: resolveMcpActor(ctx.clientName),
      git,
      onWarning: (message) => {
        process.stderr.write(`klaus mcp: warning: ${message}\n`);
      },
      onSecrets: (secrets) => {
        collectedSecrets.push(...secrets);
      },
    });
    const result = maskDeep(outcome.result, expandSecretVariants(collectedSecrets));
    const runId = outcome.historyRecorded ? outcome.runId : undefined;

    // 拒否・送信失敗(応答を受け取れなかった)は、この呼び出しの目的そのものが果たせなかったのでツールの失敗にする
    if (result.status === "error") {
      const hint = guardHint(result.errorCode);
      return {
        ok: false,
        error: result.error ?? "the request failed",
        ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
        ...(hint !== undefined ? { hint } : {}),
        ...(runId !== undefined ? { runId } : {}),
      };
    }
    return ok({
      runId: outcome.runId,
      historyRecorded: outcome.historyRecorded,
      status: result.status,
      durationMs: Math.round(result.durationMs),
      ...(result.request !== undefined
        ? { request: { method: result.request.method, url: result.request.url } }
        : {}),
      ...(result.response !== undefined ? { response: result.response } : {}),
      ...(result.redirects !== undefined ? { redirects: result.redirects } : {}),
    });
  }),
};

const historyListSchema = z.object({
  flow: z
    .string()
    .optional()
    .describe("Only entries of this flow name. Single requests use the flow name (single)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_HISTORY_LIMIT)
    .optional()
    .describe(
      `Number of entries to return, newest first (default ${DEFAULT_HISTORY_LIMIT}, max ${MAX_HISTORY_LIMIT}).`,
    ),
  statuses: z
    .array(z.enum(HISTORY_ENTRY_STATUSES))
    .optional()
    .describe("Only entries whose status is one of these (passed, failed, skipped, error)."),
});
const historyListTool: ToolDefinition<typeof historyListSchema> = {
  name: "klaus_history_list",
  description:
    "List recent recorded steps, newest first, as summary rows (runId, flow, step, status, HTTP status, error, errorCode, actor). Request and response bodies and snapshot candidates are omitted; use klaus_history_show for the details of a run. Read-only.",
  inputSchema: historyListSchema,
  annotations: READ_ONLY_LOCAL,
  write: false,
  serialize: false,
  handler: guarded(async (args, ctx) => {
    const flow = validateFlowName(args.flow);
    const limit = Math.min(Math.max(args.limit ?? DEFAULT_HISTORY_LIMIT, 1), MAX_HISTORY_LIMIT);
    const page = await getHistoryPage(ctx.cwd, { flow, limit, statuses: args.statuses });
    return ok({
      entries: page.entries.map(summarizeHistoryEntry),
      hasMore: page.nextBefore !== undefined,
    });
  }),
};

/** path の最大長 */
const MAX_JSON_PATH_LENGTH = 512;
/** offset / length の単位は文字(UTF-16 コード単位)。length の既定値。JSON のエスケープで最大 6 倍になっても結果の上限に収まる大きさ */
const DEFAULT_WINDOW_LENGTH = 32 * 1024;
/** length の最大値(すべて制御文字でも 40000 x 6 バイト + 枠が結果の上限 256 KiB に収まる) */
const MAX_WINDOW_LENGTH = 40_000;

const historyShowSchema = z.object({
  runId: runIdSchema("Run ID, from klaus_run_flow, klaus_request or klaus_history_list."),
  step: z
    .string()
    .optional()
    .describe(
      "Only this step. Snapshot candidates (full response copies) are included only when step is given. Required with path.",
    ),
  path: z
    .string()
    .optional()
    .describe(
      "Path into each selected step entry as stored, returning only that value instead of the whole entry: for example $.response.body, $.response.body.items[0], $.response.headers['content-type'], $.request.url. Only $, .name, ['name'] and [n] are supported (no wildcards, recursive descent, slices, unions or filters). Requires step.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Start of a window, in characters (UTF-16 code units), into the single string value that path selects (for example the text body at $.response.body). Requires path. Read a long value in windows by passing the returned nextOffset.",
    ),
  length: z
    .number()
    .int()
    .min(1)
    .max(MAX_WINDOW_LENGTH)
    .optional()
    .describe(
      `Window size in characters (default ${DEFAULT_WINDOW_LENGTH}, max ${MAX_WINDOW_LENGTH}). Requires path.`,
    ),
});

/** 文字列の [offset, offset+length) を、サロゲートペアを分断しないように切り出す */
function sliceWindow(text: string, offset: number, length: number) {
  const start = Math.min(offset, text.length);
  let end = Math.min(start + length, text.length);
  const last = text.charCodeAt(end - 1);
  // 上位サロゲートで終わるときは 1 文字戻し、ペアの途中で切らない(次の offset がペアの先頭になる)
  if (end < text.length && end - start > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return {
    offset: start,
    length: end - start,
    totalLength: text.length,
    text: text.slice(start, end),
    ...(end < text.length ? { nextOffset: end } : {}),
  };
}

/** path を厳格な最小の構文として分解する(JSONPath のライブラリは使わない)。構文に合わなければ期待される失敗にする */
function parsePathOrFail(path: string): PathSegment[] {
  try {
    return parseHistoryPath(path);
  } catch (error) {
    if (error instanceof InvalidPathError) throw new ToolError(error.message);
    throw error;
  }
}

/** 履歴エントリから path の指す値を取り出す。結果は 0 個か 1 個の値の配列 */
function selectByPath(entry: HistoryEntry, segments: PathSegment[]): unknown[] {
  const selected = selectHistoryPath(entry, segments);
  return selected.found ? [selected.value] : [];
}

const historyShowTool: ToolDefinition<typeof historyShowSchema> = {
  name: "klaus_history_show",
  description:
    "Return the recorded entries of one run in execution order: request, response (status, headers, body), assertions, error, actor. Secrets are masked as stored. Pass step to narrow to one step; only then are snapshot candidates included. When the result exceeds 256 KiB, large values are cut with a marker; to read such a value, pass step and path (a path into the entry such as $.response.body or $.response.body.items[0]; only $, .name, ['name'] and [n] are supported) to get only that value, and for a long string add offset and length to read it in windows (each window result carries totalLength and nextOffset). A body nested deeper than 200 levels is stored as text. Read-only.",
  inputSchema: historyShowSchema,
  annotations: READ_ONLY_LOCAL,
  write: false,
  serialize: false,
  handler: guarded(async (args, ctx) => {
    const runId = validateRunId(args.runId);
    if (args.step !== undefined && (args.step.length === 0 || hasControlCharacter(args.step))) {
      throw new ToolError("step is invalid");
    }
    const windowed = args.offset !== undefined || args.length !== undefined;
    if (args.path === undefined && windowed) {
      throw new ToolError("offset and length require path");
    }
    if (args.path !== undefined) {
      if (args.step === undefined) throw new ToolError("path requires step");
      if (
        args.path.length === 0 ||
        args.path.length > MAX_JSON_PATH_LENGTH ||
        hasControlCharacter(args.path)
      ) {
        throw new ToolError("path is invalid");
      }
      // 構文は履歴を読む前に確かめる(不正な path で履歴の読み込みをしない)
      parsePathOrFail(args.path);
    }
    const all = selectRunEntries(await readAllHistoryEntries(ctx.cwd), runId);
    const entries = all.filter((entry) => args.step === undefined || entry.step === args.step);
    if (entries.length === 0) {
      const suffix = args.step !== undefined ? ` (step "${args.step}")` : "";
      throw new ToolError(`no history entries found for runId "${runId}"${suffix}`);
    }

    const path = args.path;
    const segments = path === undefined ? undefined : parsePathOrFail(path);
    if (path === undefined || segments === undefined) {
      return ok({
        runId,
        entries: args.step !== undefined ? entries : entries.map(stripSnapshotCandidates),
      });
    }

    // path 指定: 一致した値だけを返す。offset / length を指定したときは、単一の文字列の値の一部だけを返す
    const selected = entries.map((entry) => {
      const matches = selectByPath(entry, segments);
      const label = {
        ...(entry.iteration !== undefined ? { iteration: entry.iteration } : {}),
        matchCount: matches.length,
      };
      if (!windowed) return { ...label, matches };
      const [value] = matches;
      if (matches.length !== 1 || typeof value !== "string") {
        throw new ToolError(
          `offset and length need path to select exactly one string value, but it matched ${matches.length} value(s)${matches.length === 1 ? ` of type ${value === null ? "null" : typeof value}` : ""}`,
          {
            hint: "Point path at a single string, for example $.response.body when the body is text.",
          },
        );
      }
      return {
        ...label,
        window: sliceWindow(value, args.offset ?? 0, args.length ?? DEFAULT_WINDOW_LENGTH),
      };
    });
    return ok({ runId, step: args.step, path, entries: selected });
  }),
};

const diffRunsSchema = z.object({
  a: runIdSchema('First run: a run ID, or "latest" / "previous" (these require flow).'),
  b: runIdSchema('Second run: a run ID, or "latest" / "previous" (these require flow).'),
  flow: z
    .string()
    .optional()
    .describe('Flow name. Required for "latest" / "previous"; limits the comparison to this flow.'),
  ignorePaths: z
    .array(z.string())
    .max(MAX_IGNORE_PATHS)
    .optional()
    .describe(
      "JSONPaths to exclude from body comparisons, for example $.id, $.items[*].createdAt or $..updatedAt.",
    ),
  ignoreHeaders: z
    .array(z.string())
    .optional()
    .describe(
      "Response header names to exclude in addition to the default volatile ones (date, age, request ids, ...).",
    ),
});
const diffRunsTool: ToolDefinition<typeof diffRunsSchema> = {
  name: "klaus_diff_runs",
  description:
    "Compare two recorded runs step by step: status, HTTP status, response headers, request changes and body differences (at most 50 per step and section). Use it to find what changed between two runs of the same flow, for example before and after a deployment. Secrets are stored masked, so a changed secret value is not visible. Read-only.",
  inputSchema: diffRunsSchema,
  annotations: READ_ONLY_LOCAL,
  write: false,
  serialize: false,
  handler: guarded(async (args, ctx) => {
    const refA = validateRunId(args.a, "a");
    const refB = validateRunId(args.b, "b");
    const flow = validateFlowName(args.flow);
    for (const ref of [refA, refB]) {
      if ((ref === "latest" || ref === "previous") && flow === undefined) {
        throw new ToolError(`"${ref}" requires flow`);
      }
    }
    const ignorePaths: JsonPathPattern[] = [];
    for (const source of args.ignorePaths ?? []) {
      const pattern = parseJsonPathPattern(source);
      if (!pattern) {
        throw new ToolError(
          `invalid ignorePaths entry "${source.slice(0, 80)}" (expected a JSONPath such as $.data.id, $.items[*].createdAt, or $..updatedAt)`,
        );
      }
      ignorePaths.push(pattern);
    }

    const entries = await readAllHistoryEntries(ctx.cwd);
    const resolvedA = resolveRunRef(entries, refA, flow);
    if (!resolvedA.ok) throw new ToolError(resolvedA.message);
    const resolvedB = resolveRunRef(entries, refB, flow);
    if (!resolvedB.ok) throw new ToolError(resolvedB.message);
    const entriesA = selectRunEntries(entries, resolvedA.runId, flow);
    const entriesB = selectRunEntries(entries, resolvedB.runId, flow);
    if (entriesA.length === 0 || entriesB.length === 0) {
      const missing = entriesA.length === 0 ? resolvedA.runId : resolvedB.runId;
      throw new ToolError(`run "${missing}" has no entries for flow "${flow}"`);
    }
    return ok(
      diffRuns(
        { runId: resolvedA.runId, entries: entriesA },
        { runId: resolvedB.runId, entries: entriesB },
        {
          ignoreHeaders: [...DEFAULT_IGNORED_HEADERS, ...(args.ignoreHeaders ?? [])],
          ignorePaths,
          maxDifferences: MAX_DIFFERENCES,
        },
      ),
    );
  }),
};

const snapshotListSchema = z.object({
  runId: runIdSchema("Run ID, from klaus_run_flow or klaus_history_list."),
});
const snapshotListTool: ToolDefinition<typeof snapshotListSchema> = {
  name: "klaus_snapshot_list",
  description:
    "List the snapshot assertions of a run that are waiting for approval (a mismatch against the stored baseline, or a missing baseline that was not written) with their differences, and acceptRefusal when they cannot be accepted through klaus mcp (protected environment). Accepting a mismatch replaces a baseline that a human may rely on, so ask the user before calling klaus_snapshot_accept. Read-only.",
  inputSchema: snapshotListSchema,
  annotations: READ_ONLY_LOCAL,
  write: false,
  serialize: false,
  handler: guarded(async (args, ctx) => {
    const runId = validateRunId(args.runId);
    const entries = selectRunEntries(await readAllHistoryEntries(ctx.cwd), runId);
    if (entries.length === 0) {
      throw new ToolError(`no history entries found for runId "${runId}"`);
    }
    const mismatches = await listSnapshotMismatches(ctx.cwd, runId);
    const refusal = mismatches.length > 0 ? await findAcceptRefusal(ctx.cwd, entries) : undefined;
    return ok({
      runId,
      mismatches,
      ...(refusal !== undefined ? { acceptRefusal: refusal } : {}),
    });
  }),
};

const promoteSchema = z.object({
  runIds: z
    .array(z.string())
    .min(1)
    .max(MAX_PROMOTE_RUNS)
    .describe("Run IDs to turn into one flow, in order (from klaus_request or klaus_run_flow)."),
  out: z
    .string()
    .describe(
      "Output path relative to the project directory, ending with .yaml or .yml, in api/, flows/, or a directory that already contains flow files. An existing file is never overwritten.",
    ),
  name: z
    .string()
    .optional()
    .describe("Name of the generated flow. Defaults to the recorded flow name or the host."),
});
const promoteTool: ToolDefinition<typeof promoteSchema> = {
  name: "klaus_promote",
  description:
    "Write a NEW flow file from recorded runs (the request/response pairs in history), with status and response-schema assertions. Secrets and token-like values are replaced by TODO_* placeholders read from OS environment variables ({{env.TODO_...}}); the result lists them so the user can fill them in. Refuses: existing files (never overwritten), locations outside api/, flows/ or a flow directory, non-.yaml names, recorded values containing a literal {{, masked values it cannot reproduce. Not available with --read-only.",
  inputSchema: promoteSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  write: true,
  serialize: true,
  handler: guarded(async (args, ctx) => {
    assertWritable(ctx);
    const runIds = args.runIds.map((runId) => validateRunId(runId));
    if (args.name !== undefined) {
      if (
        args.name.length === 0 ||
        args.name.length > MAX_NAME_LENGTH ||
        hasControlCharacter(args.name)
      ) {
        throw new ToolError("name is invalid");
      }
    }
    const outcome = await promoteHistoryToFile(ctx.cwd, {
      runIds,
      assert: "schema",
      chain: true,
      ...(args.name !== undefined ? { name: args.name } : {}),
      out: args.out,
      dryRun: false,
    });
    if (!outcome.ok) {
      switch (outcome.kind) {
        case "forbidden":
          throw new ToolError(outcome.message.replace(/^Forbidden: /, ""), {
            errorCode: "guard.path",
            hint: "Use a new .yaml path in api/, flows/, or a directory that already contains flow files.",
          });
        case "conflict":
          throw new ToolError(
            `"${args.out}" cannot be written: it already exists or a parent path is not a usable directory; klaus_promote never overwrites files`,
            { hint: "Choose another path." },
          );
        case "content":
          throw new ToolError(outcome.message, {
            ...(outcome.code === "template-literal"
              ? {
                  hint: "A recorded value contains a literal {{, which would be expanded as a template when the flow runs. It cannot be promoted through klaus mcp.",
                }
              : {}),
          });
        default:
          throw new ToolError(outcome.message);
      }
    }
    const { payload } = outcome;
    return ok({
      written: true,
      file: payload.file,
      flow: payload.flow,
      steps: payload.steps,
      // ユーザーが実行前に OS 環境変数として設定すべきプレースホルダー
      placeholders: payload.placeholders,
      redacted: payload.redacted,
      captures: payload.captures,
      skipped: payload.skipped,
      notes: payload.notes,
      notice: payload.notice,
      validation: { valid: true },
      yaml: payload.yaml,
    });
  }),
};

const snapshotAcceptSchema = z.object({
  runId: runIdSchema("Run ID that recorded the pending snapshot (see klaus_snapshot_list)."),
  snapshotFile: z
    .string()
    .describe("snapshotFile of the pending item, exactly as returned by klaus_snapshot_list."),
  key: z.string().describe("key of the pending item, exactly as returned by klaus_snapshot_list."),
});
const snapshotAcceptTool: ToolDefinition<typeof snapshotAcceptSchema> = {
  name: "klaus_snapshot_accept",
  description:
    "Accept ONE pending snapshot (a mismatch or a missing baseline from klaus_snapshot_list) as the new baseline, replacing the stored value in the __snapshots__ file. This changes a baseline a human may rely on: call it only after the user has confirmed the new response is correct. Refuses: pairs that are not pending for that run, runs against a protected environment (use `klaus snapshot accept` in a terminal), and steps whose other assertions failed. Not available with --read-only.",
  inputSchema: snapshotAcceptSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  write: true,
  serialize: true,
  handler: guarded(async (args, ctx) => {
    assertWritable(ctx);
    const runId = validateRunId(args.runId);
    if (
      args.snapshotFile.length === 0 ||
      args.snapshotFile.length > MAX_FILE_LENGTH ||
      hasControlCharacter(args.snapshotFile)
    ) {
      throw new ToolError("snapshotFile is invalid");
    }
    if (args.key.length === 0 || args.key.length > 1024 || hasControlCharacter(args.key)) {
      throw new ToolError("key is invalid");
    }
    const outcome = await acceptPendingSnapshot(ctx.cwd, {
      runId,
      snapshotFile: args.snapshotFile,
      key: args.key,
    });
    if (outcome.ok) {
      return ok({
        accepted: true,
        state: outcome.result.state,
        snapshotFile: outcome.result.snapshotFile,
        key: outcome.result.key,
      });
    }
    switch (outcome.kind) {
      case "forbidden":
        throw new ToolError(`refused: ${outcome.message}`, {
          errorCode: "guard.path",
          hint: "Tell the user; they can accept it with `klaus snapshot accept` in a terminal.",
        });
      case "failed-step":
        throw new ToolError(outcome.message, {
          hint: "Fix the step and run it again instead of accepting this response.",
        });
      default:
        throw new ToolError(outcome.message);
    }
  }),
};

/** 公開するツールの一覧(登録順がそのまま tools/list の順になる) */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  listFlowsTool,
  validateFlowTool,
  listEnvironmentsTool,
  dryRunTool,
  runFlowTool,
  requestTool,
  historyListTool,
  historyShowTool,
  diffRunsTool,
  snapshotListTool,
  promoteTool,
  snapshotAcceptTool,
];
