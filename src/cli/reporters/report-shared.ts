import type { FlowResult, RunResult, StepResult } from "../../core/index.js";
import { expandSecretVariants, maskDeep, maskString } from "../../core/index.js";
import { truncate } from "./text.js";

/** 文字数上限で切り詰め、超過時は末尾に省略記号を付ける(サロゲートペアの途中では切らない) */
export function truncateWithEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  // 直前が上位サロゲートなら下位サロゲートと分断されるため1つ戻す
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** 文字列1つをマスクする(ヘッダーのメタ情報用)。secrets が無ければそのまま返す */
export function maskText(text: string, secrets?: readonly string[]): string {
  if (!secrets || secrets.length === 0) return text;
  return maskString(text, expandSecretVariants(secrets));
}

/** html / github レポーター共通のオプション。secrets を渡すと出力する前に結果全体をマスクする */
export interface MaskedReportOptions {
  /** {{env.X}} 等で解決した secrets の生値一覧。省略時はマスクしない */
  secrets?: readonly string[];
}

/** 実行メタ情報(RunResult には含まれないため、呼び出し側が任意で渡す) */
export interface RunMeta {
  env?: string | undefined;
  actor?: string | undefined;
  commit?: string | undefined;
}

/**
 * formatJUnit / formatTap と同じ方針で、レポーターが自分で secrets を展開して結果木全体をマスクする。
 * 以降の整形は必ずこの戻り値だけを使い、生の RunResult には触れない。
 */
export function maskRunResult(runResult: RunResult, secrets?: readonly string[]): RunResult {
  // シークレット未登録でも Cookie ヘッダーの構造的マスクは常に掛ける
  return maskDeep(runResult, expandSecretVariants(secrets ?? []));
}

/** --data 実行時はフロー名に " (iteration N)" を付ける(junit/tap と同じ文言) */
export function flowTitle(flow: FlowResult): string {
  return flow.iteration !== undefined ? `${flow.name} (iteration ${flow.iteration})` : flow.name;
}

/** failed/error ステップの失敗メッセージ一覧(failed はアサーション単位、error は実行時エラー) */
export function stepFailureMessages(step: StepResult): string[] {
  if (step.status === "error") return [step.error ?? "runtime error"];
  const messages = step.assertions.filter((a) => !a.ok).map((a) => a.message);
  return messages.length > 0 ? messages : [step.error ?? "assertion failed"];
}

/** 任意の値を表示用文字列にする(文字列はそのまま、それ以外は JSON)。長いものは 500 文字で切り詰める */
export function stringifyDetail(value: unknown): string {
  if (value === undefined) return "";
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return truncate(text);
}

export const FAILING_STATUSES = new Set<StepResult["status"]>(["failed", "error"]);
