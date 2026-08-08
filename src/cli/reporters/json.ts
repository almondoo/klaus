import type { RunResult } from "../../core/index.js";

/** JSON モードの出力ペイロード。将来フィールドを変える場合は version を上げる */
export interface JsonReport extends RunResult {
  version: 1;
}

/** RunResult を CLI の JSON 出力形式(pretty print 2 スペース)に整形する */
export function formatJson(runResult: RunResult): string {
  const report: JsonReport = { version: 1, ...runResult };
  return JSON.stringify(report, null, 2);
}
