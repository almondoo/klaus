import { randomUUID } from "node:crypto";
import { JSONPath } from "jsonpath-plus";
import { evaluateAssertions } from "./assert.js";
import {
  appendCassetteEntry,
  buildCassetteEntry,
  type CassetteEntry,
  cassetteEntryToHttpResponse,
  findCassetteEntry,
  loadCassetteIndex,
} from "./cassette.js";
import { isProtectedEnvironment, loadEnvironment, toTemplateVariables } from "./env.js";
import { KlausError, RuntimeError } from "./errors.js";
import type { HistoryEntry } from "./history.js";
import { appendHistory, maskHistoryEntry } from "./history.js";
import type { HttpRequestOptions, HttpResponse } from "./http.js";
import { sendRequest } from "./http.js";
import { loadFlow } from "./loader.js";
import type { Environment, Flow, RequestDef, Step } from "./schema.js";
import { requestSchema } from "./schema.js";
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
  /** フロー定義の env を上書きする環境名。呼び出し元(CLI オプション等)から明示的に undefined が渡ることがある */
  envNameOverride?: string | undefined;
  /**
   * -e/--env(envNameOverride)の代わりに、任意パス(cwd 相対または絶対)の環境ファイルを直接読み込む場合のパス。
   * 指定時は environments/ ディレクトリへの上方探索・境界チェックを行わず、指定パスをそのまま
   * loadEnvironmentFile に渡す(利用者が明示的に選んだファイルのため)。envNameOverride との排他制御は
   * 呼び出し元(CLI の run コマンド)の責務であり、ここでは envFilePath が優先される
   */
  envFilePath?: string | undefined;
  /**
   * テンプレートの env 名前空間(environments/<name>.yaml または envFilePath で読み込んだ値)へ
   * 上書きマージする追加変数(CLI の --var 等から渡す想定)。環境ファイルの値と同じ扱いで
   * secrets には登録されない(マスク対象外。真のシークレットは {{env.X}}(OS 環境変数)経由にする)
   */
  variables?: Record<string, string> | undefined;
  /**
   * $protected: true を付けた環境ファイルへの実行を許可するかどうか。
   * 既定は false(未指定)で、その場合 $protected な環境への実行は RuntimeError で拒否される
   * (CLI の --allow-protected から渡される想定。サーバー/UI 経由の実行はこのオプションを渡さないため、
   * 保護環境は常に拒否される)。呼び出し元(CLI オプション等)から明示的に undefined が渡ることがある
   */
  allowProtected?: boolean | undefined;
  /** 複数フローをまとめて runId で紐付けたい場合に指定する */
  runId?: string;
  history?: boolean | ((entry: HistoryEntry) => void | Promise<void>);
  /**
   * ステップ単位の進捗通知。history 書き込みとは独立した仕組み。
   * CLI の逐次出力や、将来の localhost UI が SSE でライブ配信する際のフックとして使う想定。
   * skipped ステップに対しても呼ばれる。
   */
  // 呼び出し元(CLI 等)がレポーター有無に応じて undefined を明示的に渡すため許容する
  onStepStart?: ((context: StepStartContext) => void | Promise<void>) | undefined;
  onStepComplete?: ((context: StepCompleteContext) => void | Promise<void>) | undefined;
  /**
   * ステップ本体の成否には影響しない警告(履歴書き込み失敗など)の通知先。
   * 未指定の場合は何もしない(core 側では警告を蓄積せず、通知のみ行う)。
   */
  onWarning?: (message: string) => void;
  /**
   * ステップが新たに解決した secrets({{env.X}} で解決した値)を、そのステップの
   * onStepComplete より前に呼び出し元へ渡すコールバック。履歴書き込みのマスクとは別経路で、
   * CLI の逐次テキスト出力・JUnit ファイル出力など呼び出し元側で独自にマスクしたい場合に使う想定。
   * 未指定の場合は何もしない。
   * ステップ単位で発火するため、1フローの実行中に複数回呼ばれ得る(そのステップで新規に解決した
   * secrets のみを渡す。既に通知済みの値は再通知しない)。呼び出し元は複数回の呼び出しを
   * 集合的に(累積して)扱うこと。runFlows 経由で複数フローを実行する場合はフローをまたいでも
   * 同様に随時呼ばれる。
   */
  onSecrets?: (secrets: readonly string[]) => void;
  /**
   * record/replay モードの設定。指定時、HTTP ステップ(SSE/WS を除く)の送受信をカセットファイル経由にする。
   * - "record": 実際にリクエストを送りつつ、レスポンスを secrets でマスクしてカセット(dir/cassette.jsonl)に
   *   追記する。
   * - "replay": ネットワークに出ず、dir のカセットから method + URL(マスク済み)の完全一致で応答を返す。
   *   記録に無いリクエストは RuntimeError(ステップ error。CLI では exit 3)にする。
   * SSE/WS ステップを含むフローで指定した場合、そのステップは明示的な RuntimeError になる
   * (黙って実ネットワークへ素通ししない)。
   */
  recording?: { mode: "record" | "replay"; dir: string } | undefined;
}

