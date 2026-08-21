import { z } from "zod";
import type {
  FlowResult,
  RequestSnapshot,
  ResponseSnapshot,
  RunResult,
  SseEvent,
  StepResult,
  WsMessage,
} from "../../core/index.js";
import { historyDateFromTimestamp } from "../../core/index.js";
import { summarizeSteps, truncate } from "./text.js";

/**
 * JSON モードの出力ペイロード(v2)。zod スキーマとして定義し、型は z.infer で導出する
 * (#36 で手書き interface から移行。src/cli/schema.ts の buildRunReportJsonSchema() から
 * JSON Schema を生成できるようにするため)。
 * v1 は RunResult をそのまま JSON.stringify するだけだったが、エージェント向けに
 * 圧縮するため v2 で構造を刷新した(後方互換は取らない: 利用者不在のため旧形式維持は不要)。
 * - failure-focused: passed ステップは1行要約に落とし、failed/error/skipped のみ詳細を持つ
 * - truncate: request/response ボディ・SSE events・WS wsMessages は 500 文字で切り詰める
 * - historyRef: 履歴記録が有効な実行では、全文取得用のポインタ(`klaus history show`)を各ステップに付与する
 * - compact: pretty print せず JSON.stringify する
 * - version: このスキーマの後方互換が壊れる変更(フィールド削除・型変更等)をする場合は値を上げること
 */

/** アサーション1件の評価結果(src/core/types.ts の AssertionResult と同形)。expected/actual は任意の値を取りうる */
const assertionResultSchema = z.strictObject({
  ok: z.boolean().describe("Whether this assertion passed."),
  kind: z
    .string()
    .describe(
      'Assertion kind (e.g. "status", "header", "body", "bodyText", "duration", "eventCount", "events", "messageCount", "messages").',
    ),
  expected: z
    .unknown()
    .optional()
    .describe("Expected value, when applicable to this assertion kind."),
  actual: z
    .unknown()
    .optional()
    .describe("Actual observed value, when applicable to this assertion kind."),
  message: z.string().describe("Human-readable summary of this assertion's result."),
});

/** 全体のステータス集計。failure-focused な出力でも全体像が一目で分かるようにする */
export const jsonSummarySchema = z.strictObject({
  flows: z.number().describe("Total number of flows executed in this run."),
  steps: z.number().describe("Total number of steps executed across all flows."),
  passed: z.number().describe("Number of steps that passed."),
  failed: z.number().describe("Number of steps that failed one or more assertions."),
  error: z
    .number()
    .describe(
      "Number of steps that errored (e.g. connection failure, timeout) before assertions could run.",
    ),
  skipped: z
    .number()
    .describe(
      "Number of steps skipped because an earlier step in the same flow failed or errored.",
    ),
});
export type JsonSummary = z.infer<typeof jsonSummarySchema>;

/** 履歴 JSONL 上の該当エントリを指すポインタ。`klaus history show <runId> --step <step>` で全文を取得できる */
export const historyRefSchema = z.strictObject({
  date: z
    .string()
    .describe("History file date (YYYY-MM-DD), derived from the step's startedAt timestamp."),
  runId: z.string().describe("Run ID that produced this step result."),
  step: z
    .string()
    .describe("Step name, used together with date/runId to look up the full recorded step."),
  iteration: z
    .number()
    .optional()
    .describe(
      "1-based data-driven iteration number, present only when `klaus run --data` was used (matches the flow's iteration field, so history entries from different iterations of the same flow/step are distinguishable).",
    ),
});
export type HistoryRef = z.infer<typeof historyRefSchema>;

/** request スナップショットの JSON 出力形。body は truncate 済みの文字列表現にする */
export const jsonRequestSnapshotSchema = z.strictObject({
  method: z.string().describe("HTTP method actually sent (normalized to upper case)."),
  url: z.string().describe("Fully resolved request URL, with all template placeholders expanded."),
  headers: z.record(z.string(), z.string()).describe("HTTP request headers actually sent."),
  body: z
    .string()
    .optional()
    .describe(
      "Request body, stringified (JSON.stringify for objects) and truncated to 500 characters.",
    ),
});
export type JsonRequestSnapshot = z.infer<typeof jsonRequestSnapshotSchema>;

/** response スナップショットの JSON 出力形。body は truncate 済みの文字列表現にする */
export const jsonResponseSnapshotSchema = z.strictObject({
  status: z.number().describe("HTTP response status code."),
  headers: z.record(z.string(), z.string()).describe("HTTP response headers."),
  body: z
    .string()
    .optional()
    .describe(
      "Response body, stringified (JSON.stringify for parsed JSON) and truncated to 500 characters.",
    ),
});
export type JsonResponseSnapshot = z.infer<typeof jsonResponseSnapshotSchema>;

