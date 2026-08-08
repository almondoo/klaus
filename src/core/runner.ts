import { randomUUID } from "node:crypto";
import { JSONPath } from "jsonpath-plus";
import { evaluateAssertions } from "./assert.js";
import { loadEnvironment } from "./env.js";
import { KlausError, RuntimeError } from "./errors.js";
import type { HistoryEntry } from "./history.js";
import { appendHistory } from "./history.js";
import { sendRequest } from "./http.js";
import { loadFlow } from "./loader.js";
import type { Flow, RequestDef, Step } from "./schema.js";
import { receiveSse } from "./sse.js";
import { renderDeep, renderHeaders, renderString, type TemplateContext } from "./template.js";
import type {
  FlowResult,
  RequestSnapshot,
  ResponseSnapshot,
  RunResult,
  StepResult,
} from "./types.js";
import { connectWebSocket } from "./ws.js";

/** ステップ開始時に onStepStart へ渡されるコンテキスト */
export interface StepStartContext {
  flow: string;
  file: string;
  step: string;
}

/** ステップ完了時(passed/failed/error/skipped 確定後)に onStepComplete へ渡されるコンテキスト */
export interface StepCompleteContext {
  flow: string;
  file: string;
  result: StepResult;
}

/**
 * フロー実行のオプション。
 * history は「true(デフォルトの .klaus/history/*.jsonl に書く)」「false(書かない)」
 * 「関数(カスタムシンクに渡す。テストや UI 連携向け)」のいずれかで制御する。
 */
export interface RunFlowOptions {
  cwd?: string;
  /** フロー定義の env を上書きする環境名 */
  envNameOverride?: string;
  /** 複数フローをまとめて runId で紐付けたい場合に指定する */
  runId?: string;
  history?: boolean | ((entry: HistoryEntry) => void | Promise<void>);
  /**
   * ステップ単位の進捗通知。history 書き込みとは独立した仕組み。
   * CLI の逐次出力や、将来の localhost UI が SSE でライブ配信する際のフックとして使う想定。
   * skipped ステップに対しても呼ばれる。
   */
  onStepStart?: (context: StepStartContext) => void | Promise<void>;
  onStepComplete?: (context: StepCompleteContext) => void | Promise<void>;
  /**
   * ステップ本体の成否には影響しない警告(履歴書き込み失敗など)の通知先。
   * 未指定の場合は何もしない(core 側では警告を蓄積せず、通知のみ行う)。
   */
  onWarning?: (message: string) => void;
}

const DEFAULT_HISTORY = true;

/** Accept ヘッダーまたは sse ブロックの存在で SSE モードかどうかを判定する(ws ステップは対象外) */
function isSseStep(step: Step): boolean {
  if (!step.request) return false;
  if (step.sse) return true;
  const headers = step.request.headers ?? {};
  const acceptEntry = Object.entries(headers).find(([key]) => key.toLowerCase() === "accept");
  return typeof acceptEntry?.[1] === "string" && acceptEntry[1].includes("text/event-stream");
}

/**
 * request.body または request.graphql からリクエストボディを構築する(テンプレート展開込み)。
 * graphql 指定時は { query, variables } (variables 省略時は { query } のみ)を送信 body とする。
 */
function buildRequestBody(request: RequestDef, templateContext: TemplateContext): unknown {
  if (request.graphql) {
    const query = renderString(request.graphql.query, templateContext);
    const variables =
      request.graphql.variables !== undefined
        ? renderDeep(request.graphql.variables, templateContext)
        : undefined;
    return variables !== undefined ? { query, variables } : { query };
  }
  return request.body !== undefined ? renderDeep(request.body, templateContext) : undefined;
}

/**
 * capture 定義(jsonpath)に従って JSON レスポンスから変数を抽出する。
 * JSONPath の評価例外・マッチなし(wrap:false で undefined が返る場合)は
 * 無警告で "undefined" を格納せず RuntimeError を投げてステップを error にする。
 * JSONPath が正当に null を返した場合は成功として扱う。
 */
