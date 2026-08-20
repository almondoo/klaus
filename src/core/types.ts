/**
 * klaus core が公開する型定義。
 * CLI / 将来の UI から参照される契約となるため、変更時は影響範囲に注意すること。
 */

/** HTTP メソッド。実際の値は大文字化して扱う */
export type HttpMethod = string;

/** SSE で受信した1イベント */
export interface SseEvent {
  // eventsource-parser の onEvent から渡る値がそのまま入るため、
  // 「省略」と「明示的な undefined」を区別しない(exactOptionalPropertyTypes 対応)
  event?: string | undefined;
  id?: string | undefined;
  data: string;
}

/** WS で受信した1メッセージ */
export interface WsMessage {
  data: string;
}

/** 単一アサーションの評価結果。例外は投げず、常にこの形で返す */
export interface AssertionResult {
  ok: boolean;
  /** アサーションの種類（例: "status" / "header" / "body" / "bodyText" / "duration" / "eventCount" / "events"） */
  kind: string;
  expected?: unknown;
  actual?: unknown;
  message: string;
}

/** リクエストの実測内容(履歴・レポート用に正規化したもの) */
export interface RequestSnapshot {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** レスポンスの実測内容(履歴・レポート用に正規化したもの) */
export interface ResponseSnapshot {
  status: number;
  headers: Record<string, string>;
  /**
   * JSON レスポンスならパース済みの値、それ以外はテキスト。
   * SSE ステップの場合は常に undefined(受信イベントの二重保持を避けるため)。
   * 受信イベント自体は StepResult.events に格納される。
   */
  body: unknown;
}

/** 1ステップの実行結果 */
export interface StepResult {
  name: string;
  status: "passed" | "failed" | "skipped" | "error";
  startedAt: string;
  durationMs: number;
  // runtime エラー時は requestSnapshot が undefined のまま渡ることがあるため明示的に許容する
  request?: RequestSnapshot | undefined;
  /** WS ステップの場合、HTTP レスポンスに相当するものが無いため常に undefined(受信メッセージは wsMessages に格納) */
  response?: ResponseSnapshot;
  /** SSE モードで受信したイベント一覧 */
  events?: SseEvent[];
  /** WS モードで受信したメッセージ一覧 */
  wsMessages?: WsMessage[];
  assertions: AssertionResult[];
  /** runtime エラー・パースエラー時のメッセージ(skip 理由もここに入る) */
  error?: string;
  /** retry 設定がある場合のみ設定。実際に実行された試行回数(1 以上) */
  attempts?: number;
}

/** 1フロー(YAML 1ファイル)の実行結果 */
export interface FlowResult {
  name: string;
  file: string;
  status: "passed" | "failed" | "error";
  steps: StepResult[];
  durationMs: number;
}

/** 複数フローをまとめた実行結果(CLI の最終出力の元になる) */
export interface RunResult {
  runId: string;
  startedAt: string;
  durationMs: number;
  flows: FlowResult[];
  status: "passed" | "failed" | "error";
}
