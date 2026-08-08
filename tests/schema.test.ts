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

describe("environmentSchema", () => {
  it("Record<string,string> を受け入れる", () => {
    const result = environmentSchema.parse({ baseUrl: "http://localhost:3000", token: "abc" });
    expect(result.baseUrl).toBe("http://localhost:3000");
  });

  it("値が数値など文字列以外だと検証エラーになる", () => {
    expect(() => environmentSchema.parse({ port: 3000 })).toThrow();
  });
});
