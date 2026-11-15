import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../src/core/history.js";
import { parseJsonPathPattern } from "../src/core/json-diff.js";
import {
  DEFAULT_IGNORED_HEADERS,
  diffRuns,
  type RunDiffOptions,
  resolveRunRef,
  selectRunEntries,
  summarizeRun,
} from "../src/core/run-diff.js";

let counter = 0;

/** 履歴エントリのテスト用ビルダー。startedAt は呼び出し順に増える */
type EntryOverrides = { [K in keyof HistoryEntry]?: HistoryEntry[K] | undefined } & {
  runId: string;
  step: string;
};

function entry(overrides: EntryOverrides): HistoryEntry {
  counter += 1;
  return {
    v: 1,
    flow: "f",
    startedAt: new Date(Date.UTC(2026, 10, 15, 0, 0, counter)).toISOString(),
    durationMs: 10,
    status: "passed",
    request: { method: "GET", url: "http://h/x", headers: {} },
    response: { status: 200, headers: {}, body: { ok: true } },
    assertions: [],
    ...overrides,
  } as HistoryEntry;
}

function options(overrides: Partial<RunDiffOptions> = {}): RunDiffOptions {
  return {
    ignoreHeaders: DEFAULT_IGNORED_HEADERS,
    ignorePaths: [],
    maxDifferences: 50,
    ...overrides,
  };
}

function compare(a: HistoryEntry[], b: HistoryEntry[], opts: RunDiffOptions = options()) {
  return diffRuns({ runId: "A", entries: a }, { runId: "B", entries: b }, opts);
}

