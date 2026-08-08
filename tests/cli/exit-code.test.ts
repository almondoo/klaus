import { describe, expect, it } from "vitest";
import { determineExitCode } from "../../src/cli/exit-code.js";
import type { RunResult } from "../../src/core/index.js";

function buildRunResult(status: RunResult["status"]): RunResult {
  return {
    runId: "run-1",
    startedAt: new Date().toISOString(),
    durationMs: 10,
    flows: [],
    status,
  };
}

describe("determineExitCode", () => {
  it("全件成功(passed)なら 0", () => {
    expect(determineExitCode(buildRunResult("passed"))).toBe(0);
  });

  it("アサーション失敗(failed)なら 4", () => {
    expect(determineExitCode(buildRunResult("failed"))).toBe(4);
  });

  it("実行時エラー(error)なら 3", () => {
    expect(determineExitCode(buildRunResult("error"))).toBe(3);
  });
});
