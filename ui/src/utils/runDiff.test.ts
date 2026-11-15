import { describe, expect, it } from "vitest";
import type { StepDiff } from "@/api/types";
import type { HistoryRunGroup } from "./history";
import {
  commonFlow,
  findPreviousRun,
  generalizePath,
  isSingleGroup,
  isVolatileKey,
  lastKeyOf,
  normalizeIgnoreInput,
  orderRunPair,
  previewValue,
  requestChangeCount,
  responseChangeCount,
  suggestIgnorePaths,
  summarizeStep,
  withOccurrenceKeys,
} from "./runDiff";

function group(runId: string, startedAt: string, flow: string): HistoryRunGroup {
  return {
    runId,
    flow,
    startedAt,
    durationMs: 1,
    status: "passed",
    steps: [
      {
        v: 1,
        runId,
        flow,
        step: "s",
        startedAt,
        durationMs: 1,
        assertions: [],
      },
    ],
  };
}

function jsonStep(paths: string[]): StepDiff {
  return {
    flow: "f",
    step: "s",
    change: "different",
    body: {
      kind: "json",
      total: paths.length,
      omitted: 0,
      differences: paths.map((path) => ({ path, kind: "changed", before: 1, after: 2 })),
    },
  };
}

describe("previewValue", () => {
  it("短い値はそのまま、undefined は (なし)", () => {
    expect(previewValue("a", 10)).toEqual({ text: '"a"', full: '"a"', truncated: false });
    expect(previewValue(undefined, 10).text).toBe("(なし)");
  });

  it("長い値は先頭だけにして truncated を立て、全文も保持する", () => {
    const result = previewValue("x".repeat(50), 10);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(result.full.length);
    expect(result.full).toBe(JSON.stringify("x".repeat(50)));
  });
});

describe("generalizePath / lastKeyOf", () => {
  it("配列の添字を [*] にする", () => {
    expect(generalizePath("$.items[0].createdAt")).toBe("$.items[*].createdAt");
    expect(generalizePath("$[3][12].a")).toBe("$[*][*].a");
  });

  it("引用つきキーの中の [数字] はキー名なので変えない", () => {
    expect(generalizePath("$['a[1]'][2]")).toBe("$['a[1]'][*]");
    expect(generalizePath("$['it\\'s[0]'].x")).toBe("$['it\\'s[0]'].x");
  });

  it("最後のキー名を取り出す(添字で終わるなら undefined)", () => {
    expect(lastKeyOf("$.a.createdAt")).toBe("createdAt");
    expect(lastKeyOf("$['x-y']")).toBe("x-y");
    expect(lastKeyOf("$.items[*]")).toBeUndefined();
  });
});

describe("isVolatileKey", () => {
  it.each(["id", "createdAt", "updated_at", "requestId", "etag", "timestamp", "userId"])(
    "%s は変わりやすい",
    (key) => expect(isVolatileKey(key)).toBe(true),
  );
  it.each(["name", "status", "title", undefined])("%s は変わりやすいとは判断しない", (key) =>
    expect(isVolatileKey(key)).toBe(false),
  );
});

describe("suggestIgnorePaths", () => {
  it("同じ形のパスを 1 つにまとめ、変わりやすいキーを先頭・件数の多い順に並べる", () => {
    const steps = [
      jsonStep(["$.items[0].createdAt", "$.items[1].createdAt", "$.status", "$.name"]),
      jsonStep(["$.name", "$.id"]),
    ];
    const suggestions = suggestIgnorePaths(steps, []);
    expect(suggestions.map((s) => s.pattern)).toEqual([
      "$.items[*].createdAt",
      "$.id",
      "$.name",
      "$.status",
    ]);
    expect(suggestions[0]).toMatchObject({ count: 2, volatile: true });
    expect(suggestions[2]).toMatchObject({ count: 2, volatile: false });
  });

  it("除外済みのパターン・ルート・too-deep は含めず、件数を制限する", () => {
    const step: StepDiff = {
      flow: "f",
      step: "s",
      change: "different",
      body: {
        kind: "json",
        total: 3,
        omitted: 0,
        differences: [
          { path: "$", kind: "type-changed", before: 1, after: "a" },
          { path: "$.deep", kind: "too-deep" },
          { path: "$.id", kind: "changed", before: 1, after: 2 },
        ],
      },
    };
    expect(suggestIgnorePaths([step], ["$.id"])).toEqual([]);
    expect(
      suggestIgnorePaths([jsonStep(["$.a", "$.b", "$.c"])], [], 2).map((s) => s.pattern),
    ).toEqual(["$.a", "$.b"]);
  });

  it("リクエスト body と SSE イベントの差分からも候補を作る", () => {
    const step: StepDiff = {
      flow: "f",
      step: "s",
      change: "different",
      request: {
        body: {
          kind: "json",
          total: 1,
          omitted: 0,
          differences: [{ path: "$.nonce", kind: "changed", before: "a", after: "b" }],
        },
      },
      events: {
        total: 1,
        omitted: 0,
        differences: [{ path: "$[0].data", kind: "changed", before: "a", after: "b" }],
      },
    };
    expect(suggestIgnorePaths([step], []).map((s) => s.pattern)).toEqual(["$.nonce", "$[*].data"]);
  });
});