function captureValues(
  captureDef: Record<string, string> | undefined,
  json: unknown,
  stepName: string,
): Record<string, unknown> {
  if (!captureDef) return {};
  const result: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(captureDef)) {
    let value: unknown;
    try {
      value = JSONPath({ path, json: json as never, wrap: false });
    } catch (error) {
      throw new RuntimeError(
        `capture "${name}": JSONPath "${path}" の評価に失敗しました (step "${stepName}"): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (value === undefined) {
      throw new RuntimeError(
        `capture "${name}": JSONPath "${path}" にマッチする値がありません (step "${stepName}")`,
      );
    }
    result[name] = value;
  }
  return result;
}

type HistorySink = (entry: HistoryEntry) => void | Promise<void>;

/**
 * 1ステップを実行する。テンプレート展開・リクエスト送信・アサーション評価を行う。
 * 履歴書き込み自体はここでは行わず、書き込むべきエントリを historyEntry として返すだけにする
 * (呼び出し元がステップの成否確定後・主 try/catch の外で書き込む)。
 */
async function executeStep(
  step: Step,
  templateContext: TemplateContext,
  runId: string,
  flowName: string,
): Promise<{
  result: StepResult;
  captured: Record<string, unknown>;
  historyEntry?: HistoryEntry;
}> {
  const startedAt = new Date().toISOString();
  let requestSnapshot: RequestSnapshot | undefined;

  try {
    // アサーションの期待値もテンプレート展開の対象(例: equals: "{{testEmail}}")
    const assertDef = step.assert ? renderDeep(step.assert, templateContext) : undefined;

    if (step.ws) {
      // テンプレート展開(未解決変数・OS 環境変数未定義は RuntimeError として catch 節に落ちる)
      const url = renderString(step.ws.url, templateContext);
      const headers = renderHeaders(step.ws.headers, templateContext);
      const sendItems = (step.ws.send ?? []).map((item) =>
        typeof item === "string"
          ? renderString(item, templateContext)
          : renderDeep(item, templateContext),
      );
      requestSnapshot = {
        method: "WS",
        url,
        headers,
        body: sendItems.length > 0 ? sendItems : undefined,
      };

      const wsResult = await connectWebSocket({
        url,
        headers,
        send: sendItems,
        maxMessages: step.ws.maxMessages,
        maxDurationMs: step.ws.maxDurationMs,
      });

      const assertions = evaluateAssertions(assertDef, {
        // WS には HTTP ステータスが無いため、ハンドシェイク成功相当の 101 を status として扱う
        status: 101,
        headers: {},
        body: undefined,
        bodyText: "",
        durationMs: wsResult.durationMs,
        messages: wsResult.messages,
      });
      const ok = assertions.every((a) => a.ok);

      const stepResult: StepResult = {
        name: step.name,
        status: ok ? "passed" : "failed",
        startedAt,
        durationMs: wsResult.durationMs,
        request: requestSnapshot,
        wsMessages: wsResult.messages,
        assertions,
      };

      // capture は WS ステップでは(SSE と同様)無視する
      return {
        result: stepResult,
        captured: {},
        historyEntry: {
          v: 1,
          runId,
          flow: flowName,
          step: step.name,
          startedAt,
          durationMs: wsResult.durationMs,
          request: requestSnapshot,
          // response 相当として受信メッセージを body に格納する(status は HTTP の 101 Switching Protocols 相当)
          response: {
            status: 101,
            headers: {},
            body: wsResult.messages.map((m) => m.data),
          },
          assertions,
        },
      };
    }

    if (!step.request) {
      // schema 側の superRefine で request/ws のいずれか必須を検証済みのため、通常はここに来ない
      throw new RuntimeError(`step "${step.name}" has neither request nor ws defined`);
    }
    const request = step.request;

    // テンプレート展開(未解決変数・OS 環境変数未定義は RuntimeError として catch 節に落ちる)
    // graphql 指定時のみ method 省略可であり、その場合は POST を既定にする
    const method = request.method ?? "POST";
    const url = renderString(request.url, templateContext);
    const headers = renderHeaders(request.headers, templateContext);
    const body = buildRequestBody(request, templateContext);
    requestSnapshot = { method, url, headers, body };

    if (isSseStep(step)) {
      const sseResult = await receiveSse(
        { method, url, headers, body, timeoutMs: request.timeoutMs },
        step.sse,
      );

      const assertions = evaluateAssertions(assertDef, {
        status: sseResult.status,
        headers: sseResult.headers,
        body: undefined,
        bodyText: "",
        durationMs: sseResult.durationMs,
        events: sseResult.events,
      });
      const ok = assertions.every((a) => a.ok);

      // SSE では response.body に events を二重保持しない(受信イベントは StepResult.events 側に格納する)
      const responseSnapshot: ResponseSnapshot = {
        status: sseResult.status,
        headers: sseResult.headers,
        body: undefined,
      };

      const stepResult: StepResult = {
        name: step.name,
        status: ok ? "passed" : "failed",
        startedAt,
        durationMs: sseResult.durationMs,
        request: requestSnapshot,
        response: responseSnapshot,
        events: sseResult.events,
        assertions,
      };

      // capture は JSON レスポンス(SSE 以外)にのみ適用する
      return {
        result: stepResult,
        captured: {},
        historyEntry: {
          v: 1,
          runId,
          flow: flowName,
          step: step.name,
          startedAt,
          durationMs: sseResult.durationMs,
          request: requestSnapshot,
          response: responseSnapshot,
          assertions,
        },
      };
    }

    const response = await sendRequest({
      method,
      url,
      headers,
      body,
      timeoutMs: request.timeoutMs,
    });

    const assertions = evaluateAssertions(assertDef, {
      status: response.status,
      headers: response.headers,
      body: response.body,
      bodyText: response.bodyText,
      durationMs: response.durationMs,
    });
    const ok = assertions.every((a) => a.ok);
    const captured = captureValues(step.capture, response.body, step.name);

    const responseSnapshot: ResponseSnapshot = {
      status: response.status,
      headers: response.headers,
      body: response.body,
    };

    const stepResult: StepResult = {
      name: step.name,
      status: ok ? "passed" : "failed",
      startedAt,
      durationMs: response.durationMs,
      request: requestSnapshot,
      response: responseSnapshot,
      assertions,
    };

    return {
      result: stepResult,
      captured,
      historyEntry: {
        v: 1,
        runId,
        flow: flowName,
        step: step.name,
        startedAt,
        durationMs: response.durationMs,
        request: requestSnapshot,
        response: responseSnapshot,
        assertions,
      },
    };
  } catch (error) {
    // runtime エラー(接続不能・タイムアウト・テンプレート未解決等)はここに集約する
    const message = error instanceof KlausError ? error.message : String(error);
    const stepResult: StepResult = {
      name: step.name,
      status: "error",
      startedAt,
      durationMs: 0,
      request: requestSnapshot,
      assertions: [],
      error: message,
    };
    return { result: stepResult, captured: {} };
  }
}

function resolveHistorySink(
  cwd: string,
  history: RunFlowOptions["history"],
): HistorySink | undefined {
  const option = history ?? DEFAULT_HISTORY;
  if (option === false) return undefined;
  if (typeof option === "function") return option;
  return (entry) => appendHistory(cwd, entry);
}

type AggregatableStatus = "passed" | "failed" | "skipped" | "error";

/**
 * ステータス配列を「error > failed > passed」の優先順位で1つの結果に集約する共通ヘルパー。
 * FlowResult(steps から)・RunResult(flows から)の両方の集約で使う。
 * skipped は集約結果には影響しない(passed 側に倒れる)。
 */
function aggregateStatus(statuses: AggregatableStatus[]): "passed" | "failed" | "error" {
  if (statuses.some((s) => s === "error")) return "error";
  if (statuses.some((s) => s === "failed")) return "failed";
  return "passed";
}

/**
 * 既に読み込み済みの Flow を実行する。
 * loadFlow を経由しないため、ファイルを介さないユニットテストからも呼べる。
 */
export async function executeFlow(
  flow: Flow,
  filePath: string,
  options: RunFlowOptions = {},
): Promise<FlowResult> {
  const cwd = options.cwd ?? process.cwd();
  const runId = options.runId ?? randomUUID();
  const environment = await loadEnvironment(cwd, flow.env, options.envNameOverride);
  const historySink = resolveHistorySink(cwd, options.history);

  const captures: Record<string, unknown> = {};
  const steps: StepResult[] = [];
  const flowStartedAt = performance.now();
  let skipRest = false;

  for (const step of flow.steps) {
    await options.onStepStart?.({ flow: flow.name, file: filePath, step: step.name });

    let result: StepResult;
    let captured: Record<string, unknown> = {};

    if (skipRest) {
      result = {
        name: step.name,
        status: "skipped",
        startedAt: new Date().toISOString(),
        durationMs: 0,
        assertions: [],
        error: "skipped because a previous step failed",
      };
    } else {
      const templateContext: TemplateContext = { captures, env: environment };
      const outcome = await executeStep(step, templateContext, runId, flow.name);
      result = outcome.result;
      captured = outcome.captured;

      // 履歴書き込みはステップ結果確定後・主 try/catch の外で行う。
      // 失敗してもステップの status は変えず、onWarning で通知するだけに留める。
      if (historySink && outcome.historyEntry) {
        try {
          await historySink(outcome.historyEntry);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.onWarning?.(
            `履歴の書き込みに失敗しました (flow "${flow.name}", step "${step.name}"): ${message}`,
          );
        }
      }
    }

    steps.push(result);
    Object.assign(captures, captured);

    if (result.status === "error" || result.status === "failed") {
      skipRest = true;
    }

    await options.onStepComplete?.({ flow: flow.name, file: filePath, result });
  }

  const durationMs = performance.now() - flowStartedAt;
  const status = aggregateStatus(steps.map((s) => s.status));

  return { name: flow.name, file: filePath, status, steps, durationMs };
}

/** フロー定義 YAML ファイルを読み込んで実行する */
export async function runFlow(filePath: string, options: RunFlowOptions = {}): Promise<FlowResult> {
  const flow = await loadFlow(filePath);
  return executeFlow(flow, filePath, options);
}

/** 複数のフロー定義 YAML ファイルを順次実行する */
export async function runFlows(
  filePaths: string[],
  options: RunFlowOptions = {},
): Promise<RunResult> {
  const runId = options.runId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const runStartedAt = performance.now();

  const flows: FlowResult[] = [];
  for (const filePath of filePaths) {
    const flowResult = await runFlow(filePath, { ...options, runId });
    flows.push(flowResult);
  }

  const durationMs = performance.now() - runStartedAt;
  const status = aggregateStatus(flows.map((f) => f.status));

  return { runId, startedAt, durationMs, flows, status };
}
