/**
 * klaus UI 専用の API 型定義。
 * レスポンスの実体は src/core/types.ts の型を type-only import で再利用し(ランタイム結合はゼロ)、
 * UI 固有の型(一覧エントリ・SSE イベントのペイロード等)はここに定義する。
 *
 * NOTE: ビルド時に import type は完全に消去されるため、ui/ から core/ への
 * ランタイム依存は発生しない(docs/dev/ui-design.md の「ブラウザ側は core を runtime import しない」契約を満たす)。
 */
import type { AssertionResult, FlowResult, StepResult } from "../../../src/core/types";

export type { AssertionResult, FlowResult, StepResult };

/** GET /api/flows の1エントリ */
export interface FlowListEntry {
  /** cwd からの相対パス。フローの一意キーとして使う */
  path: string;
  /** パースに成功した場合のみ入る */
  name?: string;
  stepCount?: number;
  /** パースに失敗した場合のみ入る(YAML 構文エラー・スキーマ検証エラーの理由) */
  error?: string;
}

/** GET /api/flows/detail のレスポンス(1フローのパース済み定義) */
export interface FlowDetail {
  path: string;
  name: string;
  env?: string;
  steps: Array<{
    name: string;
    method: string;
    url: string;
  }>;
}

/** GET /api/environments のレスポンス */
export interface EnvironmentListEntry {
  name: string;
}

/** GET /api/environments/:name, PUT /api/environments/:name のレスポンス */
export interface EnvironmentDetail {
  name: string;
  values: Record<string, string>;
}

/** PUT /api/environments/:name のリクエストボディ */
export interface EnvironmentUpdateRequestBody {
  values: Record<string, string>;
}

/**
 * POST /api/environments/:name/capture のリクエストボディ。
 * server/types.ts の同名型と手動同期する契約(このファイル冒頭のコメント参照)。
 * path は JSONPath、json は抽出対象のレスポンスボディを渡す。
 */
export interface EnvironmentCaptureRequestBody {
  key: string;
  path: string;
  json: unknown;
}

/** GET /api/history のクエリパラメータ */
export interface GetHistoryParams {
  flow?: string;
  limit?: number;
  before?: string;
}

/** GET /api/history のレスポンス */
export interface HistoryPage {
  entries: HistoryEntry[];
  /** さらに古い履歴がある場合、次回 before に渡すカーソル(ISO 日時) */
  nextBefore?: string;
}

/** SSE で受信した1イベント。src/core/types.ts の SseEvent と同一契約 */
export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
}

/** 履歴に記録される実行主体。src/core/history.ts の HistoryActor と同一契約 */
export interface HistoryActor {
  kind: "human" | "agent" | "ci";
  name?: string;
}

/** 実行時点の git の状態。src/core/history.ts の HistoryGit と同一契約 */
export interface HistoryGit {
  commit: string;
  dirty: boolean;
}

/** 履歴 JSONL 1行分(v1)。src/core/history.ts の HistoryEntry と同一契約 */
export interface HistoryEntry {
  v: 1;
  runId: string;
  flow: string;
  step: string;
  startedAt: string;
  durationMs: number;
  /**
   * --data 実行時のみ設定される 1 始まりのイテレーション番号。--data 未指定の通常実行では省略する。
   * src/core/history.ts の HistoryEntry と同一契約(このファイル冒頭のコメント参照)。
   */
  iteration?: number;
  /** 旧エントリには無い。省略時は従来通り assertions から導出する(groupHistoryByRun 参照) */
  status?: "passed" | "failed" | "skipped" | "error";
  /** status が "error"(安全柵による送信拒否)のエントリのみ入る拒否理由 */
  error?: string;
  /** 監査項目(いずれも旧エントリには無い)。src/core/history.ts の同名フィールドと同一契約 */
  env?: string;
  file?: string;
  actor?: HistoryActor;
  git?: HistoryGit;
  /** skipped では省略 */
  request?: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  /** skipped では省略 */
  response?: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
  /** SSE ステップのみ入る */
  events?: SseEvent[];
  /** skipped では [] */
  assertions: AssertionResult[];
}

/** POST /api/runs のリクエストボディ */
export interface RunRequestBody {
  path: string;
  env?: string;
}

/** SSE event: step-start */
export interface StepStartPayload {
  flow: string;
  file: string;
  step: string;
}

/** SSE event: step-result */
export interface StepResultPayload {
  flow: string;
  file: string;
  result: StepResult;
}

/** SSE event: run-result(単一フロー実行の最終結果) */
export interface RunResultPayload {
  flow: FlowResult;
}

/**
 * POST /api/request のリクエストボディ。単発リクエスト実行(フロー定義を経由しない即時実行)用。
 * server/types.ts の同名型と手動同期する契約(このファイル冒頭のコメント参照)。
 */
export interface SingleRequestRequestBody {
  request: {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
    graphql?: {
      query: string;
      variables?: Record<string, unknown>;
    };
    timeoutMs?: number;
  };
  env?: string;
}

