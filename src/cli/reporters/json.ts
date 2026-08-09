import type {
  AssertionResult,
  FlowResult,
  RequestSnapshot,
  ResponseSnapshot,
  RunResult,
  SseEvent,
  StepResult,
  WsMessage,
} from "../../core/index.js";
import { historyDateFromTimestamp } from "../../core/index.js";
import { truncate } from "./text.js";

/**
 * JSON モードの出力ペイロード(v2)。
 * v1 は RunResult をそのまま JSON.stringify するだけだったが、エージェント向けに
 * 圧縮するため v2 で構造を刷新した(後方互換は取らない: 利用者不在のため旧形式維持は不要)。
 * - failure-focused: passed ステップは1行要約に落とし、failed/error/skipped のみ詳細を持つ
 * - truncate: request/response ボディ・SSE events・WS wsMessages は 500 文字で切り詰める
 * - historyRef: 履歴記録が有効な実行では、全文取得用のポインタ(`klaus history show`)を各ステップに付与する
 * - compact: pretty print せず JSON.stringify する
 */
export interface JsonReport {
  version: 2;
  status: RunResult["status"];
  runId: string;
  startedAt: string;
  durationMs: number;
  summary: JsonSummary;
  flows: JsonFlowReport[];
}

/** 全体のステータス集計。failure-focused な出力でも全体像が一目で分かるようにする */
export interface JsonSummary {
  flows: number;
  steps: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
}

export interface JsonFlowReport {
  name: string;
  file: string;
  status: FlowResult["status"];
  durationMs: number;
  steps: JsonStepReport[];
}

/** 履歴 JSONL 上の該当エントリを指すポインタ。`klaus history show <runId> --step <step>` で全文を取得できる */
export interface HistoryRef {
  date: string;
  runId: string;
  step: string;
}

/** request スナップショットの JSON 出力形。body は truncate 済みの文字列表現にする */
export interface JsonRequestSnapshot {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | undefined;
}

/** response スナップショットの JSON 出力形。body は truncate 済みの文字列表現にする */
export interface JsonResponseSnapshot {
  status: number;
  headers: Record<string, string>;
  body?: string | undefined;
}

/** SSE イベントの JSON 出力形。data は truncate 済み */
export interface JsonSseEvent {
  event?: string | undefined;
  id?: string | undefined;
  data: string;
}

/** WS メッセージの JSON 出力形。data は truncate 済み */
export interface JsonWsMessage {
  data: string;
}

/**
 * 1ステップの JSON 出力形。
 * passed は name/status/durationMs(+historyRef)のみの1行要約。
 * failed/error/skipped は startedAt・request・response・events・wsMessages・assertions・error を含む詳細。
 */
export interface JsonStepReport {
  name: string;
  status: StepResult["status"];
  durationMs: number;
  historyRef?: HistoryRef | undefined;
  startedAt?: string;
  request?: JsonRequestSnapshot | undefined;
  response?: JsonResponseSnapshot | undefined;
  events?: JsonSseEvent[] | undefined;
  wsMessages?: JsonWsMessage[] | undefined;
  assertions?: AssertionResult[];
  error?: string | undefined;
}

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

/** historyEnabled のときだけ、step.startedAt から履歴ファイルの日付を導出して historyRef を組み立てる */
function buildHistoryRef(
  step: StepResult,
  runId: string,
  historyEnabled: boolean,
): HistoryRef | undefined {
  if (!historyEnabled) return undefined;
  return { date: historyDateFromTimestamp(step.startedAt), runId, step: step.name };
}

function buildStep(step: StepResult, runId: string, historyEnabled: boolean): JsonStepReport {
  const durationMs = Math.round(step.durationMs);
  const historyRef = buildHistoryRef(step, runId, historyEnabled);

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
    steps: flow.steps.map((step) => buildStep(step, runId, historyEnabled)),
  };
}

function buildSummary(runResult: RunResult): JsonSummary {
  const steps = runResult.flows.flatMap((flow) => flow.steps);
  return {
    flows: runResult.flows.length,
    steps: steps.length,
    passed: steps.filter((s) => s.status === "passed").length,
    failed: steps.filter((s) => s.status === "failed").length,
    error: steps.filter((s) => s.status === "error").length,
    skipped: steps.filter((s) => s.status === "skipped").length,
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