describe("diffRuns", () => {
  it("同一の run は same で、各ステップが same になる", () => {
    const result = compare(
      [entry({ runId: "A", step: "s1" }), entry({ runId: "A", step: "s2" })],
      [entry({ runId: "B", step: "s1" }), entry({ runId: "B", step: "s2" })],
    );
    expect(result.status).toBe("same");
    expect(result.counts).toEqual({ same: 2, different: 0, added: 0, removed: 0 });
    expect(result.steps.map((s) => s.change)).toEqual(["same", "same"]);
  });

  it("ステータス・HTTP ステータス・エラーの変化を報告する", () => {
    const result = compare(
      [entry({ runId: "A", step: "s" })],
      [
        entry({
          runId: "B",
          step: "s",
          status: "failed",
          response: { status: 500, headers: {}, body: { ok: true } },
          error: "boom",
        }),
      ],
    );
    expect(result.status).toBe("different");
    expect(result.steps[0]).toMatchObject({
      change: "different",
      status: { a: "passed", b: "failed" },
      httpStatus: { a: 200, b: 500 },
      error: { b: "boom" },
    });
  });

  it("応答つきの error ステップ(capture の失敗など)と passed のステップは、ステータスとエラーの変化として比較できる", () => {
    const result = compare(
      [entry({ runId: "A", step: "s" })],
      [
        entry({
          runId: "B",
          step: "s",
          status: "error",
          error: 'capture "t": JSONPath "$.t" matched no value',
        }),
      ],
    );
    expect(result.steps[0]).toMatchObject({
      change: "different",
      status: { a: "passed", b: "error" },
      error: { b: 'capture "t": JSONPath "$.t" matched no value' },
    });
    expect(result.steps[0]?.httpStatus).toBeUndefined();
  });

  it("status フィールドが無い旧エントリは assertions から導出して比較する", () => {
    const legacy = entry({ runId: "A", step: "s" });
    delete legacy.status;
    const failing = entry({
      runId: "B",
      step: "s",
      assertions: [{ ok: false, kind: "status", message: "x" }],
    });
    delete failing.status;
    expect(compare([legacy], [failing]).steps[0]?.status).toEqual({ a: "passed", b: "failed" });
  });

  it("レスポンスヘッダーの追加・削除・変更を報告し、大文字小文字は区別しない", () => {
    const result = compare(
      [
        entry({
          runId: "A",
          step: "s",
          response: {
            status: 200,
            headers: { "X-Same": "1", "x-gone": "g", "x-chg": "1" },
            body: 1,
          },
        }),
      ],
      [
        entry({
          runId: "B",
          step: "s",
          response: {
            status: 200,
            headers: { "x-same": "1", "X-New": "n", "x-chg": "2" },
            body: 1,
          },
        }),
      ],
    );
    expect(result.steps[0]?.responseHeaders).toEqual({
      added: { "x-new": "n" },
      removed: { "x-gone": "g" },
      changed: { "x-chg": { a: "1", b: "2" } },
    });
  });

  it("既定の除外ヘッダーは無視され、--ignore-header で追加・--no-default-ignores で解除できる", () => {
    const a = entry({
      runId: "A",
      step: "s",
      response: { status: 200, headers: { date: "d1", etag: "e1" }, body: 1 },
    });
    const b = entry({
      runId: "B",
      step: "s",
      response: { status: 200, headers: { date: "d2", etag: "e2" }, body: 1 },
    });
    // 既定: date は無視、etag は比較される
    expect(compare([a], [b]).steps[0]?.responseHeaders?.changed).toEqual({
      etag: { a: "e1", b: "e2" },
    });
    // 追加指定
    expect(
      compare([a], [b], options({ ignoreHeaders: [...DEFAULT_IGNORED_HEADERS, "ETag"] })).status,
    ).toBe("same");
    // 既定を解除
    expect(
      Object.keys(
        compare([a], [b], options({ ignoreHeaders: [] })).steps[0]?.responseHeaders?.changed ?? {},
      ).sort(),
    ).toEqual(["date", "etag"]);
  });

  it("JSON body の構造差分を返し、ignorePaths の対象は無視する", () => {
    const a = entry({
      runId: "A",
      step: "s",
      response: { status: 200, headers: {}, body: { id: 1, name: "a", tags: ["x"] } },
    });
    const b = entry({
      runId: "B",
      step: "s",
      response: { status: 200, headers: {}, body: { id: 2, name: "b", tags: ["x", "y"] } },
    });
    expect(compare([a], [b]).steps[0]?.body).toEqual({
      kind: "json",
      total: 3,
      omitted: 0,
      differences: [
        { path: "$.id", kind: "changed", before: 1, after: 2 },
        { path: "$.name", kind: "changed", before: "a", after: "b" },
        { path: "$.tags[1]", kind: "added", after: "y" },
      ],
    });
    const ignorePaths = ["$.id", "$.tags"].map((s) => parseJsonPathPattern(s) as never);
    expect(compare([a], [b], options({ ignorePaths })).steps[0]?.body).toMatchObject({
      total: 1,
      differences: [{ path: "$.name" }],
    });
  });

  it("差分数が maxDifferences を超えたら打ち切り、省略件数を返す", () => {
    const body = (n: number) =>
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, n]));
    const result = compare(
      [entry({ runId: "A", step: "s", response: { status: 200, headers: {}, body: body(1) } })],
      [entry({ runId: "B", step: "s", response: { status: 200, headers: {}, body: body(2) } })],
      options({ maxDifferences: 2 }),
    );
    const diff = result.steps[0]?.body;
    expect(diff).toMatchObject({ kind: "json", total: 5, omitted: 3 });
    expect(diff && diff.kind === "json" ? diff.differences.length : -1).toBe(2);
  });

  it("JSON でない body は行単位の差分要約になり、片方だけ文字列なら type-changed になる", () => {
    const text = (body: string, runId: string) =>
      entry({ runId, step: "s", response: { status: 200, headers: {}, body } });
    expect(compare([text("a\nb\nc", "A")], [text("a\nB\nc\nd", "B")]).steps[0]?.body).toEqual({
      kind: "text",
      added: 2,
      removed: 1,
      omitted: 0,
      lines: [
        { op: "-", line: "b" },
        { op: "+", line: "B" },
        { op: "+", line: "d" },
      ],
    });
    const json = entry({
      runId: "B",
      step: "s",
      response: { status: 200, headers: {}, body: { a: 1 } },
    });
    expect(compare([text("<html>", "A")], [json]).steps[0]?.body).toMatchObject({
      kind: "json",
      differences: [{ path: "$", kind: "type-changed" }],
    });
  });

  it("リクエスト自体の変更(method / URL / body)はレスポンス差分とは別のフィールドに出る", () => {
    const a = entry({
      runId: "A",
      step: "s",
      request: { method: "POST", url: "http://h/x?v=1", headers: {}, body: { n: 1 } },
    });
    const b = entry({
      runId: "B",
      step: "s",
      request: { method: "PUT", url: "http://h/x?v=2", headers: {}, body: { n: 2 } },
    });
    const step = compare([a], [b]).steps[0];
    expect(step?.change).toBe("different");
    expect(step?.request).toMatchObject({
      method: { a: "POST", b: "PUT" },
      url: { a: "http://h/x?v=1", b: "http://h/x?v=2" },
      body: { kind: "json", differences: [{ path: "$.n", kind: "changed" }] },
    });
    expect(step?.body).toBeUndefined();
    expect(step?.httpStatus).toBeUndefined();
  });

  it("片側に request / response が無い(skipped)ステップは、ステータスと HTTP ステータスの変化だけを報告する", () => {
    const skipped = entry({
      runId: "B",
      step: "s",
      status: "skipped",
      request: undefined,
      response: undefined,
    });
    const step = compare([entry({ runId: "A", step: "s" })], [skipped]).steps[0];
    expect(step).toEqual({
      flow: "f",
      step: "s",
      change: "different",
      status: { a: "passed", b: "skipped" },
      httpStatus: { a: 200 },
    });
  });

  it("片方の run にだけあるステップは added / removed になる", () => {
    const result = compare(
      [entry({ runId: "A", step: "s1" }), entry({ runId: "A", step: "old" })],
      [entry({ runId: "B", step: "s1" }), entry({ runId: "B", step: "new" })],
    );
    expect(result.status).toBe("different");
    expect(result.steps.map((s) => [s.step, s.change])).toEqual([
      ["s1", "same"],
      ["old", "removed"],
      ["new", "added"],
    ]);
    expect(result.steps[1]?.status).toEqual({ a: "passed" });
    expect(result.steps[2]?.status).toEqual({ b: "passed" });
  });

  it("(flow, step, iteration) で突き合わせ、同一キーの重複は出現順で対応づける", () => {
    const row = (runId: string, iteration: number, status: number) =>
      entry({
        runId,
        step: "s",
        iteration,
        response: { status, headers: {}, body: 1 },
      });
    const result = compare(
      [row("A", 1, 200), row("A", 2, 200), entry({ runId: "A", step: "s", flow: "other" })],
      [row("B", 2, 200), row("B", 1, 404), entry({ runId: "B", step: "s", flow: "other" })],
    );
    expect(result.steps.map((s) => [s.flow, s.iteration, s.change])).toEqual([
      ["f", 1, "different"],
      ["f", 2, "same"],
      ["other", undefined, "same"],
    ]);

    const twice = compare(
      [entry({ runId: "A", step: "s" }), entry({ runId: "A", step: "s" })],
      [entry({ runId: "B", step: "s" })],
    );
    expect(twice.steps.map((s) => s.change)).toEqual(["same", "removed"]);
  });

  it("所要時間は閾値を指定した場合のみ、差の絶対値が閾値を超えたときに差分になる", () => {
    const a = entry({ runId: "A", step: "s", durationMs: 100 });
    const b = entry({ runId: "B", step: "s", durationMs: 400 });
    expect(compare([a], [b]).status).toBe("same");
    expect(compare([a], [b], options({ durationThresholdMs: 300 })).status).toBe("same");
    const result = compare([a], [b], options({ durationThresholdMs: 299 }));
    expect(result.steps[0]?.durationMs).toEqual({ a: 100, b: 400, delta: 300 });
    expect(
      compare([b], [a], options({ durationThresholdMs: 100 })).steps[0]?.durationMs?.delta,
    ).toBe(-300);
  });

  it("SSE イベントの差分を報告する", () => {
    const sse = (runId: string, data: string[]) =>
      entry({
        runId,
        step: "s",
        response: { status: 200, headers: {}, body: undefined },
        events: data.map((d) => ({ data: d })),
      });
    const result = compare([sse("A", ["1", "2"])], [sse("B", ["1", "3", "4"])]);
    expect(result.steps[0]?.events).toMatchObject({
      total: 2,
      differences: [{ path: "$[1].data" }, { path: "$[2]", kind: "added" }],
    });
  });

  it("マスク値(***)は自分自身と等しい(シークレットの変化は検出されない)", () => {
    const masked = (runId: string) =>
      entry({
        runId,
        step: "s",
        request: { method: "GET", url: "http://h/x", headers: {}, body: { password: "***" } },
        response: { status: 200, headers: { "x-token": "***" }, body: { token: "***" } },
      });
    expect(compare([masked("A")], [masked("B")]).status).toBe("same");
  });
});

