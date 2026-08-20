import type { FlowResult, RunResult, StepResult } from "../../core/index.js";
import { expandSecretVariants, maskString } from "../../core/index.js";
import { sanitizeForXml } from "./sanitize.js";
import { summarizeSteps } from "./text.js";

/** formatJUnit のオプション。secrets を渡すと JUnit ファイル出力にのみシークレットマスクを適用する */
export interface FormatJUnitOptions {
  /** {{env.X}} 等で解決した secrets の生値一覧。省略時はマスクしない(従来どおりの出力) */
  secrets?: readonly string[];
}

/**
 * XML のテキストノード用エスケープ。
 * 変換順序は ①シークレットマスク(生のバイト列のまま照合する必要があるため最初)
 * ②制御文字のサニタイズ ③XML エスケープ(& < >)。この関数を唯一の絞り込み点として使うことで、
 * XML に埋め込む文字列値すべてに同じ順序を強制する。
 */
function escapeXmlText(value: string, secretVariants: readonly string[]): string {
  const masked = secretVariants.length > 0 ? maskString(value, secretVariants) : value;
  const sanitized = sanitizeForXml(masked);
  return sanitized.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** XML の属性値用エスケープ(テキストのエスケープに加えて引用符も潰す) */
function escapeXmlAttr(value: unknown, secretVariants: readonly string[]): string {
  return escapeXmlText(String(value), secretVariants)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** failed/error ステップの詳細メッセージを組み立てる */
function stepFailureMessage(step: StepResult): string {
  if (step.status === "error") {
    return step.error ?? "runtime error";
  }
  return step.assertions
    .filter((assertion) => !assertion.ok)
    .map((assertion) => assertion.message)
    .join("\n");
}

/** 1 ステップ分の <testcase> を組み立てる */
function testcaseXml(
  flow: FlowResult,
  step: StepResult,
  secretVariants: readonly string[],
): string {
  const time = (step.durationMs / 1000).toFixed(3);
  const attrs = `name="${escapeXmlAttr(step.name, secretVariants)}" classname="${escapeXmlAttr(flow.name, secretVariants)}" time="${time}"`;

  if (step.status === "passed") {
    return `    <testcase ${attrs} />\n`;
  }
  if (step.status === "skipped") {
    const reason = step.error ?? "skipped";
    return `    <testcase ${attrs}>\n      <skipped message="${escapeXmlAttr(reason, secretVariants)}" />\n    </testcase>\n`;
  }
  // failed / error
  const tag = step.status === "error" ? "error" : "failure";
  const message = stepFailureMessage(step);
  return `    <testcase ${attrs}>\n      <${tag} message="${escapeXmlAttr(message, secretVariants)}">${escapeXmlText(message, secretVariants)}</${tag}>\n    </testcase>\n`;
}

/** 1 フロー分の <testsuite> を組み立てる(flow = testsuite, step = testcase) */
function testsuiteXml(flow: FlowResult, secretVariants: readonly string[]): string {
  const tests = flow.steps.length;
  // json.ts の buildSummary と同じ集計ロジックを共有する(text.ts の summarizeSteps)
  const { failed: failures, error: errors, skipped } = summarizeSteps(flow.steps);
  const time = (flow.durationMs / 1000).toFixed(3);
  const attrs = [
    `name="${escapeXmlAttr(flow.name, secretVariants)}"`,
    `tests="${tests}"`,
    `failures="${failures}"`,
    `errors="${errors}"`,
    `skipped="${skipped}"`,
    `time="${time}"`,
    `file="${escapeXmlAttr(flow.file, secretVariants)}"`,
  ].join(" ");
  const testcases = flow.steps.map((step) => testcaseXml(flow, step, secretVariants)).join("");
  return `  <testsuite ${attrs}>\n${testcases}  </testsuite>\n`;
}

/** RunResult 全体を JUnit XML(<testsuites>)に変換する */
export function formatJUnit(runResult: RunResult, options?: FormatJUnitOptions): string {
  // url のパーセントエンコード形などのバリアントも含めてマスクする(history.ts の maskHistoryEntry と同じ方針)
  const secretVariants =
    options?.secrets && options.secrets.length > 0 ? expandSecretVariants(options.secrets) : [];
  const suites = runResult.flows.map((flow) => testsuiteXml(flow, secretVariants)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites}</testsuites>\n`;
}
