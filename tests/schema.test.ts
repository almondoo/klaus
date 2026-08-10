import { describe, expect, it } from "vitest";
import { environmentSchema, flowSchema } from "../src/core/schema.js";

describe("flowSchema", () => {
  it("有効なフロー定義を検証し、method を大文字化しデフォルト値を適用する", () => {
    const result = flowSchema.parse({
      name: "sample flow",
      steps: [
        {
          name: "step1",
          request: {
            method: "get",
            url: "https://example.com",
          },
        },
      ],
    });

    expect(result.steps[0]?.request?.method).toBe("GET");
    expect(result.steps[0]?.request?.timeoutMs).toBe(30000);
  });

  it("sse オプションのデフォルト値(maxEvents=100, maxDurationMs=10000)を適用する", () => {
    const result = flowSchema.parse({
      name: "sse flow",
      steps: [
        {
          name: "stream",
          request: { method: "GET", url: "https://example.com" },
          sse: {},
        },
      ],
    });

    expect(result.steps[0]?.sse).toEqual({ maxEvents: 100, maxDurationMs: 10000 });
  });

  it("steps が空配列だと検証エラーになる", () => {
    expect(() =>
      flowSchema.parse({
        name: "empty flow",
        steps: [],
      }),
    ).toThrow();
  });

  it("フロー内でステップ名が重複していると検証エラーになる", () => {
    expect(() =>
      flowSchema.parse({
        name: "dup flow",
        steps: [
          { name: "same", request: { method: "GET", url: "https://example.com" } },
          { name: "same", request: { method: "GET", url: "https://example.com" } },
        ],
      }),
    ).toThrow();
  });

  it("assert 定義のネストしたフィールドを検証する", () => {
    const result = flowSchema.parse({
      name: "assert flow",
      steps: [
        {
          name: "step1",
          request: { method: "POST", url: "https://example.com" },
          assert: {
            status: 200,
            headers: [{ name: "Content-Type", contains: "json" }],
            body: [{ path: "$.token", exists: true }],
            bodyText: { contains: "ok" },
            duration: { maxMs: 1000 },
            eventCount: { min: 1 },
            events: [{ index: 0, path: "$.foo", equals: "bar" }],
          },
        },
      ],
    });

    expect(result.steps[0]?.assert?.status).toBe(200);
  });
});

describe("requestSchema / query", () => {
  it("query は Record<string,string> として受理される", () => {
    const result = flowSchema.parse({
      name: "query flow",
      steps: [
        {
          name: "step1",
          request: {
            method: "GET",
            url: "https://example.com",
            query: { page: "1", q: "{{keyword}}" },
          },
        },
      ],
    });

    expect(result.steps[0]?.request?.query).toEqual({ page: "1", q: "{{keyword}}" });
  });

  it("query は任意項目のため未指定でも検証エラーにならない", () => {
    const result = flowSchema.parse({
      name: "no query flow",
      steps: [{ name: "step1", request: { method: "GET", url: "https://example.com" } }],
    });

    expect(result.steps[0]?.request?.query).toBeUndefined();
  });

  it("query の値が文字列以外だと検証エラーになる", () => {
    expect(() =>
      flowSchema.parse({
        name: "invalid query flow",
        steps: [
          {
            name: "step1",
            request: { method: "GET", url: "https://example.com", query: { page: 1 } },
          },
        ],
      }),
    ).toThrow();
  });
});

describe("requestSchema / graphql", () => {
  it("request.body と request.graphql は排他: 両方指定すると検証エラーになる", () => {
    expect(() =>
      flowSchema.parse({
        name: "graphql flow",
        steps: [
          {
            name: "step1",
            request: {
              url: "https://example.com/graphql",
              body: { foo: "bar" },
              graphql: { query: "{ me { id } }" },
            },
          },
        ],
      }),
    ).toThrow();
  });
});

describe("stepSchema / ws", () => {
  it("step.request と step.ws は排他かつどちらか一方が必須", () => {
    // 両方指定
    expect(() =>
      flowSchema.parse({
        name: "both flow",
        steps: [
          {
            name: "step1",
            request: { method: "GET", url: "https://example.com" },
            ws: { url: "ws://example.com" },
          },
        ],
      }),
    ).toThrow();

    // どちらも未指定
    expect(() =>
      flowSchema.parse({
        name: "neither flow",
        steps: [{ name: "step1" }],
      }),
    ).toThrow();
  });

  it("ws.url が http(s):// で始まると検証エラーになる", () => {
    expect(() =>
      flowSchema.parse({
        name: "ws scheme flow",
        steps: [{ name: "step1", ws: { url: "http://example.com/socket" } }],
      }),
    ).toThrow();
  });
});