const DEFAULT_HISTORY = true;

/** executeStep に渡す record/replay の実行時状態。replay モードでは索引済みカセットを保持する */
interface ActiveRecording {
  mode: "record" | "replay";
  dir: string;
  /** replay モードでのみ設定する(executeFlow で loadCassetteIndex 済み) */
  replayIndex?: Map<string, CassetteEntry>;
  /**
   * replay モードでカセットファイルの読み込み自体に失敗した場合(ファイルが無い等)に保持する。
   * ここで即座に投げず、実際に HTTP ステップが実行されるタイミング(executeStep の try/catch 内)まで
   * 遅延させることで、記録にないリクエストと同じ「ステップ error → exit 3」の経路に統一する。
   */
  replayLoadError?: RuntimeError;
}

/**
 * record/replay モードに応じて HTTP レスポンスを解決する。
 * - 未指定時: 通常どおり sendRequest で実ネットワークへ送信する。
 * - record: sendRequest で実際に送信しつつ、その時点の secrets でマスクしたレスポンスをカセットへ追記する。
 * - replay: 実ネットワークへ出ず、replayIndex から method + URL(マスク済み)一致のエントリを探して返す。
 *   見つからない場合は findCassetteEntry が RuntimeError を投げ、呼び出し元(executeStep の catch)で
 *   ステップ error として扱われる。
 */
async function resolveHttpResponse(
  recording: ActiveRecording | undefined,
  requestOptions: HttpRequestOptions,
  secrets: Set<string> | undefined,
): Promise<HttpResponse> {
  if (!recording) {
    return sendRequest(requestOptions);
  }
  const secretList = secrets ? [...secrets] : [];
  if (recording.mode === "replay") {
    // カセットファイル自体の読み込みに失敗している場合は、ここで初めて RuntimeError を投げる
    // (executeStep の try/catch でステップ error になり、記録外リクエストと同じ経路で exit 3 になる)
    if (recording.replayLoadError) throw recording.replayLoadError;
    // 読み込み成功時は executeFlow が必ず replayIndex を設定済みにする
    const index = recording.replayIndex as Map<string, CassetteEntry>;
    const entry = findCassetteEntry(index, requestOptions.method, requestOptions.url, secretList);
    return cassetteEntryToHttpResponse(entry);
  }
  const response = await sendRequest(requestOptions);
  const entry = buildCassetteEntry(requestOptions.method, requestOptions.url, response, secretList);
  await appendCassetteEntry(recording.dir, entry);
  return response;
}

/**
 * request.method 省略時(graphql ステップのみ省略可)の既定値を解決する。
 * 実行時(executeStep)とサーバー側の表示(server/routes/flows.ts の summarizeStep)の両方が
 * 同じ既定値を参照するための共通ヘルパー。
 */
export function resolveRequestMethod(request: RequestDef): string {
  return request.method ?? "POST";
}

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
 * request.query(テンプレート展開後)を URL のクエリ文字列にマージする。
 * URL に既にある同名キーは query 側の値で上書きする。query 未指定・空の場合は url をそのまま返す。
 */