describe("summarizeRun", () => {
  it("フロー・開始時刻・集約ステータス・監査項目を要約する", () => {
    const entries = [
      entry({ runId: "A", step: "s1", env: "local", actor: { kind: "agent", name: "x" } }),
      entry({ runId: "A", step: "s2", status: "failed", git: { commit: "abc", dirty: true } }),
    ];
    expect(summarizeRun("A", entries)).toEqual({
      runId: "A",
      flows: ["f"],
      startedAt: entries[0]?.startedAt,
      steps: 2,
      status: "failed",
      env: "local",
      actor: { kind: "agent", name: "x" },
      git: { commit: "abc", dirty: true },
    });
    expect(
      summarizeRun("A", [entry({ runId: "A", step: "e", status: "error" }), ...entries]).status,
    ).toBe("error");
  });
});

describe("同一 startedAt のステップ順", () => {
  it("selectRunEntries は新しい順の履歴から追記順(古い順)で取り出し、diffRuns はその順でペアリング・出力する", () => {
    const at = "2026-11-15T00:00:00.000Z";
    const appended = (runId: string, status: number) =>
      ["s1", "s2", "s3"].map((step, i) =>
        entry({
          runId,
          step,
          startedAt: at,
          response: { status: i === 1 ? status : 200, headers: {}, body: 1 },
        }),
      );
    const runA = appended("A", 200);
    const runB = appended("B", 500);
    // readAllHistoryEntries と同じ並び(新しい順。同時刻は追記順の逆)
    const history = [...runB, ...runA].reverse();
    const selectedA = selectRunEntries(history, "A");
    expect(selectedA.map((e) => e.step)).toEqual(["s1", "s2", "s3"]);
    // flow で絞っても順序は変わらず、他 run は含まない
    expect(selectRunEntries(history, "A", "f").map((e) => e.step)).toEqual(["s1", "s2", "s3"]);
    expect(selectRunEntries(history, "A", "other")).toEqual([]);

    const result = compare(selectedA, selectRunEntries(history, "B"));
    expect(result.steps.map((s) => [s.step, s.change])).toEqual([
      ["s1", "same"],
      ["s2", "different"],
      ["s3", "same"],
    ]);
  });

  it("同一キーのステップが複数あっても、同時刻なら追記順の n 番目同士を対応づける", () => {
    const at = "2026-11-15T00:00:00.000Z";
    const mk = (runId: string, statuses: number[]) =>
      statuses.map((status) =>
        entry({ runId, step: "s", startedAt: at, response: { status, headers: {}, body: 1 } }),
      );
    const history = [...mk("A", [200, 201]), ...mk("B", [200, 500])].reverse();
    const result = compare(selectRunEntries(history, "A"), selectRunEntries(history, "B"));
    expect(result.steps.map((s) => s.change)).toEqual(["same", "different"]);
    expect(result.steps[1]?.httpStatus).toEqual({ a: 201, b: 500 });
  });
});

