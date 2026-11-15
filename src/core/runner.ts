import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { JSONPath } from "jsonpath-plus";
import { compileUserRegex, evaluateAssertions } from "./assert.js";
import { expandAuth, type OAuth2Params } from "./auth.js";
import {
  appendCassetteEntry,
  buildCassetteEntry,
  type CassetteEntry,
  cassetteEntryToHttpResponse,
  findCassetteEntry,
  loadCassetteIndex,
} from "./cassette.js";
import { evaluateCondition } from "./condition.js";
import type { DataRow } from "./data.js";
import { getProtectedMode, loadEnvironment, toTemplateVariables } from "./env.js";
import { GuardRefusalError, KlausError, ParseError, RuntimeError } from "./errors.js";
import {
  checkHostAllowed,
  findMethodOverrideHeader,
  type GuardOptions,
  isSafeMethod,
} from "./guard.js";
import type { HistoryActor, HistoryEntry, HistoryGit } from "./history.js";
import { appendHistory, maskHistoryEntry, toHistoryFilePath } from "./history.js";
import type { HttpRequestOptions, HttpResponse, RawHttpResponse } from "./http.js";
import { sendRawRequest, sendRequest } from "./http.js";
import {
  type FollowResult,
  findHostHeaderMismatch,
  HttpSession,
  mergeHttpConfig,
} from "./http-session.js";
import { loadFlow } from "./loader.js";
import type { OpenApiValidator } from "./openapi.js";
import { type BodyPayload, expandBodyForm, materializePayload } from "./request-body.js";
import type {
  AssertDef,
  AuthDef,
  CaptureDef,
  Environment,
  Flow,
  HttpConfig,
  RequestDef,
  Step,
} from "./schema.js";
import { requestSchema } from "./schema.js";
import {
  buildSnapshotKey,
  findSnapshotKeyProblem,
  normalizeSnapshotSpec,
  SnapshotStore,
  summarizeSnapshots,
} from "./snapshot.js";
import { receiveSse } from "./sse.js";
import { renderDeep, renderHeaders, renderString, type TemplateContext } from "./template.js";
import type {
  AssertionResult,
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
  /** --data 実行時のみ設定される 1 始まりのイテレーション番号(runLoadedFlows のデータ駆動ループ参照) */
  iteration?: number;
  /**
   * --jobs 2 以上での並列実行時のみ設定される、runLoadedFlows が展開したユニット(行 × フローの組)の
   * 0 始まりの入力順インデックス。フロー名は複数ファイルにまたがって重複し得るため
   * (klaus にファイル間のフロー名一意性制約は無い)、flow 名 + iteration だけでは実行ユニットを
   * 一意に特定できない。呼び出し元(CLI の text レポーター)が完了順ではなく入力順で出力を
   * 並び替えるためのキーとして使う想定。--jobs 未指定・1 の場合(既定の逐次実行)は常に undefined
   */
  unitIndex?: number;
}