/** POST /api/request のレスポンス */
export interface SingleRequestResultPayload {
  result: StepResult;
}

/** GET /api/history/diff のクエリパラメータ */
export interface GetHistoryDiffParams {
  /** run ID(flow 指定時は "latest" / "previous" も可) */
  a: string;
  b: string;
  flow?: string;
  /** 比較から除外する JSONPath(例: $.items[*].createdAt) */
  ignorePaths?: string[];
}

/**
 * 以下は GET /api/history/diff のレスポンス(src/core/run-diff.ts の RunDiff)と同一契約。
 * このファイル冒頭のコメントのとおり手動で同期する(core からの runtime import はしない)。
 */
export type JsonDifferenceKind = "added" | "removed" | "changed" | "type-changed" | "too-deep";

export interface JsonDifference {
  path: string;
  kind: JsonDifferenceKind;
  /** added / too-deep では省略 */
  before?: unknown;
  /** removed / too-deep では省略 */
  after?: unknown;
}

export interface Change<T> {
  a?: T;
  b?: T;
}

export interface HeaderDiff {
  added: Record<string, string>;
  removed: Record<string, string>;
  changed: Record<string, { a: string; b: string }>;
}

export interface DifferenceList {
  /** 打ち切り前の差分の総数 */
  total: number;
  /** サーバーが省略した件数(total - differences.length) */
  omitted: number;
  differences: JsonDifference[];
}

export interface LineChange {
  op: "+" | "-";
  line: string;
}

export type BodyDiff =
  | ({ kind: "json" } & DifferenceList)
  | { kind: "text"; added: number; removed: number; omitted: number; lines: LineChange[] };

export interface RequestDiff {
  method?: Change<string>;
  url?: Change<string>;
  body?: BodyDiff;
}

export type StepChange = "same" | "different" | "added" | "removed";

export interface StepDiff {
  flow: string;
  step: string;
  iteration?: number;
  change: StepChange;
  status?: Change<string>;
  httpStatus?: Change<number>;
  /** リクエスト自体の差(レスポンスの差とは別に扱う) */
  request?: RequestDiff;
  responseHeaders?: HeaderDiff;
  body?: BodyDiff;
  events?: DifferenceList;
  error?: Change<string>;
  durationMs?: { a: number; b: number; delta: number };
}

export interface RunSummary {
  runId: string;
  flows: string[];
  startedAt: string;
  steps: number;
  status: "passed" | "failed" | "error";
  env?: string;
  file?: string;
  actor?: HistoryActor;
  git?: HistoryGit;
}

export interface RunDiff {
  status: "same" | "different";
  runs: { a: RunSummary; b: RunSummary };
  counts: { same: number; different: number; added: number; removed: number };
  steps: StepDiff[];
}

export type PromoteAssertMode = "status" | "schema" | "values" | "all";

/**
 * POST /api/history/promote のリクエストボディ(履歴から新規フローを作る。既存フローの編集・上書きはできない)。
 * server/types.ts の PromoteRequestBody と手動同期する契約。
 */
export interface PromoteRequestBody {
  runIds: string[];
  flow?: string;
  assert?: PromoteAssertMode;
  baseUrlVar?: string;
  chain?: boolean;
  name?: string;
  out?: string;
  /** true で生成結果のプレビューだけを返す(何も書かない) */
  dryRun?: boolean;
}

export interface PromotePlaceholder {
  name: string;
  locations: string[];
}

export interface PromoteCaptureLink {
  name: string;
  from: { step: string; path: string };
  used: { step: string; location: string }[];
}

export interface PromoteRedaction {
  name: string;
  location: string;
  reason: "sensitive key" | "token-like value";
}

export interface PromoteSkipped {
  runId: string;
  flow: string;
  step: string;
  reason: string;
}

/** POST /api/history/promote の成功レスポンス。server/types.ts の PromoteResponse と手動同期する契約 */
export interface PromoteResponse {
  dryRun: boolean;
  written: boolean;
  /** 出力先(書いた、または書く予定の cwd 相対パス) */
  file: string;
  /** dryRun のときのみ。出力先に既に何かあるか(あれば保存は 409 になる) */
  exists?: boolean;
  yaml: string;
  flow: string;
  assert: PromoteAssertMode;
  steps: Array<{
    name: string;
    method: string;
    url: string;
    from: { runId: string; flow: string; step: string };
  }>;
  /** 実行前に OS 環境変数として設定するプレースホルダー({{env.NAME}}) */
  placeholders: PromotePlaceholder[];
  /** baseUrlVar で置き換えた origin。環境ファイルに書くべき値 */
  variables: Array<{ name: string; value: string }>;
  captures: PromoteCaptureLink[];
  skipped: PromoteSkipped[];
  redacted: PromoteRedaction[];
  templateLiterals: Array<{ step: string; location: string }>;
  notes: string[];
  notice: string;
}