/** SSE イベントの JSON 出力形。data は truncate 済み */
export const jsonSseEventSchema = z.strictObject({
  event: z.string().optional().describe("SSE `event:` field, if the source sent one."),
  id: z.string().optional().describe("SSE `id:` field, if the source sent one."),
  data: z.string().describe("SSE event data, truncated to 500 characters."),
});
export type JsonSseEvent = z.infer<typeof jsonSseEventSchema>;

/** WS メッセージの JSON 出力形。data は truncate 済み */
export const jsonWsMessageSchema = z.strictObject({
  data: z.string().describe("WS message payload, truncated to 500 characters."),
});
export type JsonWsMessage = z.infer<typeof jsonWsMessageSchema>;

const stepStatusSchema = z
  .enum(["passed", "failed", "skipped", "error"])
  .describe("Step execution status.") satisfies z.ZodType<StepResult["status"]>;

/**
 * 1ステップの JSON 出力形。
 * passed は name/status/durationMs(+historyRef)のみの1行要約。
 * failed/error/skipped は startedAt・request・response・events・wsMessages・assertions・error を含む詳細。
 */
export const jsonStepReportSchema = z.strictObject({
  name: z.string().describe("Step name."),
  status: stepStatusSchema,
  durationMs: z.number().describe("Step duration in milliseconds (rounded)."),
  historyRef: historyRefSchema
    .optional()
    .describe(
      "Pointer into the JSONL history file for this step's full record. Present only when history recording was enabled for the run.",
    ),
  startedAt: z
    .string()
    .optional()
    .describe(
      "ISO 8601 timestamp when the step started. Omitted for passed steps (one-line summary).",
    ),
  request: jsonRequestSnapshotSchema
    .optional()
    .describe("Request snapshot. Omitted for passed steps (one-line summary)."),
  response: jsonResponseSnapshotSchema
    .optional()
    .describe(
      "Response snapshot. Omitted for passed steps and for WS steps (which have no HTTP response).",
    ),
  events: z
    .array(jsonSseEventSchema)
    .optional()
    .describe("Received SSE events, in order. Present only for SSE steps that are not passed."),
  wsMessages: z
    .array(jsonWsMessageSchema)
    .optional()
    .describe("Received WS messages, in order. Present only for WS steps that are not passed."),
  assertions: z
    .array(assertionResultSchema)
    .optional()
    .describe("Assertion results for this step. Omitted for passed steps (one-line summary)."),
  error: z
    .string()
    .optional()
    .describe("Runtime error message, or the reason the step was skipped."),
});
export type JsonStepReport = z.infer<typeof jsonStepReportSchema>;

const flowStatusSchema = z
  .enum(["passed", "failed", "error"])
  .describe("Flow execution status.") satisfies z.ZodType<FlowResult["status"]>;

export const jsonFlowReportSchema = z.strictObject({
  name: z.string().describe("Flow name (the `name` field of the flow YAML)."),
  file: z.string().describe("Path to the flow YAML file that was executed."),
  status: flowStatusSchema,
  durationMs: z
    .number()
    .describe("Flow duration in milliseconds (rounded), summed across its steps."),
  steps: z.array(jsonStepReportSchema).describe("Per-step results, in execution order."),
  iteration: z
    .number()
    .optional()
    .describe(
      "1-based data-driven iteration number, present only when `klaus run --data` was used (each row runs every given flow once, in iteration-major order).",
    ),
});
export type JsonFlowReport = z.infer<typeof jsonFlowReportSchema>;

const runStatusSchema = z
  .enum(["passed", "failed", "error"])
  .describe("Overall run status across all flows.") satisfies z.ZodType<RunResult["status"]>;

/**
 * JSON モードの出力ペイロード(v2)本体。
 */
export const jsonReportSchema = z
  .strictObject({
    version: z
      .literal(2)
      .describe(
        "Schema version of this JSON payload. Increases only when a backward-incompatible change is made (field removal, type change, semantics change).",
      ),
    status: runStatusSchema,
    runId: z
      .string()
      .describe(
        "Unique ID for this run. Used to look up history records via `klaus history show`.",
      ),
    startedAt: z.string().describe("ISO 8601 timestamp when the run started."),
    durationMs: z.number().describe("Total run duration in milliseconds (rounded)."),
    summary: jsonSummarySchema.describe(
      "Aggregate pass/fail/error/skipped counts across all flows.",
    ),
    flows: z.array(jsonFlowReportSchema).describe("Per-flow results, in execution order."),
  })
  .describe(
    "klaus `run --json` output (v2). Failure-focused: passed steps are reduced to a one-line summary, while failed/error/skipped steps carry full request/response/assertion detail. Body and event/message payloads are truncated to 500 characters; use historyRef with `klaus history show` to retrieve full content when history recording is enabled.",
  );