/** ステップ完了時(passed/failed/error/skipped 確定後)に onStepComplete へ渡されるコンテキスト */
export interface StepCompleteContext {
  flow: string;
  file: string;
  result: StepResult;
  /** --data 実行時のみ設定される 1 始まりのイテレーション番号(runLoadedFlows のデータ駆動ループ参照) */
  iteration?: number;
  /** StepStartContext.unitIndex と同じ意味・同じ条件でのみ設定される */
  unitIndex?: number;
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
  /**
   * 送信先ホストの許可リストなどの安全柵。呼び出し元(CLI・server)が klaus.config.yaml の `guard` を
   * 読んで渡す(core は設定ファイルを読まない)。未指定なら制限なし。--allow-protected のような
   * 上書き手段は設けない。判定は送信直前のテンプレート展開後 URL に対して行う(--replay 時は送信しないため対象外)
   */
  guard?: GuardOptions | undefined;
  /**
   * 実行単位の HTTP クライアント設定(klaus.config.yaml の `http`)。呼び出し元(CLI・server)が設定ファイルから
   * 組み立てて渡す(core は設定ファイルを読まない)。フローの `http` が上書きできるのは followRedirects /
   * maxRedirects / cookies のみで、通信の行き先・信頼先を決める proxy と tls は、このオプション(= 所有者が
   * 管理する設定ファイルの値)でしか指定できない。ライブラリとして直接呼ぶ場合、このオプションを渡す呼び出し元は
   * 信頼された側として扱う(フロー内容からは設定できない)。tls の ca / cert / key は設定ファイル基準の
   * 絶対パスにして渡すこと。未指定なら従来どおり(追従なし・cookie なし・proxy なし)
   */
  http?: HttpConfig | undefined;
  /** 履歴エントリの actor に記録する実行主体。core は推定せず、呼び出し元が渡した値をそのまま記録する */
  actor?: HistoryActor | undefined;
  /** 履歴エントリの git に記録する実行時点の git の状態。core は取得せず、呼び出し元が渡した値をそのまま記録する */
  git?: HistoryGit | undefined;
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
  /**
   * データ駆動実行(--data)の行データ。runLoadedFlows でのみ参照する(行(外側) × フロー(内側)の
   * イテレーション優先順で反復し、各行を variables へ合成して executeFlow に渡す)。
   * runFlow/executeFlow は dataRows を直接読まない(executeFlow は下記 iteration のみを見る)。
   * 未指定・空配列の場合は従来どおり(--data 無し)の単一実行のまま
   */
  dataRows?: DataRow[] | undefined;
  /**
   * --data 実行時、この呼び出しが何行目(1 始まり)かを表す。runLoadedFlows がデータ行ごとの
   * executeFlow 呼び出しに設定し、FlowResult.iteration・HistoryEntry.iteration・
   * StepStartContext/StepCompleteContext.iteration に伝播させる。--data 未指定時は常に undefined
   */
  iteration?: number | undefined;
  /**
   * --jobs 2 以上の並列実行時のみ runLoadedFlows が設定する、実行ユニット(行 × フローの組)の
   * 0 始まりの入力順インデックス。StepStartContext/StepCompleteContext.unitIndex にそのまま伝播させる。
   * executeFlow を直接呼ぶ場合(runLoadedFlows を経由しない場合)は指定不要
   */
  unitIndex?: number | undefined;
  /**
   * runLoadedFlows でのみ参照する、実行ユニット(行 × フローの組。--data 未指定時は行がフロー数に一致)を
   * 並列実行するワーカー数。1(既定)なら従来どおりの逐次実行(コード経路も分岐しない: 出力・履歴の
   * バイト単位の後方互換を保つため)。2 以上を指定すると、entries(× dataRows)を展開したユニット列に対して
   * この数のワーカーで同時実行する。RunResult.flows の順序は常に入力順(行(外側) × フロー(内側))を保つ
   * (完了順ではなく、実行前に確保した配列へ index 書き込みする)。executeFlow/runFlow は本フィールドを
   * 読まない(runLoadedFlows 専用)
   */
  jobs?: number | undefined;
  /**
   * スナップショットアサーション(assert.snapshot)の動作。呼び出し元(CLI の --update-snapshots / --ci)が決めて渡す
   * (core は環境変数 CI を読まない)。未指定なら update も ci も false: 基準が無ければ書き込んで成功にし、
   * 不一致は失敗にする。--replay(recording.mode === "replay")のときは基準を一切書かない(update も無視する)
   */
  snapshots?: { update?: boolean | undefined; ci?: boolean | undefined } | undefined;
  /**
   * runLoadedFlows が実行全体で共有するスナップショットの状態(内部用)。指定されたフローの実行は書き込みを
   * このストアに溜めるだけで、書き込みは runLoadedFlows が最後に一度だけ行う。直接 executeFlow を呼ぶ場合は
   * 指定しない(その場合はフロー 1 回の実行ごとに作って書き込む)
   */
  snapshotStore?: SnapshotStore | undefined;
  /**
   * OpenAPI の検証器(CLI の --openapi)。指定すると、HTTP ステップの応答を仕様に照らして検証し(kind "openapi" の
   * アサーションを足す)、カバレッジを検証器へ集める。SSE / WebSocket とリダイレクトを追ったステップは対象外
   * (検証器へ対象外として記録する)。実行全体で 1 つの検証器を共有するため、集計は呼び出し元が検証器から取り出す
   */
  openapi?: OpenApiValidator | undefined;
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
  /**
   * レスポンス受信直後(カセットへの書き込みより前)に呼ぶ。cookie jar が Set-Cookie の値を secrets に
   * 登録するために使い、record 時にそのレスポンス自身の cookie 値もマスクされた状態でカセットに残す
   */
  onResponse?: (response: HttpResponse) => void,
): Promise<HttpResponse> {
  if (!recording) {
    const response = await sendRequest(requestOptions);
    onResponse?.(response);
    return response;
  }
  if (recording.mode === "replay") {
    const secretList = secrets ? [...secrets] : [];
    // カセットファイル自体の読み込みに失敗している場合は、ここで初めて RuntimeError を投げる
    // (executeStep の try/catch でステップ error になり、記録外リクエストと同じ経路で exit 3 になる)
    if (recording.replayLoadError) throw recording.replayLoadError;
    // 読み込み成功時は executeFlow が必ず replayIndex を設定済みにする
    const index = recording.replayIndex as Map<string, CassetteEntry>;
    const entry = findCassetteEntry(index, requestOptions.method, requestOptions.url, secretList);
    const replayed = cassetteEntryToHttpResponse(entry);
    onResponse?.(replayed);
    return replayed;
  }
  const response = await sendRequest(requestOptions);
  onResponse?.(response);
  // onResponse で増えた secrets(cookie 値など)を含めるため、送信後に一覧を取る
  const secretList = secrets ? [...secrets] : [];
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
export function isSseStep(step: Step): boolean {
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

/** URL 文字列中の `{{name}}` 形式のプレースホルダー */
const PLACEHOLDER_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

/** URLSearchParams(application/x-www-form-urlencoded)と同じ形式で値をエンコードする */
function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

/**
 * query の値をエンコードする。dry-run で前段の capture に依存して未解決のまま残した `{{name}}` は
 * (エンコードすると `%7B%7Bname%7D%7D` になり未解決であることが読めなくなるため)そのまま残す。
 */
function encodeQueryValue(value: string, deferred: ReadonlySet<string> | undefined): string {
  if (!deferred || deferred.size === 0) return formEncode(value);
  let result = "";
  let last = 0;
  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    if (!deferred.has((match[1] as string).trim())) continue;
    result += formEncode(value.slice(last, match.index)) + match[0];
    last = (match.index as number) + match[0].length;
  }
  return result + formEncode(value.slice(last));
}

/**
 * request.query(テンプレート展開後)を URL のクエリ文字列にマージする。
 * URL に既にある同名キーは query 側の値で上書きする(最初の出現位置で置き換え、以降の同名は除く)。
 * query 未指定・空の場合は url をそのまま返す。
 * URL に書かれたクエリ部分は組み直さず、書かれたままの文字列で保つ(`&` `+` `=` `/` を含む値を
 * 再分割・再エンコードして壊さないため。マスク対象の値も送信される形のまま一致する)。
 * 追加するパラメーターだけを form-urlencoded 形式で足す。
 */
function applyQueryParams(
  url: string,
  query: Record<string, string> | undefined,
  templateContext: TemplateContext,
): string {
  if (!query || Object.keys(query).length === 0) return url;

  const hashIndex = url.indexOf("#");
  const beforeHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : url.slice(hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const rawBase = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  const literalQuery = queryIndex === -1 ? "" : beforeHash.slice(queryIndex + 1);

  // dry-run で未解決の `{{name}}` を含む URL は URL として解釈できないため、正規化せずそのまま扱う
  const hasDeferred =
    templateContext.deferred !== undefined && new RegExp(PLACEHOLDER_PATTERN).test(rawBase);
  let base = rawBase;
  if (!hasDeferred) {
    try {
      base = new URL(rawBase).toString();
    } catch {
      throw new RuntimeError("request URL is not a valid URL");
    }
  }

  const segments = literalQuery === "" ? [] : literalQuery.split("&");
  const segmentName = (segment: string): string => {
    const rawName = segment.split("=", 1)[0] as string;
    return [...new URLSearchParams(rawName).keys()][0] ?? "";
  };
  for (const [key, rawValue] of Object.entries(query)) {
    const value = renderString(rawValue, templateContext);
    const encoded = `${formEncode(key)}=${encodeQueryValue(value, templateContext.deferred)}`;
    const first = segments.findIndex((segment) => segmentName(segment) === key);
    if (first === -1) {
      segments.push(encoded);
      continue;
    }
    segments[first] = encoded;
    for (let i = segments.length - 1; i > first; i--) {
      if (segmentName(segments[i] as string) === key) segments.splice(i, 1);
    }
  }
  return `${base}${segments.length > 0 ? `?${segments.join("&")}` : ""}${hash}`;
}

/** expandStepRequest が返す、テンプレート展開済みの送信内容 */
export interface ExpandedStepRequest {
  /** ステップの種別。ws は WebSocket、sse は Accept: text/event-stream または sse ブロックのある HTTP、それ以外は http */
  kind: "http" | "sse" | "ws";
  /**
   * 展開後の送信内容。WS ステップは method が "WS" で、body は送信するメッセージ列(送信なしなら undefined)になる
   */
  snapshot: RequestSnapshot;
  /**
   * OAuth2 client credentials を使うステップの設定。実行時(executeStep)にトークンを取得して Authorization ヘッダーを
   * 差し替える。dry-run は取得せず、snapshot のヘッダーにプレースホルダーが入ったままになる
   */
  oauth2?: OAuth2Params;
  /** multipart / bodyFile のとき、送信直前にファイルを読んで組み立てるための入力(内容は持たない) */
  payload?: BodyPayload;
}

/** expandStepRequest の追加入力 */
export interface ExpandOptions {
  /** http.auth(ステップの request.auth が無いときに使う既定の認証ヘルパー) */
  defaultAuth?: AuthDef | undefined;
  /** multipart のファイルパートと bodyFile の相対パスの基準(cwd。この配下のファイルだけ送れる)。既定は process.cwd() */
  cwd?: string | undefined;
}

/**
 * ステップの request / ws をテンプレート展開して、実際に送る内容(RequestSnapshot)にする。
 * 実行時(executeStep)と dry-run(dry-run.ts)が同じ展開結果を得るための共通関数で、
 * 未解決変数・OS 環境変数未定義は RuntimeError を投げる(dry-run は context.deferred で一部を例外にしない)。
 */
export function expandStepRequest(
  step: Step,
  templateContext: TemplateContext,
  options: ExpandOptions = {},
): ExpandedStepRequest {
  if (step.ws) {
    const url = renderString(step.ws.url, templateContext);
    const headers = renderHeaders(step.ws.headers, templateContext);
    const sendItems = (step.ws.send ?? []).map((item) =>
      typeof item === "string"
        ? renderString(item, templateContext)
        : renderDeep(item, templateContext),
    );
    return {
      kind: "ws",
      snapshot: {
        method: "WS",
        url,
        headers,
        body: sendItems.length > 0 ? sendItems : undefined,
      },
    };
  }
  if (!step.request) {
    // schema 側の superRefine で request/ws のいずれか必須を検証済みのため、通常はここに来ない
    throw new RuntimeError(`step "${step.name}" has neither request nor ws defined`);
  }
  const request = step.request;
  const method = resolveRequestMethod(request);
  const url = applyQueryParams(
    renderString(request.url, templateContext),
    request.query,
    templateContext,
  );
  const renderedHeaders = renderHeaders(request.headers, templateContext);
  // 認証ヘルパー(request.auth、無ければ http.auth)。basic / bearer はここでヘッダーが確定し、
  // oauth2 は実行時にトークンを取得する(ここではネットワークに出ない)
  const auth = expandAuth(request.auth, options.defaultAuth, templateContext, renderedHeaders);
  const authHeaders = auth ? { ...renderedHeaders, Authorization: auth.header } : renderedHeaders;
  // form / multipart / bodyFile。ファイルは cwd 配下に限り、履歴にはファイル名とサイズだけを残す
  const bodyForm = expandBodyForm(request, templateContext, options.cwd ?? process.cwd());
  const hasContentType = Object.keys(authHeaders).some(
    (name) => name.toLowerCase() === "content-type",
  );
  const headers =
    bodyForm?.contentType !== undefined && !hasContentType
      ? { ...authHeaders, "Content-Type": bodyForm.contentType }
      : authHeaders;
  const body = bodyForm ? bodyForm.snapshotBody : buildRequestBody(request, templateContext);
  return {
    kind: isSseStep(step) ? "sse" : "http",
    snapshot: { method, url, headers, body },
    ...(auth?.kind === "oauth2" ? { oauth2: auth.params } : {}),
    ...(bodyForm?.payload ? { payload: bodyForm.payload } : {}),
  };
}

/** capture のオブジェクト形式(header / cookie / regex / status)が参照するレスポンス側の情報 */
export interface CaptureResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  /** run 内の cookie jar から名前で値を引く(jar が無効・該当なしなら undefined) */
  cookie: (name: string) => string | undefined;
}

/**
 * capture 定義に従ってレスポンスから変数を抽出する。
 * - 文字列: JSON レスポンスに対する JSONPath。評価例外・マッチなし(wrap:false で undefined)は
 *   無警告で "undefined" を格納せず RuntimeError を投げてステップを error にする。JSONPath が正当に null を返した場合は成功。
 * - {header}: レスポンスヘッダー(名前は大文字小文字を無視)。無ければ RuntimeError。
 * - {cookie}: cookie jar の値。無ければ RuntimeError。
 * - {regex, group?}: レスポンス本文テキストへの正規表現。不一致・グループ範囲外は RuntimeError。
 * - {status: true}: ステータスコード(数値)。
 * エラーメッセージには取得した値を含めない(秘密を含み得るため)。
 */
export function captureValues(
  captureDef: Record<string, CaptureDef> | undefined,
  json: unknown,
  stepName: string,
  response?: CaptureResponse,
): Record<string, unknown> {
  if (!captureDef) return {};
  const result: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(captureDef)) {
    const where = `capture "${name}"`;
    if (typeof def === "string") {
      let value: unknown;
      try {
        value = JSONPath({ path: def, json: json as never, wrap: false });
      } catch (error) {
        throw new RuntimeError(
          `${where}: failed to evaluate JSONPath "${def}" (step "${stepName}"): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (value === undefined) {
        throw new RuntimeError(`${where}: JSONPath "${def}" matched no value (step "${stepName}")`);
      }
      result[name] = value;
      continue;
    }
    if (!response) {
      throw new RuntimeError(
        `${where}: header / cookie / regex / status captures need an HTTP response (step "${stepName}")`,
      );
    }
    if ("status" in def) {
      result[name] = response.status;
    } else if ("header" in def) {
      const wanted = def.header.toLowerCase();
      const entry = Object.entries(response.headers).find(([key]) => key.toLowerCase() === wanted);
      if (!entry) {
        throw new RuntimeError(
          `${where}: response header "${def.header}" not found (step "${stepName}")`,
        );
      }
      result[name] = entry[1];
    } else if ("cookie" in def) {
      const value = response.cookie(def.cookie);
      if (value === undefined) {
        throw new RuntimeError(
          `${where}: cookie "${def.cookie}" not found in the cookie jar (is http.cookies enabled?) (step "${stepName}")`,
        );
      }
      result[name] = value;
    } else {
      let match: RegExpMatchArray | null;
      try {
        match = response.bodyText.match(compileUserRegex(def.regex));
      } catch (error) {
        throw new RuntimeError(
          `${where}: invalid regex /${def.regex}/ (step "${stepName}"): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!match) {
        throw new RuntimeError(
          `${where}: regex /${def.regex}/ matched nothing (step "${stepName}")`,
        );
      }
      const group = def.group ?? (match.length > 1 ? 1 : 0);
      const value = match[group];
      if (value === undefined) {
        throw new RuntimeError(
          `${where}: regex /${def.regex}/ has no group ${group} that matched (step "${stepName}")`,
        );
      }
      result[name] = value;
    }
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
  status: "passed" | "failed" | "skipped" | "error",
  /** --data 実行時のみ設定する 1 始まりのイテレーション番号(RunFlowOptions.iteration をそのまま伝播させる) */
  iteration?: number,
): Pick<
  HistoryEntry,
  "v" | "runId" | "flow" | "step" | "startedAt" | "durationMs" | "status" | "iteration"
> {
  return {
    v: 1,
    runId,
    flow,
    step,
    startedAt,
    durationMs,
    status,
    ...(iteration !== undefined ? { iteration } : {}),
  };
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

/** executeStep が送信直前に参照する安全柵の状態(環境の保護モードと送信先の許可リスト) */
export interface StepGuard {
  /** $protected: true の環境へ --allow-protected なしで実行しようとした場合の拒否エラー(全ステップを拒否する) */
  blockedError?: GuardRefusalError;
  /**
   * $protected: "readonly" の環境へ --allow-protected なしで実行する場合の環境表示名。
   * 設定されている間は GET / HEAD / OPTIONS 以外の送信(WebSocket を含む)を送信直前に拒否する
   */
  readonlyEnvName?: string;
  /** 送信先ホストの許可リスト等(RunFlowOptions.guard / ExecuteSingleRequestOptions.guard) */
  options?: GuardOptions;
  /** 単発リクエスト(klaus req / UI の単発実行)の判定か。拒否メッセージの案内を切り替えるために使う */
  singleRequest?: boolean;
}

/**
 * 保護環境による拒否メッセージの末尾に付ける案内。フロー実行(klaus run)には --allow-protected があるが、
 * 単発リクエストにはそのオプションが無いため、案内を切り替える。
 */
function protectionHint(singleRequest: boolean | undefined): string {
  return singleRequest === true
    ? "Single requests (klaus req, klaus ui) cannot override environment protection; run a flow with `klaus run --allow-protected` instead."
    : "Pass --allow-protected to run against this environment intentionally.";
}

/**
 * 送信(接続)直前の安全柵判定。違反時は GuardRefusalError を投げ、executeStep の catch で
 * ステップ error(exit 3)になり、監査のため履歴にも記録される。
 * 判定順は「保護環境(true)の全面拒否 → 読み取り専用モードのメソッド → メソッド上書きヘッダー → 送信先ホスト」。
 * method はテンプレート展開後の実際に送るメソッド(WS ステップは "WS")。
 * skipHostCheck は --replay 用(実送信がないため送信先ホストを判定しない)。
 */
export function assertSendAllowed(
  stepGuard: StepGuard | undefined,
  method: string,
  url: string,
  headers: Record<string, string> | undefined,
  skipHostCheck: boolean,
): void {
  if (!stepGuard) return;
  if (stepGuard.blockedError) throw stepGuard.blockedError;
  if (stepGuard.readonlyEnvName !== undefined && !isSafeMethod(method)) {
    throw new GuardRefusalError(
      `environment "${stepGuard.readonlyEnvName}" is protected ($protected: readonly) and only allows GET, HEAD, and OPTIONS by default; ` +
        `refusing ${method === "WS" ? "WebSocket" : method}. ` +
        protectionHint(stepGuard.singleRequest),
    );
  }
  // 安全メソッドの GET でも、サーバー側のメソッド上書きヘッダーで書き込みに化けさせられるため拒否する
  const overrideHeader =
    stepGuard.readonlyEnvName !== undefined ? findMethodOverrideHeader(headers) : undefined;
  if (overrideHeader !== undefined) {
    throw new GuardRefusalError(
      `environment "${stepGuard.readonlyEnvName}" is protected ($protected: readonly) and refuses requests carrying the ${overrideHeader} header, which can turn a read into a write. ` +
        protectionHint(stepGuard.singleRequest),
    );
  }
  // 許可リストの指定時は、URL と違う Host ヘッダーを拒否する(Host ルーティングで許可リスト外の仮想ホストへ到達できるため)
  if (!skipHostCheck && stepGuard.options?.allowedHosts !== undefined) {
    const mismatch = findHostHeaderMismatch(url, headers);
    if (mismatch !== undefined) {
      throw new GuardRefusalError(
        `refusing a Host header that differs from the request URL while guard.allowedHosts is set (Host: "${mismatch}")`,
      );
    }
  }
  if (!skipHostCheck) {
    const hostError = checkHostAllowed(url, stepGuard.options);
    if (hostError) throw hostError;
  }
}

/** executeStep が assert.snapshot を評価するために受け取る、フロー実行ごとのスナップショットの文脈 */
interface SnapshotRuntime {
  store: SnapshotStore;
  /** フロー定義ファイルのパス(スナップショットファイルの場所を決める) */
  flowFilePath: string;
  /** 保護環境($protected)に対する実行か */
  protectedEnv: boolean;
}

/** ステップの assert.snapshot を評価して、アサーション結果を返す(指定が無ければ空配列) */
function evaluateStepSnapshot(
  def: AssertDef | undefined,
  stepName: string,
  iteration: number | undefined,
  runtime: SnapshotRuntime | undefined,
  response: { status: number; headers: Record<string, string>; body: unknown },
  secrets: ReadonlySet<string> | undefined,
  otherAssertionsOk: boolean,
): AssertionResult[] {
  if (def?.snapshot === undefined) return [];
  if (!runtime) {
    return [
      {
        ok: false,
        kind: "snapshot",
        message: "snapshot assertions are only available when running a flow",
      },
    ];
  }
  const spec = normalizeSnapshotSpec(def.snapshot);
  return [
    runtime.store.evaluate({
      flowFilePath: runtime.flowFilePath,
      key: buildSnapshotKey(stepName, iteration, spec.name),
      spec,
      response,
      secrets: secrets ? [...secrets] : [],
      protectedEnv: runtime.protectedEnv,
      otherAssertionsOk,
    }),
  ];
}

/** SSE / WebSocket ステップに指定された assert.snapshot の、未対応を知らせる失敗アサーション */
function unsupportedSnapshotAssertion(def: AssertDef | undefined): AssertionResult[] {
  if (def?.snapshot === undefined) return [];
  return [
    {
      ok: false,
      kind: "snapshot",
      message: "snapshot assertions are not supported for SSE and WebSocket steps",
    },
  ];
}

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
   * 保護環境の拒否・読み取り専用モード・送信先ホスト許可リストの判定に使う安全柵の状態。
   * blockedError が指定されている場合、リクエスト送信前にこれを投げてステップを error にする
   * (record/replay モードで replayLoadError を遅延して投げるのと同じ考え方)。
   */
  stepGuard: StepGuard | undefined,
  /** --data 実行時のみ設定する 1 始まりのイテレーション番号(historyEntry.iteration に伝播させる) */
  iteration: number | undefined,
  /** 実行単位の HTTP クライアント(proxy / TLS / cookie jar / リダイレクト)。ステップ間で共有する */
  session: HttpSession,
  /** multipart / bodyFile のファイルを読む基準ディレクトリ(この配下のファイルだけ送れる) */
  cwd: string,
  /** assert.snapshot の評価に使うスナップショットの状態(フロー実行のときだけ渡す) */
  snapshots?: SnapshotRuntime,
  /** 応答を OpenAPI の仕様に照らす検証器(--openapi 指定時のみ) */
  openapi?: OpenApiValidator,
): Promise<{
  result: StepResult;
  captured: Record<string, unknown>;
  historyEntry?: HistoryEntry;
}> {
  const startedAt = new Date().toISOString();
  let requestSnapshot: RequestSnapshot | undefined;

  // WS/SSE/HTTP 各分岐の結果組み立てを共通化する。キー順は
  // base → request → 分岐固有フィールド(resultExtra / historyExtra)→ assertions を維持する
  // (WS は StepResult に wsMessages、HistoryEntry に response を持つため extra を別々に受け取る)。
  const finish = (
    request: RequestSnapshot,
    durationMs: number,
    assertions: StepResult["assertions"],
    captured: Record<string, unknown>,
    resultExtra: Pick<
      StepResult,
      "response" | "events" | "wsMessages" | "redirects" | "droppedHeaders"
    >,
    historyExtra: Pick<HistoryEntry, "response" | "events" | "redirects" | "droppedHeaders">,
  ): { result: StepResult; captured: Record<string, unknown>; historyEntry: HistoryEntry } => {
    const status = assertions.every((a) => a.ok) ? "passed" : "failed";
    return {
      result: {
        ...buildStepResultBase(step.name, startedAt, durationMs, status),
        request,
        ...resultExtra,
        assertions,
      },
      captured,
      historyEntry: {
        ...buildHistoryBase(runId, flowName, step.name, startedAt, durationMs, status, iteration),
        request,
        ...historyExtra,
        assertions,
      },
    };
  };

  try {
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
      requestSnapshot = expandStepRequest(step, templateContext).snapshot;
      const { url, headers } = requestSnapshot;
      const sendItems = (requestSnapshot.body ?? []) as unknown[];

      // 送信(接続)直前の判定。WebSocket は読み取り専用の保護環境でも常に拒否する(record/replay は WS 非対応)
      assertSendAllowed(stepGuard, "WS", url, headers, false);
      openapi?.exclude(flowName, step.name, "websocket");
      const wsTarget = session.prepareWebSocket(url, headers, templateContext);

      const wsResult = await connectWebSocket({
        url,
        headers: wsTarget.headers,
        ...(wsTarget.dispatcher ? { dispatcher: wsTarget.dispatcher } : {}),
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

      // capture は WS ステップでは(SSE と同様)無視する
      return finish(
        requestSnapshot,
        wsResult.durationMs,
        [...assertions, ...unsupportedSnapshotAssertion(assertDef)],
        {},
        { wsMessages: wsResult.messages },
        {
          // response 相当として受信メッセージを body に格納する(status は HTTP の 101 Switching Protocols 相当)
          response: {
            status: 101,
            headers: {},
            body: wsResult.messages.map((m) => m.data),
          },
        },
      );
    }

    if (!step.request) {
      // schema 側の superRefine で request/ws のいずれか必須を検証済みのため、通常はここに来ない
      throw new RuntimeError(`step "${step.name}" has neither request nor ws defined`);
    }
    const request = step.request;

    // テンプレート展開(未解決変数・OS 環境変数未定義は RuntimeError として catch 節に落ちる)
    // graphql 指定時のみ method 省略可であり、その場合は POST を既定にする
    const expanded = expandStepRequest(step, templateContext, {
      defaultAuth: session.defaultAuth,
      cwd,
    });
    let snapshot = expanded.snapshot;
    if (expanded.oauth2) {
      // トークンを取得して Authorization ヘッダーを差し替える。送信するリクエスト本体の安全柵を先に判定し、
      // 拒否されるリクエストのためにクライアントシークレットをトークンエンドポイントへ送らないようにする。
      // トークン取得リクエストも同じ判定・record/replay を通る
      const oauthReplay = recording?.mode === "replay";
      assertSendAllowed(stepGuard, snapshot.method, snapshot.url, snapshot.headers, oauthReplay);
      const authorization = await session.oauth2Header(
        expanded.oauth2,
        templateContext,
        (hopMethod, hopUrl, hopHeaders) =>
          assertSendAllowed(stepGuard, hopMethod, hopUrl, hopHeaders, oauthReplay),
        (hopOptions, onResponse) =>
          resolveHttpResponse(recording, hopOptions, templateContext.secrets, onResponse),
        oauthReplay,
        request.timeoutMs,
      );
      snapshot = { ...snapshot, headers: { ...snapshot.headers, Authorization: authorization } };
    }
    requestSnapshot = snapshot;
    const { method, url, headers, body: snapshotBody } = snapshot;
    // multipart / bodyFile は、履歴用の表現ではなく実際のバイト列・FormData を送る(送信直前にファイルを読む)。
    // multipart の Content-Type は boundary つきで undici が付けるため、送信ヘッダーからは外す
    let body: unknown = snapshotBody;
    let sendHeaders = headers;
    if (expanded.payload) {
      const prepared = await materializePayload(expanded.payload, cwd);
      body = prepared.body;
      if (prepared.dropContentType) {
        sendHeaders = Object.fromEntries(
          Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-type"),
        );
      }
    }

    if (isSseStep(step)) {
      openapi?.exclude(flowName, step.name, "sse");
      // SSE は HTTP メソッドに従う(record/replay は SSE 非対応のため、ここでは常に実送信になる)
      const sseFollow: Omit<FollowResult<unknown>, "response"> = {
        redirects: [],
        elapsedMs: 0,
        droppedHeaders: [],
      };
      const sseResult = await receiveSse(
        {
          method,
          url,
          headers: sendHeaders,
          body,
          timeoutMs: request.timeoutMs,
          maxResponseBytes: session.maxResponseBytes,
        },
        step.sse,
        async (connectOptions) => {
          // 初回・リダイレクト先を含む各ホップで同じ安全柵の判定を通す
          const followed = await session.send<RawHttpResponse>(
            connectOptions,
            templateContext,
            (hopMethod, hopUrl, hopHeaders) =>
              assertSendAllowed(stepGuard, hopMethod, hopUrl, hopHeaders, false),
            async (hopOptions, onResponse) => {
              const raw = await sendRawRequest(hopOptions);
              onResponse(raw);
              return raw;
            },
            (raw) => {
              // 読み捨てるボディの破棄で出る AbortError を握りつぶす(リダイレクト先へ進むため)
              raw.bodyStream.on("error", () => {});
              raw.bodyStream.destroy();
            },
            false,
          );
          sseFollow.redirects = followed.redirects;
          sseFollow.elapsedMs = followed.elapsedMs;
          sseFollow.droppedHeaders = followed.droppedHeaders;
          return followed.response;
        },
      );

      const assertions = evaluateAssertions(assertDef, {
        status: sseResult.status,
        headers: sseResult.headers,
        body: undefined,
        bodyText: "",
        durationMs: sseResult.durationMs,
        events: sseResult.events,
      });

      // SSE では response.body に events を二重保持しない(受信イベントは StepResult.events 側に格納する)
      const responseSnapshot: ResponseSnapshot = {
        status: sseResult.status,
        headers: sseResult.headers,
        body: undefined,
      };
      const extra = {
        response: responseSnapshot,
        events: sseResult.events,
        ...(sseFollow.redirects.length > 0 ? { redirects: sseFollow.redirects } : {}),
        ...(sseFollow.droppedHeaders.length > 0
          ? { droppedHeaders: sseFollow.droppedHeaders }
          : {}),
      };

      // capture は JSON レスポンス(SSE 以外)にのみ適用する
      return finish(
        requestSnapshot,
        sseResult.durationMs,
        [...assertions, ...unsupportedSnapshotAssertion(assertDef)],
        {},
        extra,
        extra,
      );
    }

    // 送信直前の判定(テンプレート展開後のメソッド・URL に対して行う)。
    // replay では実送信がないため送信先ホストは判定しない(record は実際に送るため判定する)。
    // リダイレクトを追う場合は、各ホップでも同じ判定(assertSendAllowed)を session.send が再度行う
    const replay = recording?.mode === "replay";
    const followed = await session.send<HttpResponse>(
      { method, url, headers: sendHeaders, body, timeoutMs: request.timeoutMs },
      templateContext,
      (hopMethod, hopUrl, hopHeaders) =>
        assertSendAllowed(stepGuard, hopMethod, hopUrl, hopHeaders, replay),
      (hopOptions, onResponse) =>
        resolveHttpResponse(recording, hopOptions, templateContext.secrets, onResponse),
      () => {},
      replay,
    );
    const { redirects, droppedHeaders } = followed;
    // リダイレクトを追った場合は全ホップの合計を所要時間にする(追わなかった場合は従来どおりの値)
    const response =
      redirects.length > 0
        ? { ...followed.response, durationMs: followed.elapsedMs }
        : followed.response;

    const assertions = evaluateAssertions(assertDef, {
      status: response.status,
      headers: response.headers,
      body: response.body,
      bodyText: response.bodyText,
      durationMs: response.durationMs,
    });
    // cookie は最終ホップの URL に対して jar から引く(リダイレクト途中で付いた cookie も含む)
    const finalUrl = redirects.length > 0 ? (redirects[redirects.length - 1] as string) : url;
    const captured = captureValues(step.capture, response.body, step.name, {
      status: response.status,
      headers: response.headers,
      bodyText: response.bodyText,
      cookie: (cookieName) => session.cookieValue(cookieName, finalUrl),
    });

    const responseSnapshot: ResponseSnapshot = {
      status: response.status,
      headers: response.headers,
      body: response.body,
    };
    const extra = {
      response: responseSnapshot,
      ...(redirects.length > 0 ? { redirects } : {}),
      ...(droppedHeaders.length > 0 ? { droppedHeaders } : {}),
    };

    // OpenAPI: リダイレクトを追った応答は、最初のリクエストに対するものではないため検証せず対象外にする
    let openapiAssertions: AssertionResult[] = [];
    if (openapi !== undefined) {
      if (redirects.length > 0) {
        openapi.exclude(flowName, step.name, "redirected");
      } else {
        openapiAssertions = await openapi.check({
          flow: flowName,
          step: step.name,
          method,
          url,
          response: {
            status: response.status,
            headers: response.headers,
            body: response.body,
            bodyText: response.bodyText,
          },
        });
      }
    }

    // スナップショットは capture が成功した後に評価する(capture の失敗でステップが error になるとき、
    // 基準を書き込む予約だけが残らないようにするため)。OpenAPI の検証の後に評価し、その失敗した応答も基準にしない
    const snapshotAssertions = evaluateStepSnapshot(
      assertDef,
      step.name,
      iteration,
      snapshots,
      responseSnapshot,
      templateContext.secrets,
      [...assertions, ...openapiAssertions].every((assertion) => assertion.ok),
    );

    return finish(
      requestSnapshot,
      response.durationMs,
      [...assertions, ...snapshotAssertions, ...openapiAssertions],
      captured,
      extra,
      extra,
    );
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
    // 安全柵による拒否は監査のため履歴にも残す(送信しようとした内容は masked 済みで request に入る)。
    // それ以外の実行時エラー(接続不能・タイムアウト等)は従来どおり履歴に書かない
    if (error instanceof GuardRefusalError) {
      return {
        result: stepResult,
        captured: {},
        historyEntry: {
          ...buildHistoryBase(runId, flowName, step.name, startedAt, 0, "error", iteration),
          ...(requestSnapshot ? { request: requestSnapshot } : {}),
          assertions: [],
          error: message,
        },
      };
    }
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
 * 環境が $protected: true かつ許可されていない場合に、ステップへ伝播させる RuntimeError を返す
 * ("readonly" は全面拒否ではなく送信直前にメソッドで判定するため、ここでは undefined を返す)。
 * ここでは投げずに返すだけにし、呼び出し元がリクエスト送信前の executeStep に渡すことで、
 * 各ステップが既存の RuntimeError → ステップ error(exit 3)の経路に自然に乗るようにする
 * (record/replay モードの replayLoadError と同じ「検知は早期・エラー化は遅延」という設計)。
 * エラーメッセージには環境名と回避策(--allow-protected)を明記する。
 */
function checkEnvironmentAllowed(
  envName: string | undefined,
  environment: Environment,
  allowProtected: boolean | undefined,
  singleRequest: boolean | undefined,
): GuardRefusalError | undefined {
  if (getProtectedMode(environment) !== true || allowProtected) return undefined;
  return new GuardRefusalError(
    `environment "${envName}" is protected ($protected: true) and refuses execution by default. ` +
      protectionHint(singleRequest),
  );
}

/**
 * 環境の保護モード・許可リストから、executeStep に渡す安全柵の状態を組み立てる。
 * 何も制限がなければ undefined(従来どおりの経路)。
 */
export function buildStepGuard(
  envName: string | undefined,
  environment: Environment,
  allowProtected: boolean | undefined,
  guard: GuardOptions | undefined,
  /** 単発リクエストの判定なら true(拒否メッセージの案内が flow 実行用の --allow-protected から切り替わる) */
  singleRequest?: boolean,
): StepGuard | undefined {
  const blockedError = checkEnvironmentAllowed(envName, environment, allowProtected, singleRequest);
  const readonlyEnvName =
    getProtectedMode(environment) === "readonly" && !allowProtected ? String(envName) : undefined;
  if (!blockedError && readonlyEnvName === undefined && guard?.allowedHosts === undefined) {
    return undefined;
  }
  return {
    ...(blockedError ? { blockedError } : {}),
    ...(readonlyEnvName !== undefined ? { readonlyEnvName } : {}),
    ...(guard ? { options: guard } : {}),
    ...(singleRequest === true ? { singleRequest } : {}),
  };
}

/**
 * 履歴エントリへ付与する監査項目(env / file / actor / git)を組み立てる。
 * file は cwd からの相対パス(POSIX 区切り)にし、絶対パスは記録しない。
 * env は --env-file 指定時はそのファイル名のみ(ディレクトリを含む絶対パスを残さないため)。
 */
function buildAuditFields(
  cwd: string,
  filePath: string | undefined,
  envName: string | undefined,
  envFilePath: string | undefined,
  actor: HistoryActor | undefined,
  git: HistoryGit | undefined,
): Pick<HistoryEntry, "env" | "file" | "actor" | "git"> {
  const env = envFilePath !== undefined ? basename(envFilePath) : envName;
  const file = filePath !== undefined ? toHistoryFilePath(cwd, filePath) : undefined;
  return {
    ...(env !== undefined ? { env } : {}),
    ...(file !== undefined ? { file } : {}),
    ...(actor ? { actor } : {}),
    ...(git ? { git } : {}),
  };
}

/**
 * replay モードのカセットを読み込んで ActiveRecording を返す。
 * 読み込み失敗はここでは投げず replayLoadError に保持する(実際の HTTP ステップ実行時まで遅延させる)。
 */
async function loadReplay(dir: string): Promise<ActiveRecording> {
  try {
    const replayIndex = await loadCassetteIndex(dir);
    return { mode: "replay", dir, replayIndex };
  } catch (error) {
    const replayLoadError = error instanceof RuntimeError ? error : new RuntimeError(String(error));
    return { mode: "replay", dir, replayLoadError };
  }
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
  const stepGuard = buildStepGuard(
    options.envFilePath ?? options.envNameOverride ?? flow.env,
    environment,
    options.allowProtected,
    options.guard,
  );
  const auditFields = buildAuditFields(
    cwd,
    filePath,
    options.envNameOverride ?? flow.env,
    options.envFilePath,
    options.actor,
    options.git,
  );
  const historySink = resolveHistorySink(cwd, options.history);

  // replay モードでは実行前にカセットを索引化しておく(ステップごとの再読み込みを避ける。
  // 保持した replayLoadError は resolveHttpResponse で投げる)。
  // record モードは事前読み込み不要(ステップごとに追記するだけでよい)。
  const activeRecording: ActiveRecording | undefined = !options.recording
    ? undefined
    : options.recording.mode === "replay"
      ? await loadReplay(options.recording.dir)
      : { mode: "record", dir: options.recording.dir };

  // スナップショット: runLoadedFlows から共有のストアが渡されればそれを使い、無ければ(snapshot を使うフローに限り)
  // このフロー 1 回の実行専用のストアを作る。--replay は基準を書かない
  const usesSnapshot = flow.steps.some((step) => step.assert?.snapshot !== undefined);
  const keyProblem = usesSnapshot ? findSnapshotKeyProblem(flow) : undefined;
  if (keyProblem !== undefined) throw new ParseError(keyProblem.message, filePath);
  const snapshotStore =
    options.snapshotStore ??
    (usesSnapshot
      ? new SnapshotStore({
          cwd,
          update: options.snapshots?.update === true,
          ci: options.snapshots?.ci === true,
          readOnly: options.recording?.mode === "replay",
        })
      : undefined);
  const ownsSnapshotStore = snapshotStore !== undefined && options.snapshotStore === undefined;
  if (snapshotStore && ownsSnapshotStore) {
    for (const warning of await snapshotStore.preload([{ filePath, usesSnapshot }])) {
      options.onWarning?.(warning);
    }
  }
  const snapshotRuntime: SnapshotRuntime | undefined = snapshotStore
    ? {
        store: snapshotStore,
        flowFilePath: filePath,
        protectedEnv: getProtectedMode(environment) !== false,
      }
    : undefined;

  // ループ内の各コールバックで共通に付与する iteration/unitIndex(設定時のみ)
  const unitContext = {
    ...(options.iteration !== undefined ? { iteration: options.iteration } : {}),
    ...(options.unitIndex !== undefined ? { unitIndex: options.unitIndex } : {}),
  };

  // skipped ステップの StepResult/HistoryEntry を組み立てる(リクエストを送っていないため request/response を持たない)
  const buildSkipped = (
    step: Step,
    reason: string,
  ): { result: StepResult; historyEntry: HistoryEntry } => {
    const skippedStartedAt = new Date().toISOString();
    return {
      result: {
        ...buildStepResultBase(step.name, skippedStartedAt, 0, "skipped"),
        assertions: [],
        error: reason,
      },
      historyEntry: {
        ...buildHistoryBase(
          runId,
          flow.name,
          step.name,
          skippedStartedAt,
          0,
          "skipped",
          options.iteration,
        ),
        assertions: [],
      },
    };
  };

  const captures: Record<string, unknown> = {};
  // {{env.X}} で解決した値をフロー実行全体で蓄積する(履歴に書き込む前のマスクに使う)
  const secrets = new Set<string>();
  // onSecrets で既に通知済みの値(重複通知を避けるため、ステップをまたいで蓄積する)
  const notifiedSecrets = new Set<string>();
  const steps: StepResult[] = [];
  // 実行単位(このフロー 1 回の実行)の HTTP クライアント。フローの http は設定ファイル側(options.http)を
  // キー単位で上書きし、フロー側の tls パスはフロー定義ファイルのディレクトリ基準で解決する
  const session = new HttpSession(mergeHttpConfig(options.http, flow.http), options.onWarning);
  // if 条件式が参照する「ここまでに完了したステップの status」(ステップ名 → status)。
  // continueOnError で継続したステップも実際の status(failed/error)をそのまま入れる
  // (「continueOnError で失敗した前段の実ステータスを条件が見られる」ことが本機能の狙いのため)。
  const stepStatuses = new Map<string, string>();
  const flowStartedAt = performance.now();
  let skipRest = false;

  try {
    for (const step of flow.steps) {
      await options.onStepStart?.({
        flow: flow.name,
        file: filePath,
        step: step.name,
        ...unitContext,
      });

      let result: StepResult;
      let captured: Record<string, unknown> = {};
      let historyEntry: HistoryEntry | undefined;

      if (skipRest) {
        ({ result, historyEntry } = buildSkipped(step, "skipped because a previous step failed"));
      } else {
        // skipRest によるスキップが優先されるため、条件式の評価はここに来た場合のみ行う。
        // 評価結果は「true(実行する)」「false(条件不成立でスキップ)」「例外(不正な式・未知の名前)」の3通り。
        let conditionMet = true;
        let conditionError: RuntimeError | undefined;
        if (step.if !== undefined) {
          try {
            conditionMet = evaluateCondition(step.if, { stepStatuses, captures });
          } catch (error) {
            conditionError =
              error instanceof RuntimeError ? error : new RuntimeError(String(error));
          }
        }

        if (conditionError) {
          // 不正な条件式(文法エラー・未知のステップ/capture 名)はリクエストを送らずステップを error にする。
          // executeStep の catch 節(RuntimeError → ステップ error)と同じ扱いに揃え、historyEntry は書かない
          // (executeStep の catch 節も historyEntry を返さないため、一貫性を優先しここでも undefined のままにする)。
          const erroredAt = new Date().toISOString();
          result = {
            name: step.name,
            status: "error",
            startedAt: erroredAt,
            durationMs: 0,
            assertions: [],
            error: conditionError.message,
          };
        } else if (!conditionMet) {
          ({ result, historyEntry } = buildSkipped(
            step,
            `skipped because condition not met: ${step.if}`,
          ));
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
              stepGuard,
              options.iteration,
              session,
              cwd,
              snapshotRuntime,
              options.openapi,
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
      }

      // 履歴書き込みはステップ結果確定後・主 try/catch の外で行う。
      // 失敗してもステップの status は変えず、onWarning で通知するだけに留める。
      if (historySink && historyEntry) {
        // デフォルトシンク・カスタムシンクのいずれにも、必ずマスク済みのエントリを渡す
        const maskedEntry = maskHistoryEntry({ ...historyEntry, ...auditFields }, [...secrets]);
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
      stepStatuses.set(step.name, result.status);
      Object.assign(captures, captured);

      // continueOnError が true の場合、retry を使い切った後の failed/error でも
      // 以降のステップをスキップしない(このステップ自体の status は変えない)。
      if ((result.status === "error" || result.status === "failed") && !step.continueOnError) {
        skipRest = true;
      }

      await options.onStepComplete?.({
        flow: flow.name,
        file: filePath,
        result,
        ...unitContext,
      });
    }
  } finally {
    // 実行終了時にクライアント(接続・dispatcher)を閉じる。cookie jar と取得済みトークンもここで破棄される
    await session.close();
  }

  // スナップショット: このフローの実行で古いエントリを判定してよいか(全ステップが実行され、snapshot を持つ
  // すべてのステップが評価された)を記録し、自前のストアなら書き込む
  if (snapshotStore) {
    snapshotStore.recordFlowRun(
      filePath,
      steps.length === flow.steps.length &&
        steps.every((result) => result.status !== "skipped") &&
        flow.steps.every(
          (step, index) =>
            step.assert?.snapshot === undefined ||
            steps[index]?.assertions.some((assertion) => assertion.snapshot !== undefined) === true,
        ),
    );
    if (ownsSnapshotStore) {
      const finalized = await snapshotStore.finalize();
      for (const warning of finalized.warnings) options.onWarning?.(warning);
    }
  }

  const durationMs = performance.now() - flowStartedAt;
  const status = aggregateStatus(steps.map((s) => s.status));

  return {
    name: flow.name,
    file: filePath,
    status,
    steps,
    durationMs,
    ...(options.iteration !== undefined ? { iteration: options.iteration } : {}),
  };
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

  const warningSink = collectWarnings(options.onWarning);
  const flows: FlowResult[] = [];
  for (const filePath of filePaths) {
    const flowResult = await runFlow(filePath, {
      ...options,
      runId,
      onWarning: warningSink.onWarning,
    });
    flows.push(flowResult);
  }

  const durationMs = performance.now() - runStartedAt;
  const status = aggregateStatus(flows.map((f) => f.status));

  return {
    runId,
    startedAt,
    durationMs,
    flows,
    status,
    ...(warningSink.warnings.length > 0 ? { warnings: warningSink.warnings } : {}),
  };
}

/**
 * onWarning の呼び出しを重複なく蓄積しつつ、元の通知先にもそのまま転送するラッパーを作る。
 * 並列実行ではフローごとに HTTP クライアントが作られ同じ警告が複数回上がるため、蓄積側だけ重複を除く
 * (元の通知先への転送は従来どおり上がった回数のまま)。
 */
function collectWarnings(onWarning: ((message: string) => void) | undefined): {
  warnings: string[];
  onWarning: (message: string) => void;
} {
  const warnings: string[] = [];
  return {
    warnings,
    onWarning: (message) => {
      if (!warnings.includes(message)) warnings.push(message);
      onWarning?.(message);
    },
  };
}

/** 既に読み込み済みの Flow と、その読み込み元ファイルパスの組 */
export interface LoadedFlowEntry {
  filePath: string;
  flow: Flow;
}

/**
 * データ行の値をテンプレートの env 名前空間へ注入できる形(Record<string, string>)に変換する。
 * number/boolean は String() で文字列化し(captures の stringifyValue と同じ扱い)、
 * null の値を持つキーは注入しない(未設定のまま残す。テンプレートで参照すれば通常の
 * 未解決変数エラーになる、という仕様上の決定を data.ts の JSDoc と合わせてここに反映する)。
 */
function stringifyDataRow(row: DataRow): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null) continue;
    result[key] = String(value);
  }
  return result;
}

/** runLoadedFlows が展開する実行ユニット(行 × フローの組)1件分 */
export interface RunUnit {
  filePath: string;
  flow: Flow;
  /** --data 実行時のみ設定する(stringifyDataRow 済みの行の値を options.variables に上書きマージ済み) */
  iteration?: number;
  variables?: Record<string, string>;
}

/**
 * entries(× options.dataRows)を、行(外側) × フロー(内側)のイテレーション優先順でユニット配列に展開する。
 * dataRows が未指定・空配列の場合は entries をそのまま1ユニットずつにする(iteration/variables なし)。
 * runLoadedFlows の逐次実行・並列実行はどちらもこの展開結果を入力順として使う。
 */
export function buildRunUnits(entries: LoadedFlowEntry[], options: RunFlowOptions): RunUnit[] {
  const units: RunUnit[] = [];
  if (options.dataRows && options.dataRows.length > 0) {
    let iteration = 0;
    for (const row of options.dataRows) {
      iteration++;
      const variables = { ...options.variables, ...stringifyDataRow(row) };
      for (const { filePath, flow } of entries) {
        units.push({ filePath, flow, iteration, variables });
      }
    }
  } else {
    for (const { filePath, flow } of entries) {
      units.push({ filePath, flow });
    }
  }
  return units;
}

/**
 * units を jobs 個のワーカーで並列実行し、FlowResult を入力順(index)で保持した配列を返す。
 * 各ワーカーは共有カウンター(nextIndex)を取り合って次のユニットを取得する単純なプルモデルのため、
 * 早く終わったワーカーがより多くのユニットを処理できる(静的な等分割ではない)。
 * 完了順に関わらず results[i] へ直接書き込むため、戻り値の順序は常に units の入力順になる。
 */
async function runUnitsInParallel(
  units: RunUnit[],
  options: RunFlowOptions,
  runId: string,
  jobs: number,
): Promise<FlowResult[]> {
  const results: FlowResult[] = new Array(units.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex++;
      if (index >= units.length) return;
      const unit = units[index] as RunUnit;
      const flowResult = await executeFlow(unit.flow, unit.filePath, {
        ...options,
        runId,
        unitIndex: index,
        ...(unit.iteration !== undefined ? { iteration: unit.iteration } : {}),
        ...(unit.variables !== undefined ? { variables: unit.variables } : {}),
      });
      results[index] = flowResult;
    }
  }

  // ワーカー数は units.length を超えても意味が無いため、小さい方に丸める
  const workerCount = Math.min(jobs, units.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

/**
 * 既に loadFlow 済みの Flow 群を、runFlows と同じ集約ロジック(runId 共有・durationMs・status 集計)で
 * 実行する。呼び出し元(CLI の run コマンド等)が実行前検証で loadFlow 済みの Flow を保持している場合、
 * runFlows(ファイルパスから再度 loadFlow する)を経由せずに実行することで、同じファイルの二重パースを避けられる。
 *
 * options.dataRows が指定されている場合(--data 実行時)は、Newman 方式のイテレーション優先順
 * (行(外側) × フロー(内側): flowA(it1), flowB(it1), flowA(it2), ...)で反復する。
 * 各行の値は options.variables(--var 由来)を上書きする形で合成し、executeFlow に渡す
 * (テンプレート側の優先順位は row > --var > 環境ファイルの値になる)。dataRows が未指定・空配列の場合は
 * entries を1回ずつ実行する。いずれの場合もユニット列(行 × フローの組)は buildRunUnits が展開する。
 *
 * options.jobs が 2 以上の場合、そのユニット列を jobs 個のワーカーで並列実行する
 * (1ユニット = 1回の executeFlow 呼び出し。フロー内のステップは常に逐次のまま変わらない)。
 * RunResult.flows は完了順ではなく常に入力順を保つ(runUnitsInParallel が index 書き込みで保証する)。
 * jobs 未指定・1 の場合は同じユニット列を unitIndex なしで逐次実行する。
 */
export async function runLoadedFlows(
  entries: LoadedFlowEntry[],
  options: RunFlowOptions = {},
): Promise<RunResult> {
  const runId = options.runId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const runStartedAt = performance.now();
  const jobs = options.jobs ?? 1;
  // 警告は呼び出し元への通知に加えて RunResult.warnings にも残す(以降の実行は collected を通す)
  const warningSink = collectWarnings(options.onWarning);
  options = { ...options, onWarning: warningSink.onWarning };

  // スナップショットは実行全体で 1 つのストアを共有し、書き込みは最後に一度だけ行う。
  // 壊れたスナップショットファイルは、何も実行する前に ParseError(CLI では exit 2)として報告する
  const snapshotStore = new SnapshotStore({
    cwd: options.cwd ?? process.cwd(),
    update: options.snapshots?.update === true,
    ci: options.snapshots?.ci === true,
    readOnly: options.recording?.mode === "replay",
  });
  // キーが曖昧・重複するフローは、何も実行する前に定義エラー(exit 2)にする
  for (const { filePath, flow } of entries) {
    const keyProblem = findSnapshotKeyProblem(flow);
    if (keyProblem !== undefined) throw new ParseError(keyProblem.message, filePath);
  }
  for (const warning of await snapshotStore.preload(
    entries.map(({ filePath, flow }) => ({
      filePath,
      usesSnapshot: flow.steps.some((step) => step.assert?.snapshot !== undefined),
    })),
  )) {
    options.onWarning?.(warning);
  }
  options = { ...options, snapshotStore };

  const units = buildRunUnits(entries, options);
  let flows: FlowResult[];
  if (jobs > 1) {
    flows = await runUnitsInParallel(units, options, runId, jobs);
  } else {
    // 逐次実行では unitIndex を設定しない(--data 実行時のみ variables/iteration を上書きする)
    flows = [];
    for (const unit of units) {
      const flowResult = await executeFlow(unit.flow, unit.filePath, {
        ...options,
        runId,
        ...(unit.iteration !== undefined
          ? { variables: unit.variables, iteration: unit.iteration }
          : {}),
      });
      flows.push(flowResult);
    }
  }

  // 基準の書き込みと古いエントリの集計。書き込みに失敗したら、成功と報告したステップの基準が残らないため
  // 警告に加えて実行全体を error にする
  let snapshotWriteFailed = false;
  let finalized: Awaited<ReturnType<SnapshotStore["finalize"]>> = {
    files: [],
    obsoleteEntries: [],
    warnings: [],
  };
  try {
    finalized = await snapshotStore.finalize();
  } catch (error) {
    snapshotWriteFailed = true;
    options.onWarning?.(
      `failed to write snapshot files: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const warning of finalized.warnings) options.onWarning?.(warning);
  const snapshots = summarizeSnapshots(flows, finalized);

  const durationMs = performance.now() - runStartedAt;
  const status = snapshotWriteFailed ? "error" : aggregateStatus(flows.map((f) => f.status));

  return {
    runId,
    startedAt,
    durationMs,
    flows,
    status,
    ...(warningSink.warnings.length > 0 ? { warnings: warningSink.warnings } : {}),
    ...(snapshots ? { snapshots } : {}),
  };
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
  /**
   * envName の代わりに、任意パス(cwd 相対または絶対)の環境ファイルを直接読み込む場合のパス
   * (RunFlowOptions.envFilePath と同じ意味)。envName との排他制御は呼び出し元(CLI の req コマンド)の責務で、
   * ここでは envFilePath が優先される
   */
  envFilePath?: string | undefined;
  /**
   * テンプレートの env 名前空間へ上書きマージする追加変数(RunFlowOptions.variables と同じ意味。
   * secrets には登録されずマスク対象外)
   */
  variables?: Record<string, string> | undefined;
  /** 履歴書き込みの有無。既定は true(executeFlow の DEFAULT_HISTORY と同じ) */
  history?: boolean;
  /** 送信先ホストの許可リストなどの安全柵。RunFlowOptions.guard と同じ意味・同じ判定を通る */
  guard?: GuardOptions | undefined;
  /** 実行単位の HTTP クライアント設定(RunFlowOptions.http と同じ意味。単発実行にはフローが無いためこれだけが効く) */
  http?: HttpConfig | undefined;
  /** ステップの成否に影響しない警告(tls.insecure の使用など)の通知先 */
  onWarning?: (message: string) => void;
  /** 履歴エントリの actor に記録する実行主体(RunFlowOptions.actor と同じ) */
  actor?: HistoryActor | undefined;
  /** 履歴エントリの git に記録する実行時点の git の状態(RunFlowOptions.git と同じ) */
  git?: HistoryGit | undefined;
  /**
   * 実行完了時に、収集済みの secrets({{env.X}} で解決した値)を呼び出し元へ渡すコールバック。
   * RunFlowOptions.onSecrets と同じ用途・シグネチャ。未指定の場合は何もしない。
   */
  onSecrets?: (secrets: readonly string[]) => void;
}

/** executeSingleRequest の結果 */
export interface ExecuteSingleRequestResult {
  result: StepResult;
  /** この実行の runId(履歴エントリの runId と一致する。`klaus history show <runId>` で参照できる) */
  runId: string;
  /**
   * 履歴エントリを実際に書き込めたか。history が無効な場合、接続不能・タイムアウトなど履歴に残らない
   * 実行時エラーの場合、書き込みに失敗した場合は false(この場合 runId で履歴を引いても見つからない)
   */
  historyRecorded: boolean;
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
  const environment = await loadEnvironment(cwd, undefined, options.envName, options.envFilePath);
  // 単発実行は allowProtected を受け取らないため、$protected: true の環境は常に拒否される
  // (v1 の意図的な挙動。--allow-protected は CLI の run コマンド専用で、req コマンドにも設けない)。
  // $protected: "readonly" の環境は安全メソッド(GET / HEAD / OPTIONS)のみ許可する。
  // 保護環境チェックの表示名は executeFlow と同じく、--env-file 指定時はそのファイルパスを使う
  const stepGuard = buildStepGuard(
    options.envFilePath ?? options.envName,
    environment,
    undefined,
    options.guard,
    true,
  );
  const runId = randomUUID();
  const flowName = "(single)";
  const captures: Record<string, unknown> = {};
  const secrets = new Set<string>();
  const templateContext: TemplateContext = {
    captures,
    // 追加変数(--var)は環境ファイルの値を上書きする(executeFlow と同じ優先順位)
    env: { ...toTemplateVariables(environment), ...options.variables },
    secrets,
  };
  const step: Step = { name: "request", request };

  // 単発実行(UI からの単発リクエスト実行)は record/replay の対象外(フロー実行専用機能のため)
  const session = new HttpSession(options.http, options.onWarning);
  let outcome: Awaited<ReturnType<typeof executeStep>>;
  try {
    outcome = await executeStep(
      step,
      templateContext,
      runId,
      flowName,
      undefined,
      stepGuard,
      undefined,
      session,
      cwd,
    );
  } finally {
    await session.close();
  }

  const shouldWriteHistory = options.history ?? DEFAULT_HISTORY;
  let historyRecorded = false;
  if (shouldWriteHistory && outcome.historyEntry) {
    const auditFields = buildAuditFields(
      cwd,
      undefined,
      options.envName,
      options.envFilePath,
      options.actor,
      options.git,
    );
    const maskedEntry = maskHistoryEntry(
      { ...outcome.historyEntry, source: "single", ...auditFields },
      [...secrets],
    );
    try {
      await appendHistory(cwd, maskedEntry);
      historyRecorded = true;
    } catch {
      // 単発実行には executeFlow の onWarning のような通知先が無いため、
      // 履歴書き込み失敗はステップ結果に影響させず無視する(executeFlow の警告握りつぶし方針と同じ考え方)
    }
  }

  // 実行完了時点で収集済みの secrets を呼び出し元へ渡す(履歴とは別経路のマスク用)
  options.onSecrets?.([...secrets]);

  return { result: outcome.result, runId, historyRecorded };
}
