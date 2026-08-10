import type { FlowResult, RunResult, StepResult } from "../../src/core/index.js";

/**
 * StepResult のテスト用ビルダー。json/junit/text の各 reporter テストで共通利用する。
 * startedAt は省略時に固定値を使う(実時刻に依存させない決定的なデフォルト。
 * どのテストもデフォルト値そのものを直接検証していないため、値自体に意味はない)。
 */
export function buildStep(
  overrides: Partial<StepResult>,
  startedAt = "2026-08-08T00:00:00.000Z",
): StepResult {
  return {
    name: "step",
    status: "passed",
    startedAt,
    durationMs: 12,
    assertions: [],
    ...overrides,
  };
}

/** FlowResult のテスト用ビルダー(json/junit で共通利用) */
export function buildFlow(overrides: Partial<FlowResult>): FlowResult {
  return {
    name: "flow",
    file: "flow.yaml",
    status: "passed",
    steps: [],
    durationMs: 100,
    ...overrides,
  };
}

/** RunResult のテスト用ビルダー(json/junit で共通利用) */
export function buildRunResult(
  flows: FlowResult[],
  startedAt = "2026-08-08T00:00:00.000Z",
): RunResult {
  return {
    runId: "run-1",
    startedAt,
    durationMs: 100,
    flows,
    status: "passed",
  };
}
