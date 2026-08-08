import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../api/client";
import { groupHistoryByRun, resolveStepStatus } from "./history";

function entry(
  overrides: Partial<HistoryEntry> & Pick<HistoryEntry, "runId" | "step" | "startedAt">,
): HistoryEntry {
  return {
    v: 1,
    flow: "認証フロー",
    durationMs: 10,
    request: { method: "GET", url: "http://localhost/x", headers: {} },
    response: { status: 200, headers: {}, body: {} },
    assertions: [{ ok: true, kind: "status", expected: 200, actual: 200, message: "status 200" }],
    ...overrides,
  };
}

describe("groupHistoryByRun", () => {
  it("groups entries by runId, sorted newest-run-first with chronological steps inside", () => {
    const entries: HistoryEntry[] = [
      entry({ runId: "run-1", step: "login", startedAt: "2026-08-05T08:30:00.000Z" }),
      entry({ runId: "run-2", step: "get-me", startedAt: "2026-08-07T09:15:01.000Z" }),
      entry({ runId: "run-2", step: "login", startedAt: "2026-08-07T09:15:00.000Z" }),
    ];

    const groups = groupHistoryByRun(entries);

    expect(groups.map((g) => g.runId)).toEqual(["run-2", "run-1"]);
    expect(groups[0]?.steps.map((s) => s.step)).toEqual(["login", "get-me"]);
    expect(groups[0]?.startedAt).toBe("2026-08-07T09:15:00.000Z");
  });

  it("sums durationMs across steps within a run", () => {
    const entries: HistoryEntry[] = [
      entry({ runId: "run-1", step: "a", startedAt: "2026-08-07T00:00:00.000Z", durationMs: 30 }),
      entry({ runId: "run-1", step: "b", startedAt: "2026-08-07T00:00:01.000Z", durationMs: 20 }),
    ];

    const groups = groupHistoryByRun(entries);
    expect(groups[0]?.durationMs).toBe(50);
  });

  it("marks a run as failed if any step has a failing assertion", () => {
    const entries: HistoryEntry[] = [
      entry({ runId: "run-1", step: "a", startedAt: "2026-08-07T00:00:00.000Z" }),
      entry({
        runId: "run-1",
        step: "b",
        startedAt: "2026-08-07T00:00:01.000Z",
        assertions: [{ ok: false, kind: "status", expected: 200, actual: 500, message: "fail" }],
      }),
    ];

    const groups = groupHistoryByRun(entries);
    expect(groups[0]?.status).toBe("failed");
  });

  it("keeps a run passed when all assertions pass", () => {
    const entries: HistoryEntry[] = [
      entry({ runId: "run-1", step: "a", startedAt: "2026-08-07T00:00:00.000Z" }),
    ];
    const groups = groupHistoryByRun(entries);
    expect(groups[0]?.status).toBe("passed");
  });

  it("uses the status field when present, taking priority over assertions", () => {
    const entries: HistoryEntry[] = [
      // status: "failed" だが assertions は全て ok -> status を優先して failed
      entry({
        runId: "run-1",
        step: "a",
        startedAt: "2026-08-07T00:00:00.000Z",
        status: "failed",
      }),
    ];
    const groups = groupHistoryByRun(entries);
    expect(groups[0]?.status).toBe("failed");
  });

  it("does not flip a group to failed because of a skipped step", () => {
    const entries: HistoryEntry[] = [
      entry({
        runId: "run-1",
        step: "a",
        startedAt: "2026-08-07T00:00:00.000Z",
        status: "skipped",
        request: undefined,
        response: undefined,
        assertions: [],
      }),
      entry({
        runId: "run-1",
        step: "b",
        startedAt: "2026-08-07T00:00:01.000Z",
        status: "passed",
      }),
    ];
    const groups = groupHistoryByRun(entries);
    expect(groups[0]?.status).toBe("passed");
  });

  it("labels a group as skipped when every step in it is skipped", () => {
    const entries: HistoryEntry[] = [
      entry({
        runId: "run-1",
        step: "a",
        startedAt: "2026-08-07T00:00:00.000Z",
        status: "skipped",
        request: undefined,
        response: undefined,
        assertions: [],
      }),
      entry({
        runId: "run-1",
        step: "b",
        startedAt: "2026-08-07T00:00:01.000Z",
        status: "skipped",
        request: undefined,
        response: undefined,
        assertions: [],
      }),
    ];
    const groups = groupHistoryByRun(entries);
    expect(groups[0]?.status).toBe("skipped");
  });
});

describe("resolveStepStatus", () => {
  it("returns the status field as-is when present", () => {
    expect(
      resolveStepStatus(entry({ runId: "r", step: "a", startedAt: "t", status: "skipped" })),
    ).toBe("skipped");
  });

  it("falls back to assertion-derived status for legacy entries without status", () => {
    expect(resolveStepStatus(entry({ runId: "r", step: "a", startedAt: "t" }))).toBe("passed");
    expect(
      resolveStepStatus(
        entry({
          runId: "r",
          step: "a",
          startedAt: "t",
          assertions: [{ ok: false, kind: "status", expected: 200, actual: 500, message: "fail" }],
        }),
      ),
    ).toBe("failed");
  });
});
