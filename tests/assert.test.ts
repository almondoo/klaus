import { describe, expect, it } from "vitest";
import {
  assertBody,
  assertBodySchema,
  assertBodyText,
  assertDuration,
  assertEventCount,
  assertEvents,
  assertHeaders,
  assertMessages,
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

  it("構文が不正な jsonpath 式でも例外を投げず、ok:false を返す(safeJsonPath の catch 分岐)", () => {
    let results: ReturnType<typeof assertBody> = [];
    expect(() => {
      results = assertBody([{ path: "$[?(", exists: true }], json);
    }).not.toThrow();
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.actual).toBe(false);
  });

  it("equals はネストしたオブジェクト・配列を構造的に比較する(一致)", () => {
    const results = assertBody(
      [
        { path: "$.user", equals: { email: "a@example.com" } },
        { path: "$.items", equals: [1, 2, 3] },
      ],
      json,
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("equals はネストしたオブジェクト・配列を構造的に比較する(不一致)", () => {
    const objectMismatch = assertBody(
      [{ path: "$.user", equals: { email: "different@example.com" } }],
      json,
    );
    expect(objectMismatch[0]?.ok).toBe(false);

    const arrayLengthMismatch = assertBody([{ path: "$.items", equals: [1, 2] }], json);
    expect(arrayLengthMismatch[0]?.ok).toBe(false);

    const arrayElementMismatch = assertBody([{ path: "$.items", equals: [1, 2, 4] }], json);
    expect(arrayElementMismatch[0]?.ok).toBe(false);
  });

  it("contains / regex を存在しない path(undefined 値)に適用すると空文字列として評価される", () => {
    const results = assertBody(
      [
        { path: "$.missing", contains: "x" },
        { path: "$.missing", regex: "^$" },
      ],
      json,
    );
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.actual).toBe("");
    // 正規表現自体は空文字列にマッチするが、path が存在しない(resolvedExists:false)ため ok:false になる
    expect(results[1]?.ok).toBe(false);
    expect(results[1]?.actual).toBe("");
  });

  it("contains / regex を文字列でない値(配列)に適用すると JSON.stringify した文字列として評価される", () => {
    const results = assertBody(
      [
        { path: "$.items", contains: "2" },
        { path: "$.items", regex: "^\\[1,2,3\\]$" },
      ],
      json,
    );
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.actual).toBe("[1,2,3]");
    expect(results[1]?.ok).toBe(true);
  });
});

describe("assertBodySchema", () => {
  it("スキーマに適合すれば ok:true の結果を1件返す", () => {
    const results = assertBodySchema(
      { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      { ok: true },
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.kind).toBe("bodySchema");
  });

  it("複数の違反があれば違反ごとに AssertionResult を返し、message に instancePath を含める", () => {
    const results = assertBodySchema(
      {
        type: "object",
        properties: { name: { type: "string" }, age: { type: "number" } },
        required: ["name", "age"],
      },
      { name: 123, age: "old" },
    );
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.every((r) => r.ok === false)).toBe(true);
    expect(results.some((r) => r.message.includes("/name"))).toBe(true);
    expect(results.some((r) => r.message.includes("/age"))).toBe(true);
  });

  it("不正なスキーマはコンパイルエラーとして ok:false で報告される(例外を投げない)", () => {
    const results = assertBodySchema({ type: "not-a-real-type" }, { ok: true });
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.kind).toBe("bodySchema");
    expect(results[0]?.message).toMatch(/invalid JSON Schema/);
  });

  it("body が undefined(WS ステップ等)なら ok:false で報告される", () => {
    const results = assertBodySchema({ type: "object" }, undefined);
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.kind).toBe("bodySchema");
  });

  it("body が存在するが JSON でない場合、生の文字列がそのまま ajv 検証にかけられる(スキーマが string型なら ok:true)", () => {
    const results = assertBodySchema({ type: "string" }, "hello world");
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.kind).toBe("bodySchema");
  });

  it("body が存在するが JSON でない場合、生の文字列がそのまま ajv 検証にかけられる(スキーマが object型なら ok:false。undefined 時の強制 ok:false 分岐とは異なる)", () => {
    const results = assertBodySchema({ type: "object" }, "hello world");
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.kind).toBe("bodySchema");
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

  it("data が JSON でない場合、path 指定は exists:false として扱われる(resolveItemValue の catch 分岐)", () => {
    const brokenEvents = [{ data: "not json {{{" }];
    const results = assertEvents([{ index: 0, path: "$.foo", exists: true }], brokenEvents);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.actual).toBe(false);
  });

  it("index が受信イベント数を超える場合、対象なしとして exists:false で評価される", () => {
    const results = assertEvents([{ index: 5, exists: true }], events);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.kind).toBe("event.exists");
    expect(results[0]?.actual).toBe(false);
  });
});

describe("assertMessages", () => {
  it("index が受信メッセージ数を超える場合、対象なしとして評価される(assertEvents と同一ロジック)", () => {
    const messages = [{ data: "1" }];
    const results = assertMessages([{ index: 3, equals: "x" }], messages);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.kind).toBe("message.equals");
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

  it("bodySchema を含めて評価される", () => {
    const results = evaluateAssertions(
      { status: 200, bodySchema: { type: "object", required: ["ok"] } },
      { status: 200, headers: {}, body: { ok: true }, bodyText: "", durationMs: 1 },
    );
    expect(results.some((r) => r.kind === "bodySchema" && r.ok)).toBe(true);
  });

  it("複数種類のアサーションをまとめて評価する", () => {
    const results = evaluateAssertions(
      { status: 200, body: [{ path: "$.ok", equals: true }] },
      { status: 200, headers: {}, body: { ok: true }, bodyText: "", durationMs: 1 },
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