describe("strict object schemas / unknown keys", () => {
  it("フロー直下に未知キーがあると検証エラーになる", () => {
    expect(() =>
      flowSchema.parse({
        name: "flow",
        unknownTopLevel: true,
        steps: [{ name: "step1", request: { method: "GET", url: "https://example.com" } }],
      }),
    ).toThrow();
  });

  it("step 直下の未知キー(typo 含む)は検証エラーになる", () => {
    expect(() =>
      flowSchema.parse({
        name: "flow",
        steps: [
          {
            name: "step1",
            request: { method: "GET", url: "https://example.com" },
            // "assert" の typo
            asssert: { status: 200 },
          },
        ],
      }),
    ).toThrow();
  });

  it("request 直下の未知キーは検証エラーになる", () => {
    expect(() =>
      flowSchema.parse({
        name: "flow",
        steps: [
          {
            name: "step1",
            request: { method: "GET", url: "https://example.com", extraField: "x" },
          },
        ],
      }),
    ).toThrow();
  });

  it("assert 直下の未知キーは検証エラーになる", () => {
    expect(() =>
      flowSchema.parse({
        name: "flow",
        steps: [
          {
            name: "step1",
            request: { method: "GET", url: "https://example.com" },
            assert: { status: 200, unexpectedKey: true },
          },
        ],
      }),
    ).toThrow();
  });

  // 残りのネスト箇所も一律 strict であることをフロー経由で網羅する(機構は共通のため代表値で確認)
  it.each([
    ["ws 直下", { name: "s", ws: { url: "ws://example.com", send: [], extraKey: 1 } }],
    [
      "sse オプション直下",
      {
        name: "s",
        request: { method: "GET", url: "https://example.com" },
        sse: { maxEvents: 1, extraKey: 1 },
      },
    ],
    [
      "graphql 直下",
      {
        name: "s",
        request: {
          url: "https://example.com",
          graphql: { query: "query { ok }", extraKey: 1 },
        },
      },
    ],
    [
      "assert.headers の要素",
      {
        name: "s",
        request: { method: "GET", url: "https://example.com" },
        assert: { headers: [{ name: "content-type", contains: "json", extraKey: 1 }] },
      },
    ],
    [
      "assert.body の要素",
      {
        name: "s",
        request: { method: "GET", url: "https://example.com" },
        assert: { body: [{ path: "$.ok", equals: true, extraKey: 1 }] },
      },
    ],
    [
      "assert.duration 直下",
      {
        name: "s",
        request: { method: "GET", url: "https://example.com" },
        assert: { duration: { maxMs: 100, extraKey: 1 } },
      },
    ],
    [
      "assert.events の要素",
      {
        name: "s",
        request: { method: "GET", url: "https://example.com" },
        sse: {},
        assert: { events: [{ index: 0, extraKey: 1 }] },
      },
    ],
  ])("%s の未知キーは検証エラーになる", (_label, step) => {
    expect(() => flowSchema.parse({ name: "flow", steps: [step] })).toThrow();
  });

  it("headers/query/capture は Record として自由なキーを許可する(strict 化の対象外)", () => {
    const result = flowSchema.parse({
      name: "flow",
      steps: [
        {
          name: "step1",
          request: {
            method: "GET",
            url: "https://example.com",
            headers: { "X-Any-Header": "value" },
            query: { anyKey: "value" },
          },
          capture: { anyVarName: "$.foo" },
        },
      ],
    });

    expect(result.steps[0]?.request?.headers).toEqual({ "X-Any-Header": "value" });
    expect(result.steps[0]?.capture).toEqual({ anyVarName: "$.foo" });
  });
});

describe("environmentSchema", () => {
  it("Record<string,string> を受け入れる", () => {
    const result = environmentSchema.parse({ baseUrl: "http://localhost:3000", token: "abc" });
    expect(result.baseUrl).toBe("http://localhost:3000");
  });

  it("値が数値など文字列以外だと検証エラーになる", () => {
    expect(() => environmentSchema.parse({ port: 3000 })).toThrow();
  });

  it("予約キー $protected(boolean)を受け入れる", () => {
    const result = environmentSchema.parse({ baseUrl: "http://localhost:3000", $protected: true });
    expect(result.$protected).toBe(true);
    expect(result.baseUrl).toBe("http://localhost:3000");
  });

  it("$protected に文字列を渡すと検証エラーになる(boolean 専用)", () => {
    expect(() => environmentSchema.parse({ $protected: "true" })).toThrow();
  });
});
