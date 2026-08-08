import { describe, expect, it } from "vitest";
import {
  assertBody,
  assertBodyText,
  assertDuration,
  assertEventCount,
  assertEvents,
  assertHeaders,
  assertStatus,
  evaluateAssertions,
} from "../src/core/assert.js";

describe("assertStatus", () => {
  it("一致すれば ok:true", () => {
    const result = assertStatus(200, 200);
    expect(result[0]?.ok).toBe(true);
  });

  it("不一致なら ok:false", () => {
    const result = assertStatus(200, 404);
    expect(result[0]?.ok).toBe(false);
    expect(result[0]?.message).toContain("404");
  });

  it("未指定なら結果を返さない", () => {
    expect(assertStatus(undefined, 200)).toEqual([]);
  });
});

describe("assertHeaders", () => {
  const headers = { "content-type": "application/json; charset=utf-8" };

  it("equals / contains / regex / exists を評価する(ヘッダー名は大文字小文字無視)", () => {
    const results = assertHeaders(
      [
        { name: "Content-Type", contains: "json" },
        { name: "Content-Type", regex: "^application/" },
        { name: "Content-Type", exists: true },
        { name: "X-Missing", exists: false },
      ],
      headers,
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("存在しないヘッダーへの equals は失敗する", () => {
    const results = assertHeaders([{ name: "X-Missing", equals: "foo" }], headers);
    expect(results[0]?.ok).toBe(false);
  });
});

describe("assertBody", () => {
  const json = { token: "abc123", user: { email: "a@example.com" }, items: [1, 2, 3] };

  it("jsonpath で exists / equals / contains / regex を評価する", () => {
    const results = assertBody(
      [
        { path: "$.token", exists: true },
        { path: "$.user.email", equals: "a@example.com" },
        { path: "$.token", contains: "abc" },
        { path: "$.token", regex: "^abc" },
      ],
      json,
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("存在しない path は exists:false になる", () => {
    const results = assertBody([{ path: "$.missing", exists: true }], json);
    expect(results[0]?.ok).toBe(false);
  });

  it("不正な形状(文字列に対する jsonpath 適用)でも例外を投げず、ok:false を返す", () => {
    let results: ReturnType<typeof assertBody> = [];
    expect(() => {
      results = assertBody([{ path: "$.token", exists: true }], "plain text");
    }).not.toThrow();
    expect(results[0]?.ok).toBe(false);
  });
});

describe("assertBodyText", () => {
  it("生テキストに対して equals / contains / regex を評価する", () => {
    const results = assertBodyText({ contains: "hello", regex: "^hello" }, "hello world");
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe("assertDuration", () => {
  it("maxMs 以下なら ok:true", () => {
    expect(assertDuration({ maxMs: 1000 }, 500)[0]?.ok).toBe(true);
  });

  it("maxMs を超えたら ok:false", () => {
    expect(assertDuration({ maxMs: 1000 }, 1500)[0]?.ok).toBe(false);
  });
});

describe("assertEventCount", () => {
  const events = [{ data: "1" }, { data: "2" }, { data: "3" }];

  it("equals / min / max を評価する", () => {
    const results = assertEventCount({ equals: 3, min: 2, max: 5 }, events);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("件数が合わなければ ok:false", () => {
    const results = assertEventCount({ equals: 5 }, events);
    expect(results[0]?.ok).toBe(false);
  });
});

describe("assertEvents", () => {
  const events = [
    { event: "message", data: JSON.stringify({ foo: "bar" }) },
    { event: "message", data: JSON.stringify({ foo: "baz" }) },
  ];

  it("index 指定時はそのイベントの path を評価する", () => {
    const results = assertEvents([{ index: 1, path: "$.foo", equals: "baz" }], events);
    expect(results[0]?.ok).toBe(true);
  });

  it("index 未指定時はいずれかのイベントが一致すれば pass", () => {
    const results = assertEvents([{ path: "$.foo", equals: "bar" }], events);
    expect(results[0]?.ok).toBe(true);
  });

  it("index 未指定時、どのイベントも一致しなければ fail", () => {
    const results = assertEvents([{ path: "$.foo", equals: "not-found" }], events);
    expect(results[0]?.ok).toBe(false);
  });

  it("path 省略時は data 生文字列にマッチャーを適用する", () => {
    const rawEvents = [{ data: "hello" }, { data: "world" }];
    const results = assertEvents([{ contains: "wor" }], rawEvents);
    expect(results[0]?.ok).toBe(true);
  });
});

describe("evaluateAssertions", () => {
  it("assert 未指定なら空配列を返す", () => {
    expect(
      evaluateAssertions(undefined, {
        status: 200,
        headers: {},
        body: {},
        bodyText: "",
        durationMs: 1,
      }),
    ).toEqual([]);
  });

  it("複数種類のアサーションをまとめて評価する", () => {
    const results = evaluateAssertions(
      { status: 200, body: [{ path: "$.ok", equals: true }] },
      { status: 200, headers: {}, body: { ok: true }, bodyText: "", durationMs: 1 },
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