export type JsonReport = z.infer<typeof jsonReportSchema>;

export interface FormatJsonOptions {
  /** true の場合、各ステップに historyRef を付与する(--no-history 実行時は false にして省略する) */
  historyEnabled: boolean;
}

/** JSON 互換値でない可能性のある body を、truncate 可能な文字列表現に変換する(JSON オブジェクトは文字列化してから切り詰める) */
function truncateBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return truncate(text);
}

function buildRequest(request: RequestSnapshot | undefined): JsonRequestSnapshot | undefined {
  if (!request) return undefined;
  return {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: truncateBody(request.body),
  };
}

function buildResponse(response: ResponseSnapshot | undefined): JsonResponseSnapshot | undefined {
  if (!response) return undefined;
  return {
    status: response.status,
    headers: response.headers,
    body: truncateBody(response.body),
  };
}

function buildEvents(events: SseEvent[] | undefined): JsonSseEvent[] | undefined {
  return events?.map((event) => ({ event: event.event, id: event.id, data: truncate(event.data) }));
}

function buildWsMessages(messages: WsMessage[] | undefined): JsonWsMessage[] | undefined {
  return messages?.map((message) => ({ data: truncate(message.data) }));
}

/**
 * historyEnabled のときだけ、step.startedAt から履歴ファイルの日付を導出して historyRef を組み立てる。
 * iteration は flow.iteration をそのまま引き継ぐ(--data 実行時のみ設定され、同一フロー・同一ステップ名の
 * 複数イテレーションを historyRef のみからでも区別できるようにする)。
 */
function buildHistoryRef(
  step: StepResult,
  runId: string,
  historyEnabled: boolean,
  iteration: number | undefined,
): HistoryRef | undefined {
  if (!historyEnabled) return undefined;
  return { date: historyDateFromTimestamp(step.startedAt), runId, step: step.name, iteration };
}

function buildStep(
  step: StepResult,
  runId: string,
  historyEnabled: boolean,
  iteration: number | undefined,
): JsonStepReport {
  const durationMs = Math.round(step.durationMs);
  const historyRef = buildHistoryRef(step, runId, historyEnabled, iteration);

  if (step.status === "passed") {
    return { name: step.name, status: step.status, durationMs, historyRef };
  }

  // failed / error / skipped は詳細を含める
  return {
    name: step.name,
    status: step.status,
    durationMs,
    historyRef,
    startedAt: step.startedAt,
    request: buildRequest(step.request),
    response: buildResponse(step.response),
    events: buildEvents(step.events),
    wsMessages: buildWsMessages(step.wsMessages),
    assertions: step.assertions,
    error: step.error,
  };
}

function buildFlow(flow: FlowResult, runId: string, historyEnabled: boolean): JsonFlowReport {
  return {
    name: flow.name,
    file: flow.file,
    status: flow.status,
    durationMs: Math.round(flow.durationMs),
    steps: flow.steps.map((step) => buildStep(step, runId, historyEnabled, flow.iteration)),
    iteration: flow.iteration,
  };
}

function buildSummary(runResult: RunResult): JsonSummary {
  const steps = runResult.flows.flatMap((flow) => flow.steps);
  return {
    flows: runResult.flows.length,
    steps: steps.length,
    ...summarizeSteps(steps),
  };
}

/**
 * RunResult を CLI の JSON 出力形式(v2, compact)に整形する。
 * pretty print はしない(エージェント向けにトークン数を抑えるため)。
 * 全文が必要な場合は historyRef(履歴記録が有効な場合のみ付与)経由で
 * `klaus history show <runId> --step <step>` から取得する想定。
 */
export function formatJson(runResult: RunResult, options: FormatJsonOptions): string {
  const report: JsonReport = {
    version: 2,
    status: runResult.status,
    runId: runResult.runId,
    startedAt: runResult.startedAt,
    durationMs: Math.round(runResult.durationMs),
    summary: buildSummary(runResult),
    flows: runResult.flows.map((flow) => buildFlow(flow, runResult.runId, options.historyEnabled)),
  };
  return JSON.stringify(report);
}
