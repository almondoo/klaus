import { describe, expect, it } from "vitest";
import type { AssertionResult, OpenApiRunSummary, SnapshotMismatch } from "@/api/types";
import {
  capList,
  countSnapshotStates,
  describeAcceptState,
  describeDroppedHeaders,
  describeOpenApiCoverage,
  groupMismatchesByFile,
  hasPendingSnapshot,
  mismatchesForStep,
  mismatchId,
  splitAcceptable,
} from "./results";

const snap = (
  state: "matched" | "written" | "updated" | "mismatch" | "missing",
): AssertionResult => ({
  ok: state !== "mismatch",
  kind: "snapshot",
  message: state,
  snapshot: { key: "k", file: "f", state },
});

function mismatch(over: Partial<SnapshotMismatch>): SnapshotMismatch {
  return {
    runId: "r",
    flow: "orders",
    step: "get",
    snapshotFile: "__snapshots__/a.snap.json",
    key: "get",
    state: "mismatch",
    message: "m",
    differences: [],
    differenceCount: 0,
    otherAssertionsFailed: false,
    ...over,
  };
}

describe("capList", () => {
  it("上限で切り詰め、省略件数は総数(指定時)との差になる", () => {
    expect(capList([1, 2, 3], 2)).toEqual({ shown: [1, 2], omitted: 1 });
    expect(capList([1, 2], 5)).toEqual({ shown: [1, 2], omitted: 0 });
    expect(capList([1, 2], 5, 12)).toEqual({ shown: [1, 2], omitted: 10 });
  });
});

describe("snapshot の集計", () => {
  it("アサーションを状態別に数え、snapshot が無ければ undefined", () => {
    const steps = [
      {
        assertions: [snap("matched"), snap("mismatch"), { ok: true, kind: "status", message: "" }],
      },
      { assertions: [snap("missing"), snap("matched")] },
    ];
    expect(countSnapshotStates(steps)).toEqual({
      matched: 2,
      written: 0,
      updated: 0,
      mismatch: 1,
      missing: 1,
    });
    expect(countSnapshotStates([{ assertions: [] }])).toBeUndefined();
  });

  it("承認待ち(mismatch / missing)があるときだけ true", () => {
    expect(hasPendingSnapshot([{ assertions: [snap("matched"), snap("written")] }])).toBe(false);
    expect(
      hasPendingSnapshot([{ assertions: [snap("matched")] }, { assertions: [snap("missing")] }]),
    ).toBe(true);
    expect(hasPendingSnapshot([{ assertions: [snap("mismatch")] }])).toBe(true);
  });
});

describe("承認待ちの整理", () => {
  it("ファイルごとにまとめ、ファイル名順に並べる", () => {
    const items = [
      mismatch({ snapshotFile: "b/__snapshots__/x.snap.json", key: "k1" }),
      mismatch({ snapshotFile: "a/__snapshots__/x.snap.json", key: "k2" }),
      mismatch({ snapshotFile: "b/__snapshots__/x.snap.json", key: "k3" }),
    ];
    const grouped = groupMismatchesByFile(items);
    expect(grouped.map((g) => g.file)).toEqual([
      "a/__snapshots__/x.snap.json",
      "b/__snapshots__/x.snap.json",
    ]);
    expect(grouped[1]?.items.map((i) => i.key)).toEqual(["k1", "k3"]);
  });

  it("ステップ(flow・step・iteration)で絞り込む", () => {
    const items = [
      mismatch({ step: "get" }),
      mismatch({ step: "get", iteration: 2 }),
      mismatch({ step: "create" }),
    ];
    expect(mismatchesForStep(items, { flow: "orders", step: "get" })).toHaveLength(1);
    expect(mismatchesForStep(items, { flow: "orders", step: "get", iteration: 2 })).toHaveLength(1);
    expect(mismatchesForStep(items, { flow: "other", step: "get" })).toHaveLength(0);
  });

  it("識別キーはファイルとキーの組で、区切りが衝突しない", () => {
    expect(mismatchId({ snapshotFile: "a", key: "b" })).not.toBe(
      mismatchId({ snapshotFile: "a\u0000b", key: "" }),
    );
    expect(mismatchId({ snapshotFile: "a", key: "b" })).toBe(
      mismatchId({ snapshotFile: "a", key: "b" }),
    );
  });
});

describe("表示文", () => {
  it("承認結果・落としたヘッダー・カバレッジを日本語で表す", () => {
    expect(describeAcceptState("written")).toContain("書き込み");
    expect(describeAcceptState("updated")).toContain("置き換え");
    expect(describeDroppedHeaders({ hop: 2, headers: ["authorization", "cookie"] })).toBe(
      "2 回目のリダイレクトで authorization, cookie を落としました",
    );
    const summary = {
      operations: { total: 4, covered: 3, percent: 75 },
      violations: 1,
    } as OpenApiRunSummary;
    expect(describeOpenApiCoverage(summary)).toBe("オペレーション 3 / 4(75%)を照合、仕様違反 1 件");
  });
});

describe("splitAcceptable", () => {
  it("他のアサーションが失敗している項目は承認できない側に分け、順序は保つ", () => {
    const items = [
      mismatch({ key: "a" }),
      mismatch({ key: "b", otherAssertionsFailed: true }),
      mismatch({ key: "c" }),
    ];
    const { acceptable, blocked } = splitAcceptable(items);
    expect(acceptable.map((i) => i.key)).toEqual(["a", "c"]);
    expect(blocked.map((i) => i.key)).toEqual(["b"]);
    expect(splitAcceptable([])).toEqual({ acceptable: [], blocked: [] });
  });
});