function applyQueryParams(
  url: string,
  query: Record<string, string> | undefined,
  templateContext: TemplateContext,
): string {
  if (!query || Object.keys(query).length === 0) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    parsed.searchParams.set(key, renderString(value, templateContext));
  }
  return parsed.toString();
}

/**
 * capture 定義(jsonpath)に従って JSON レスポンスから変数を抽出する。
 * JSONPath の評価例外・マッチなし(wrap:false で undefined が返る場合)は
 * 無警告で "undefined" を格納せず RuntimeError を投げてステップを error にする。
 * JSONPath が正当に null を返した場合は成功として扱う。
 */
export function captureValues(
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
        `capture "${name}": failed to evaluate JSONPath "${path}" (step "${stepName}"): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (value === undefined) {
      throw new RuntimeError(
        `capture "${name}": JSONPath "${path}" matched no value (step "${stepName}")`,
      );
    }
    result[name] = value;
  }
  return result;
}

/**
 * HistoryEntry の共通フィールド(v/runId/flow/step/startedAt/durationMs/status)を
 * まとめて組み立てる。executeStep(WS/SSE/HTTP の各分岐)・executeFlow(skipped 分岐)の
 * 4 箇所で同じフィールド列挙が重複していたため、ここに切り出して呼び出し側は
 * request/response/events/assertions など分岐固有のフィールドだけを spread で追加する。
 * assertions は HEAD の JSONL キー順(request/response/events の後)を維持するため、
 * ここには含めず各呼び出し側で最後に明示的に追加する。
 */
function buildHistoryBase(
  runId: string,
  flow: string,
  step: string,
  startedAt: string,
  durationMs: number,
  status: "passed" | "failed" | "skipped",
): Pick<HistoryEntry, "v" | "runId" | "flow" | "step" | "startedAt" | "durationMs" | "status"> {
  return { v: 1, runId, flow, step, startedAt, durationMs, status };
}

/**
 * StepResult の共通フィールド(name/status/startedAt/durationMs)をまとめて組み立てる。
 * buildHistoryBase と対になる StepResult 側のヘルパー(同じ4箇所で重複していた)。
 * assertions は buildHistoryBase と同様、キー順維持のため各呼び出し側で最後に追加する。
 */
function buildStepResultBase(
  name: string,
  startedAt: string,
  durationMs: number,
  status: "passed" | "failed" | "skipped",
): Pick<StepResult, "name" | "status" | "startedAt" | "durationMs"> {
  return { name, status, startedAt, durationMs };
}

type HistorySink = (entry: HistoryEntry) => void | Promise<void>;

/** 指定ミリ秒だけ待つ(step.retry の試行間隔に使う) */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  recording: ActiveRecording | undefined,
  /**
   * 保護環境($protected: true かつ未許可)への実行を検知した場合の RuntimeError。
   * 指定されている場合、リクエスト送信前にこれを投げてステップを error にする
   * (record/replay モードで replayLoadError を遅延して投げるのと同じ考え方)。
   */
  blockedError?: RuntimeError,
): Promise<{
  result: StepResult;
  captured: Record<string, unknown>;
  historyEntry?: HistoryEntry;
}> {
  const startedAt = new Date().toISOString();
  let requestSnapshot: RequestSnapshot | undefined;

  try {
    // 保護環境への実行が拒否されている場合、リクエストを送らずここでステップ error にする
    if (blockedError) {
      throw blockedError;
    }

    // record/replay モードは HTTP のみ対応(SSE/WS は初版スコープ外)。
    // 黙って実ネットワークへ素通しせず、ここで明示的な RuntimeError にしてステップ error にする。
    if (recording && (step.ws || isSseStep(step))) {
      throw new RuntimeError(
        `step "${step.name}": SSE/WS steps are not supported in record/replay mode (HTTP only, and GraphQL over HTTP). ` +
          "Remove --record/--replay, or exclude this step from the flow.",
      );
    }

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
        ...buildStepResultBase(step.name, startedAt, wsResult.durationMs, ok ? "passed" : "failed"),
        request: requestSnapshot,
        wsMessages: wsResult.messages,
        assertions,
      };

      // capture は WS ステップでは(SSE と同様)無視する
      return {
        result: stepResult,
        captured: {},
        historyEntry: {
          ...buildHistoryBase(
            runId,
            flowName,
            step.name,
            startedAt,
            wsResult.durationMs,
            ok ? "passed" : "failed",
          ),
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
    const method = resolveRequestMethod(request);
    const url = applyQueryParams(
      renderString(request.url, templateContext),
      request.query,
      templateContext,
    );
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
        ...buildStepResultBase(
          step.name,
          startedAt,
          sseResult.durationMs,
          ok ? "passed" : "failed",
        ),
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
          ...buildHistoryBase(
            runId,
            flowName,
            step.name,
            startedAt,
            sseResult.durationMs,
            ok ? "passed" : "failed",
          ),
          request: requestSnapshot,
          response: responseSnapshot,
          // 受信イベントは response.body に二重保持せず events に格納する(StepResult と同じ方針)
          events: sseResult.events,
          assertions,
        },
      };
    }

    const response = await resolveHttpResponse(
      recording,
      { method, url, headers, body, timeoutMs: request.timeoutMs },
      templateContext.secrets,
    );

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
      ...buildStepResultBase(step.name, startedAt, response.durationMs, ok ? "passed" : "failed"),
      request: requestSnapshot,
      response: responseSnapshot,
      assertions,
    };

    return {
      result: stepResult,
      captured,
      historyEntry: {
        ...buildHistoryBase(
          runId,
          flowName,
          step.name,
          startedAt,
          response.durationMs,
          ok ? "passed" : "failed",
        ),
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
 * 環境が $protected: true かつ許可されていない場合に、ステップへ伝播させる RuntimeError を返す。
 * ここでは投げずに返すだけにし、呼び出し元がリクエスト送信前の executeStep に渡すことで、
 * 各ステップが既存の RuntimeError → ステップ error(exit 3)の経路に自然に乗るようにする
 * (record/replay モードの replayLoadError と同じ「検知は早期・エラー化は遅延」という設計)。
 * エラーメッセージには環境名と回避策(--allow-protected)を明記する。
 */
function checkEnvironmentAllowed(
  envName: string | undefined,
  environment: Environment,
  allowProtected: boolean | undefined,
): RuntimeError | undefined {
  if (!isProtectedEnvironment(environment) || allowProtected) return undefined;
  return new RuntimeError(
    `environment "${envName}" is protected ($protected: true) and refuses execution by default. ` +
      "Pass --allow-protected to run against this environment intentionally.",
  );
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
  const environment = await loadEnvironment(
    cwd,
    flow.env,
    options.envNameOverride,
    options.envFilePath,
  );
  // 保護環境チェックの表示名は、--env-file 指定時はそのファイルパスを使う(名前付き環境と同様、
  // 何を保護対象と判定したかが利用者に伝わるようにするため)
  const protectedBlockedError = checkEnvironmentAllowed(
    options.envFilePath ?? options.envNameOverride ?? flow.env,
    environment,
    options.allowProtected,
  );
  const historySink = resolveHistorySink(cwd, options.history);

  // replay モードでは実行前にカセットを読み込み、索引化しておく(ステップごとの再読み込みを避ける)。
  // 読み込み失敗(ファイルが無い等)はここでは投げず、activeRecording.replayLoadError に保持して、
  // 実際に HTTP ステップが実行されるタイミング(resolveHttpResponse)まで遅延させる
  // (record モードは事前読み込み不要。ステップごとに追記するだけでよい)。
  let activeRecording: ActiveRecording | undefined;
  if (options.recording) {
    if (options.recording.mode === "replay") {
      try {
        const replayIndex = await loadCassetteIndex(options.recording.dir);
        activeRecording = { mode: "replay", dir: options.recording.dir, replayIndex };
      } catch (error) {
        const replayLoadError =
          error instanceof RuntimeError ? error : new RuntimeError(String(error));
        activeRecording = { mode: "replay", dir: options.recording.dir, replayLoadError };
      }
    } else {
      activeRecording = { mode: "record", dir: options.recording.dir };
    }
  }

  const captures: Record<string, unknown> = {};
  // {{env.X}} で解決した値をフロー実行全体で蓄積する(履歴に書き込む前のマスクに使う)
  const secrets = new Set<string>();
  // onSecrets で既に通知済みの値(重複通知を避けるため、ステップをまたいで蓄積する)
  const notifiedSecrets = new Set<string>();
  const steps: StepResult[] = [];
  const flowStartedAt = performance.now();
  let skipRest = false;

  for (const step of flow.steps) {
    await options.onStepStart?.({ flow: flow.name, file: filePath, step: step.name });

    let result: StepResult;
    let captured: Record<string, unknown> = {};
    let historyEntry: HistoryEntry | undefined;

    if (skipRest) {
      const skippedStartedAt = new Date().toISOString();
      result = {
        ...buildStepResultBase(step.name, skippedStartedAt, 0, "skipped"),
        assertions: [],
        error: "skipped because a previous step failed",
      };
      // skipped ステップはリクエストを送っていないため request/response を持たない
      historyEntry = {
        ...buildHistoryBase(runId, flow.name, step.name, skippedStartedAt, 0, "skipped"),
        assertions: [],
      };
    } else {
      const templateContext: TemplateContext = {
        captures,
        // --var で渡した変数は環境ファイルの値を上書きする(env namespace 内での優先順位)
        env: { ...toTemplateVariables(environment), ...options.variables },
        secrets,
      };
      // step.retry がある場合、failed/error の間だけ再試行する(passed で即打ち切り)。
      // 中間試行の結果は捨て、最終試行のみを記録する(履歴・onStepStart/onStepComplete も1回ずつ)。
      const maxAttempts = step.retry ? step.retry.count + 1 : 1;
      let attempt = 0;
      let outcome: {
        result: StepResult;
        captured: Record<string, unknown>;
        historyEntry?: HistoryEntry;
      };
      do {
        attempt++;
        if (attempt > 1 && step.retry) {
          await sleep(step.retry.intervalMs);
        }
        outcome = await executeStep(
          step,
          templateContext,
          runId,
          flow.name,
          activeRecording,
          protectedBlockedError,
        );
      } while (
        step.retry &&
        attempt < maxAttempts &&
        (outcome.result.status === "failed" || outcome.result.status === "error")
      );

      if (step.retry) {
        outcome.result = { ...outcome.result, attempts: attempt };
        if (outcome.historyEntry) {
          outcome.historyEntry = { ...outcome.historyEntry, attempts: attempt };
        }
      }

      result = outcome.result;
      captured = outcome.captured;
      historyEntry = outcome.historyEntry;
    }

    // 履歴書き込みはステップ結果確定後・主 try/catch の外で行う。
    // 失敗してもステップの status は変えず、onWarning で通知するだけに留める。
    if (historySink && historyEntry) {
      // デフォルトシンク・カスタムシンクのいずれにも、必ずマスク済みのエントリを渡す
      const maskedEntry = maskHistoryEntry(historyEntry, [...secrets]);
      try {
        await historySink(maskedEntry);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.onWarning?.(
          `failed to write history (flow "${flow.name}", step "${step.name}"): ${message}`,
        );
      }
    }

    // このステップが新たに解決した secrets を、onStepComplete(text 出力の契機)より前に通知する。
    // 既に通知済みの値は除外し、CLI 側での重複マスク処理・二重カウントを避ける。
    if (options.onSecrets) {
      const newSecrets = [...secrets].filter((value) => !notifiedSecrets.has(value));
      if (newSecrets.length > 0) {
        for (const value of newSecrets) notifiedSecrets.add(value);
        options.onSecrets(newSecrets);
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

/** 既に読み込み済みの Flow と、その読み込み元ファイルパスの組 */
export interface LoadedFlowEntry {
  filePath: string;
  flow: Flow;
}

/**
 * 既に loadFlow 済みの Flow 群を、runFlows と同じ集約ロジック(runId 共有・durationMs・status 集計)で
 * 順次実行する。呼び出し元(CLI の run コマンド等)が実行前検証で loadFlow 済みの Flow を保持している場合、
 * runFlows(ファイルパスから再度 loadFlow する)を経由せずに実行することで、同じファイルの二重パースを避けられる。
 */
export async function runLoadedFlows(
  entries: LoadedFlowEntry[],
  options: RunFlowOptions = {},
): Promise<RunResult> {
  const runId = options.runId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const runStartedAt = performance.now();

  const flows: FlowResult[] = [];
  for (const { filePath, flow } of entries) {
    const flowResult = await executeFlow(flow, filePath, { ...options, runId });
    flows.push(flowResult);
  }

  const durationMs = performance.now() - runStartedAt;
  const status = aggregateStatus(flows.map((f) => f.status));

  return { runId, startedAt, durationMs, flows, status };
}

/** executeSingleRequest のオプション */
export interface ExecuteSingleRequestOptions {
  /** 検証前の生のリクエスト定義。内部で requestSchema.parse を通す(検証エラーは ZodError のまま投げる) */
  request: unknown;
  cwd?: string;
  /**
   * 環境ファイル(environments/<name>.yaml)の名前。未指定なら空の環境として扱う。
   * 呼び出し元(サーバー等)がリクエストボディ由来の値をそのまま渡すため、明示的な undefined を許容する
   */
  envName?: string | undefined;
  /** 履歴書き込みの有無。既定は true(executeFlow の DEFAULT_HISTORY と同じ) */
  history?: boolean;
  /**
   * 実行完了時に、収集済みの secrets({{env.X}} で解決した値)を呼び出し元へ渡すコールバック。
   * RunFlowOptions.onSecrets と同じ用途・シグネチャ。未指定の場合は何もしない。
   */
  onSecrets?: (secrets: readonly string[]) => void;
}

/** executeSingleRequest の結果 */
export interface ExecuteSingleRequestResult {
  result: StepResult;
}

/**
 * フロー定義ファイルを介さず、単一のリクエスト定義を実行する(UI からの単発実行機能向け)。
 * 内部では合成した1ステップのフローとして executeStep を呼ぶだけだが、executeStep 自体は
 * 履歴書き込み・シークレットマスクを行わないため、ここで executeFlow と同じ処理
 * (maskHistoryEntry → appendHistory)を明示的に行う必要がある。
 */
export async function executeSingleRequest(
  options: ExecuteSingleRequestOptions,
): Promise<ExecuteSingleRequestResult> {
  const cwd = options.cwd ?? process.cwd();
  const request = requestSchema.parse(options.request);
  const environment = await loadEnvironment(cwd, undefined, options.envName);
  // 単発実行(server/UI 経由)は allowProtected を受け取らないため、保護環境は常に拒否される
  // (v1 の意図的な挙動。--allow-protected は CLI の run コマンド専用)
  const protectedBlockedError = checkEnvironmentAllowed(options.envName, environment, undefined);
  const runId = randomUUID();
  const flowName = "(single)";
  const captures: Record<string, unknown> = {};
  const secrets = new Set<string>();
  const templateContext: TemplateContext = {
    captures,
    env: toTemplateVariables(environment),
    secrets,
  };
  const step: Step = { name: "request", request };

  // 単発実行(UI からの単発リクエスト実行)は record/replay の対象外(フロー実行専用機能のため)
  const outcome = await executeStep(
    step,
    templateContext,
    runId,
    flowName,
    undefined,
    protectedBlockedError,
  );

  const shouldWriteHistory = options.history ?? DEFAULT_HISTORY;
  if (shouldWriteHistory && outcome.historyEntry) {
    const maskedEntry = maskHistoryEntry({ ...outcome.historyEntry, source: "single" }, [
      ...secrets,
    ]);
    try {
      await appendHistory(cwd, maskedEntry);
    } catch {
      // 単発実行には executeFlow の onWarning のような通知先が無いため、
      // 履歴書き込み失敗はステップ結果に影響させず無視する(executeFlow の警告握りつぶし方針と同じ考え方)
    }
  }

  // 実行完了時点で収集済みの secrets を呼び出し元へ渡す(履歴とは別経路のマスク用)
  options.onSecrets?.([...secrets]);

  return { result: outcome.result };
}
