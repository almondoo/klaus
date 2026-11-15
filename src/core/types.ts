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
  /** kind が "snapshot" のときの詳細(状態・差分・承認用の候補) */
  snapshot?: SnapshotAssertionDetail;
  /** kind が "openapi" のときの詳細(照合したオペレーション・違反の一覧) */
  openapi?: OpenApiAssertionDetail;
}

/** OpenAPI 検証の1ステップ分の判定状態。skipped は検証できなかった(スキーマをコンパイルできない等) */
export type OpenApiState = "valid" | "invalid" | "undocumented" | "unmatched" | "skipped";

/** OpenAPI 検証の違反1件。path は location が body のときだけ付く JSON Pointer(`/items/0/id`。ルートは空文字) */
export interface OpenApiViolation {
  location: "status" | "content-type" | "header" | "body";
  path?: string;
  message: string;
}

/** openapi アサーションの結果の詳細。AssertionResult.openapi に入り、履歴にも残る */
export interface OpenApiAssertionDetail {
  state: OpenApiState;
  /** 照合したオペレーション(例: `GET /users/{id}`)。unmatched のときは無い */
  operation?: string;
  /** 照合した OpenAPI 文書(cwd からの相対パス) */
  document?: string;
  status?: number;
  /** 違反(先頭 MAX 件まで) */
  violations?: OpenApiViolation[];
  /** 違反の総数(violations が切り詰められていれば violations.length より大きい) */
  violationCount?: number;
}

/** 実行全体の OpenAPI カバレッジ集計(--openapi を指定した実行にだけ付く) */
export interface OpenApiRunSummary {
  documents: { file: string; title?: string; version?: string; operations: number }[];
  operations: { total: number; covered: number; percent: number };
  /** 1 件以上の応答を照合できたオペレーションと、観測したステータスコード・仕様に書かれたステータスキー */
  covered: { operation: string; document: string; statuses: number[]; documented: string[] }[];
  /** 応答を 1 件も照合できなかったオペレーション */
  uncovered: { operation: string; document: string }[];
  /** どのオペレーションにも照合できなかったリクエスト(クエリ・フラグメントは除く) */
  unmatched: { method: string; url: string; count: number }[];
  /** 検証の対象外にしたステップ(SSE / WebSocket / リダイレクトを追ったもの) */
  excluded: { flow: string; step: string; reason: "sse" | "websocket" | "redirected" }[];
  /** 仕様に違反した応答の件数(state が invalid のアサーション数) */
  violations: number;
  /** --tags / --exclude-tags で一部のフローだけを実行した(カバレッジは全体の一部) */
  partial: boolean;
  /** --dry-run の計画(実際には送っていない。応答の検証はしない) */
  planned: boolean;
  /** --openapi-coverage-min の判定(指定したときだけ) */
  coverageMin?: { percent: number; met: boolean };
  /** 一覧を件数上限で切り詰めた */
  truncated?: boolean;
}

/** スナップショットの1ステップ分の判定状態 */
export type SnapshotState = "matched" | "written" | "updated" | "mismatch" | "missing";

/** スナップショットの差分1件(JSON 構造差分。path は `$.body.items[0].id` のような JSONPath 風) */
export interface SnapshotDifference {
  path: string;
  kind: "added" | "removed" | "changed" | "type-changed" | "too-deep";
  before?: unknown;
  after?: unknown;
}

