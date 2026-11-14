/**
 * klaus server が UI に返す DTO 型定義。
 * ui/src/api/types.ts の契約と一致させること(server は ui/src を import しないため、
 * ここで独立して定義し、レスポンス形状を手動で同期する)。
 */
import type { HistoryPage as CoreHistoryPage } from "../core/history-query.js";
import type { PromoteResult } from "../core/index.js";
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
  // Flow.env(zod の .optional())をそのまま渡すため undefined を明示的に許容する
  env?: string | undefined;
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
 * path は JSONPath、json は抽出対象のレスポンスボディ(単発実行結果の response.body 等)を渡す。
 */
export interface EnvironmentCaptureRequestBody {
  key: string;
  path: string;
  json: unknown;
}

/** GET /api/history のレスポンス(型本体は core/history-query.ts で定義。CLI の klaus history とも共有する) */
export type HistoryPage = CoreHistoryPage;

/** POST /api/runs のリクエストボディ */
export interface RunRequestBody {
  path: string;
  env?: string;
}

/**
 * POST /api/request のリクエストボディ。
 * request はサーバー側で core の requestSchema.safeParse により検証するため、
 * ここでは検証前の生の値として unknown のまま扱う。
 */
export interface SingleRequestRequestBody {
  request: unknown;
  env?: string;
}

/** POST /api/request のレスポンス(単一ステップの実行結果) */
export interface SingleRequestResultPayload {
  result: StepResult;
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

/** POST /api/history/promote のリクエストボディ(検証前の生の値。許可するキー以外は 400) */
export interface PromoteRequestBody {
  runIds?: unknown;
  flow?: unknown;
  assert?: unknown;
  baseUrlVar?: unknown;
  chain?: unknown;
  name?: unknown;
  out?: unknown;
  dryRun?: unknown;
}

/**
 * POST /api/history/promote の成功レスポンス。klaus promote --json の出力に yaml と dryRun / exists を加えた形
 * (ui/src/api/types.ts の PromoteResponse と手動同期する)
 */
export interface PromoteResponse {
  dryRun: boolean;
  /** ファイルを書いたか(dryRun は false) */
  written: boolean;
  /** 出力先(書いた、または書く予定の cwd 相対パス。POSIX 区切り) */
  file: string;
  /** dryRun のときのみ。出力先に既に何かあるか(あれば保存は 409 になる) */
  exists?: boolean;
  yaml: string;
  flow: string;
  assert: PromoteResult["assert"];
  steps: PromoteResult["steps"];
  /** 実行前に OS 環境変数として設定するプレースホルダー({{env.NAME}}) */
  placeholders: PromoteResult["placeholders"];
  /** baseUrlVar で置き換えた origin。環境ファイルに書くべき値 */
  variables: PromoteResult["baseUrls"];
  captures: PromoteResult["captures"];
  skipped: PromoteResult["skipped"];
  redacted: PromoteResult["redacted"];
  templateLiterals: PromoteResult["templateLiterals"];
  notes: string[];
  notice: string;
}
