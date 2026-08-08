/**
 * klaus server が UI に返す DTO 型定義。
 * ui/src/api/types.ts の契約と一致させること(server は ui/src を import しないため、
 * ここで独立して定義し、レスポンス形状を手動で同期する)。
 */
import type { HistoryEntry } from "../core/history.js";
import type { FlowResult, StepResult } from "../core/types.js";

/** GET /api/flows の1エントリ */
export interface FlowListEntry {
  /** cwd からの相対パス(POSIX 区切り)。フローの一意キーとして使う */
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

/** GET /api/environments の1エントリ */
export interface EnvironmentListEntry {
  name: string;
}

/** GET /api/history のレスポンス */
export interface HistoryPage {
  entries: HistoryEntry[];
  /** さらに古い履歴がある場合、次回 before に渡すカーソル(ISO 日時) */
  nextBefore?: string;
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