describe("normalizeIgnoreInput", () => {
  it("前後の空白を除き、空・$ で始まらない・重複は null", () => {
    expect(normalizeIgnoreInput("  $.a  ", [])).toBe("$.a");
    expect(normalizeIgnoreInput("", [])).toBeNull();
    expect(normalizeIgnoreInput("a.b", [])).toBeNull();
    expect(normalizeIgnoreInput("$.a", ["$.a"])).toBeNull();
  });
});

describe("変更件数と要約", () => {
  const step: StepDiff = {
    flow: "f",
    step: "s",
    change: "different",
    status: { a: "passed", b: "failed" },
    httpStatus: { a: 200, b: 500 },
    request: { url: { a: "x", b: "y" } },
    responseHeaders: { added: { a: "1" }, removed: {}, changed: { b: { a: "1", b: "2" } } },
    body: { kind: "text", added: 2, removed: 1, omitted: 0, lines: [] },
    events: { total: 4, omitted: 0, differences: [] },
    durationMs: { a: 10, b: 30, delta: 20 },
  };

  it("リクエストとレスポンスの件数を別々に数える", () => {
    expect(requestChangeCount(step)).toBe(1);
    expect(responseChangeCount(step)).toBe(2 + 3 + 4);
    expect(requestChangeCount({ flow: "f", step: "s", change: "same" })).toBe(0);
  });

  it("見出し用の要約を作る", () => {
    expect(summarizeStep(step)).toEqual([
      "状態 passed → failed",
      "HTTP 200 → 500",
      "リクエスト 1 件",
      "レスポンス 9 件",
      "所要時間 +20ms",
    ]);
    expect(summarizeStep({ flow: "f", step: "s", change: "same" })).toEqual([]);
  });
});

describe("run の組み合わせ", () => {
  const groups = [
    group("r4", "2026-01-04T00:00:00Z", "orders"),
    group("r3", "2026-01-03T00:00:00Z", "users"),
    group("r2", "2026-01-02T00:00:00Z", "orders"),
    group("r1", "2026-01-01T00:00:00Z", "orders"),
  ];

  it("前回の同じフローは、より古く同じフロー名の直近の run", () => {
    expect(findPreviousRun(groups, groups[0] as HistoryRunGroup)?.runId).toBe("r2");
    expect(findPreviousRun(groups, groups[2] as HistoryRunGroup)?.runId).toBe("r1");
    expect(findPreviousRun(groups, groups[3] as HistoryRunGroup)).toBeUndefined();
  });

  it("単発リクエストには前回の同じフローが無い", () => {
    const single = [
      group("s2", "2026-01-02T00:00:00Z", "(single)"),
      group("s1", "2026-01-01T00:00:00Z", "(single)"),
    ];
    expect(isSingleGroup(single[0] as HistoryRunGroup)).toBe(true);
    expect(findPreviousRun(single, single[0] as HistoryRunGroup)).toBeUndefined();
  });

  it("--data の iteration 表示名ではなく記録されたフロー名で探し、同じ runId は相手にしない", () => {
    const iter = (runId: string, startedAt: string) => ({
      ...group(runId, startedAt, "orders (iteration 1)"),
      steps: group(runId, startedAt, "orders").steps,
    });
    const list = [
      iter("r2", "2026-01-02T00:00:00Z"),
      iter("r2", "2026-01-02T00:00:00Z"),
      iter("r1", "2026-01-01T00:00:00Z"),
    ];
    expect(findPreviousRun(list, list[0] as HistoryRunGroup)?.runId).toBe("r1");
  });

  it("2 つの run は古い方が A になり、フローが同じ(単発でない)ときだけ flow を渡す", () => {
    const [newest, , older] = groups as [HistoryRunGroup, HistoryRunGroup, HistoryRunGroup];
    expect(orderRunPair(newest, older)).toEqual({ a: "r2", b: "r4" });
    expect(orderRunPair(older, newest)).toEqual({ a: "r2", b: "r4" });
    expect(commonFlow(newest, older)).toEqual({ flow: "orders" });
    expect(commonFlow(newest, groups[1] as HistoryRunGroup)).toEqual({});
    const s1 = group("s1", "2026-01-01T00:00:00Z", "(single)");
    expect(commonFlow(s1, s1)).toEqual({});
  });
});

describe("withOccurrenceKeys", () => {
  it("同じ基本キーには出現順の番号を付けて一意にする", () => {
    const keyed = withOccurrenceKeys(["a", "b", "a", "a"], (x) => x);
    expect(keyed.map((k) => k.key)).toEqual(["a#0", "b#0", "a#1", "a#2"]);
    expect(keyed.map((k) => k.item)).toEqual(["a", "b", "a", "a"]);
  });
});