describe("resolveRunRef", () => {
  const history = [
    entry({ runId: "r1", step: "s", flow: "f" }),
    entry({ runId: "r2", step: "s", flow: "f" }),
    entry({ runId: "r2", step: "t", flow: "f" }),
    entry({ runId: "r3", step: "s", flow: "g" }),
    entry({ runId: "r4", step: "s", flow: "f" }),
  ];

  it("latest / previous は --flow で絞った run を新しい順に解決する", () => {
    expect(resolveRunRef(history, "latest", "f")).toEqual({ ok: true, runId: "r4" });
    expect(resolveRunRef(history, "previous", "f")).toEqual({ ok: true, runId: "r2" });
    expect(resolveRunRef(history, "latest", "g")).toEqual({ ok: true, runId: "r3" });
  });

  it("latest / previous は flow 指定が必須で、該当 run が無ければエラーになる", () => {
    expect(resolveRunRef(history, "latest")).toEqual({
      ok: false,
      message: '"latest" requires --flow <name>',
    });
    expect(resolveRunRef(history, "previous", "g")).toMatchObject({ ok: false });
    expect(resolveRunRef(history, "latest", "none")).toMatchObject({ ok: false });
  });

  it("runId は完全一致のみ(前方一致は受け付けない)", () => {
    expect(resolveRunRef(history, "r2")).toEqual({ ok: true, runId: "r2" });
    expect(resolveRunRef(history, "r")).toEqual({
      ok: false,
      message: 'no history entries found for runId "r"',
    });
  });
});
