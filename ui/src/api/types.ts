/**
 * klaus UI 専用の API 型定義。
 * レスポンスの実体は src/core/types.ts の型を type-only import で再利用し(ランタイム結合はゼロ)、
 * UI 固有の型(一覧エントリ・SSE イベントのペイロード等)はここに定義する。
 *
 * NOTE: ビルド時に import type は完全に消去されるため、ui/ から core/ への
 * ランタイム依存は発生しない(docs/ui-design.md の「ブラウザ側は core を runtime import しない」契約を満たす)。
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

/** 履歴 JSONL 1行分(v1)。src/core/history.ts の HistoryEntry と同一契約 */
export interface HistoryEntry {
  v: 1;
  runId: string;
  flow: string;
  step: string;
  startedAt: string;
  durationMs: number;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
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

export type RunSseEvent =
  | { event: "step-start"; data: StepStartPayload }
  | { event: "step-result"; data: StepResultPayload }
  | { event: "run-result"; data: RunResultPayload };
