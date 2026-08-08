import type { FlowResult, RunResult, StepResult } from "../../core/index.js";

/** XML のテキストノード用エスケープ */
function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** XML の属性値用エスケープ(テキストのエスケープに加えて引用符も潰す) */
function escapeXmlAttr(value: unknown): string {
  return escapeXmlText(String(value)).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
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
function testcaseXml(flow: FlowResult, step: StepResult): string {
  const time = (step.durationMs / 1000).toFixed(3);
  const attrs = `name="${escapeXmlAttr(step.name)}" classname="${escapeXmlAttr(flow.name)}" time="${time}"`;

  if (step.status === "passed") {
    return `    <testcase ${attrs} />\n`;
  }
  if (step.status === "skipped") {
    const reason = step.error ?? "skipped";
    return `    <testcase ${attrs}>\n      <skipped message="${escapeXmlAttr(reason)}" />\n    </testcase>\n`;
  }
  // failed / error
  const tag = step.status === "error" ? "error" : "failure";
  const message = stepFailureMessage(step);
  return `    <testcase ${attrs}>\n      <${tag} message="${escapeXmlAttr(message)}">${escapeXmlText(message)}</${tag}>\n    </testcase>\n`;
}

/** 1 フロー分の <testsuite> を組み立てる(flow = testsuite, step = testcase) */
function testsuiteXml(flow: FlowResult): string {
  const tests = flow.steps.length;
  const failures = flow.steps.filter((step) => step.status === "failed").length;
  const errors = flow.steps.filter((step) => step.status === "error").length;
  const skipped = flow.steps.filter((step) => step.status === "skipped").length;
  const time = (flow.durationMs / 1000).toFixed(3);
  const attrs = [
    `name="${escapeXmlAttr(flow.name)}"`,
    `tests="${tests}"`,
    `failures="${failures}"`,
    `errors="${errors}"`,
    `skipped="${skipped}"`,
    `time="${time}"`,
    `file="${escapeXmlAttr(flow.file)}"`,
  ].join(" ");
  const testcases = flow.steps.map((step) => testcaseXml(flow, step)).join("");
  return `  <testsuite ${attrs}>\n${testcases}  </testsuite>\n`;
}

/** RunResult 全体を JUnit XML(<testsuites>)に変換する */
export function formatJUnit(runResult: RunResult): string {
  const suites = runResult.flows.map((flow) => testsuiteXml(flow)).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites}</testsuites>\n`;
}