/** 保存する(または比較する)スナップショット1件の内容。マスク済み・ignore 適用済み */
export interface SnapshotEntry {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** snapshot アサーションの結果の詳細。AssertionResult.snapshot に入り、履歴にも残る */
export interface SnapshotAssertionDetail {
  /** スナップショットのキー(ステップ名 + --data の反復番号 + name) */
  key: string;
  /** スナップショットファイルの cwd からの相対パス(POSIX 区切り) */
  file: string;
  state: SnapshotState;
  /** mismatch のときの構造差分(先頭 MAX 件まで) */
  differences?: SnapshotDifference[];
  /** mismatch のときの差分の総数(differences が切り詰められていれば differences.length より大きい) */
  differenceCount?: number;
  /**
   * mismatch / missing のときだけ入る、書き込む内容そのもの(マスク済み)。
   * 履歴から承認(acceptSnapshot)するときの書き込み元になる。JSON レポートには出さない
   */
  candidate?: SnapshotEntry;
}

/** 実行全体のスナップショット集計(snapshot アサーションが 1 件でもあった実行にだけ付く) */
export interface SnapshotRunSummary {
  matched: number;
  written: number;
  updated: number;
  mismatched: number;
  /** 基準が無く、書き込まれなかったもの(CI・--replay・保護環境など) */
  missing: number;
  /** 実行終了時点で、どのステップからも生成されなかったエントリの総数 */
  obsolete: number;
  /** この実行で書き込んだ(または古いエントリを取り除いた)スナップショットファイル(cwd 相対) */
  files: string[];
  /** 古いエントリがあったファイルとそのキー(--update-snapshots で取り除く) */
  obsoleteEntries: { file: string; keys: string[] }[];
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
  /**
   * JSON だが入れ子が上限(MAX_JSON_BODY_DEPTH)を超えたためテキストのまま body に入れたときだけ true。
   * 履歴にもそのまま記録される(読み手が、文字列の body を「JSON ではない」と取り違えないようにするため)
   */
  bodyTooDeep?: true;
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
  /**
   * status が "error" で原因を識別できるときだけ設定する安定したコード(例: `guard.allowed-hosts`)。
   * 値の一覧は ErrorCode(errors.ts)を参照。該当するコードが無いエラーでは省略する
   */
  errorCode?: string;
  /** retry 設定がある場合のみ設定。実際に実行された試行回数(1 以上) */
  attempts?: number;
  /**
   * リダイレクトを追った場合のみ設定。初回リクエストの後に辿った URL の一覧(最後が最終応答の URL)。
   * http.followRedirects を使わない通常の実行では省略する
   */
  redirects?: string[];
  /**
   * 別オリジンへのリダイレクトで落としたリクエストヘッダー(ホップ番号つきの名前だけ。値は含まない)。
   * 資格情報のヘッダーと、秘密値を値に含むヘッダーが対象。何も落としていなければ省略する
   */
  droppedHeaders?: { hop: number; headers: string[] }[];
  /**
   * このステップの履歴エントリを実際に書き込めたときだけ true(履歴が無効・書き込み失敗・
   * 接続不能やタイムアウトなど履歴に残らない実行時エラーでは省略する)。
   * historyRef のような「履歴を引くためのポインタ」は、これが true のときだけ出す
   */
  historyRecorded?: boolean;
}

/** 1フロー(YAML 1ファイル)の実行結果 */
export interface FlowResult {
  name: string;
  file: string;
  status: "passed" | "failed" | "error";
  steps: StepResult[];
  durationMs: number;
  /** --data 実行時のみ設定される 1 始まりのイテレーション番号(データ行ごとに同じフローが複数回実行される) */
  iteration?: number;
}

/** 複数フローをまとめた実行結果(CLI の最終出力の元になる) */
export interface RunResult {
  runId: string;
  startedAt: string;
  durationMs: number;
  flows: FlowResult[];
  status: "passed" | "failed" | "error";
  /**
   * ステップの成否には影響しない警告(tls.insecure の使用・履歴書き込み失敗など)。重複は除く。
   * 何も無ければ省略する(stderr への通知とは別に、機械可読な出力にも載せるため)
   */
  warnings?: string[];
  /** スナップショットの集計。snapshot アサーションを持つステップまたは古いエントリが無ければ省略する */
  snapshots?: SnapshotRunSummary;
  /** OpenAPI の検証・カバレッジ。--openapi を指定した実行にだけ付く */
  openapi?: OpenApiRunSummary;
}
