/**
 * UI 起点のフロー実行で、保護環境の拒否メッセージ末尾の案内を UI 向けに差し替える。
 * core の拒否メッセージは、フロー実行(klaus run)向けに「Pass --allow-protected ...」と案内する
 * (単発リクエストには executeSingleRequest 専用の案内が core にある)。UI は --allow-protected を
 * 渡せないため、この案内は UI では誤りになる。core にはフロー実行用のエントリポイント別の案内が無いので、
 * server が配信する結果の文字列だけを置き換える(履歴に記録される文字列は core のままで変わらない)。
 * 置き換え対象の文言が core から変わった場合は tests/server/server.test.ts のテストが失敗して気づける。
 */
import type { FlowResult, StepResult } from "../core/types.js";

/** core の protectionHint(flow 実行用)と同じ文言 */
const CORE_FLOW_HINT = "Pass --allow-protected to run against this environment intentionally.";

/** UI 起点のフロー実行向けの案内 */
export const UI_FLOW_HINT =
  "klaus ui cannot override environment protection; run this flow with `klaus run --allow-protected` instead.";

/** エラー文字列の案内部分を UI 向けに差し替える(該当しなければそのまま返す) */
export function adaptProtectionHint(error: string): string;
export function adaptProtectionHint(error: string | undefined): string | undefined;
export function adaptProtectionHint(error: string | undefined): string | undefined {
  return error?.replace(CORE_FLOW_HINT, UI_FLOW_HINT);
}

/** ステップ結果の error を UI 向けの案内に差し替えた結果を返す */
export function adaptStepResult(result: StepResult): StepResult {
  if (result.error === undefined) return result;
  return { ...result, error: adaptProtectionHint(result.error) };
}

/** フロー結果の各ステップの error を UI 向けの案内に差し替えた結果を返す */
export function adaptFlowResult(flow: FlowResult): FlowResult {
  return { ...flow, steps: flow.steps.map(adaptStepResult) };
}
