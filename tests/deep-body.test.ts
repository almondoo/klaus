import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertEvents } from "../src/core/assert.js";
import { cassetteEntryToHttpResponse } from "../src/core/cassette.js";
import { BODY_TOO_DEEP_MESSAGE, MAX_JSON_BODY_DEPTH } from "../src/core/json-diff.js";
import { executeFlow } from "../src/core/runner.js";
import { flowSchema } from "../src/core/schema.js";
import { closeServer, listenEphemeral } from "./support/net.js";

/**
 * 入れ子が MAX_JSON_BODY_DEPTH を超える JSON 応答はテキストのまま保持される。
 * その文字列に JSONPath を当てると `$[0]` が文字の添字になり誤った値に一致するため、
 * capture・body アサーション・bodySchema は一致させず、明示的に失敗することを確認する。
 * 深い JSON はテキストとして組み立てる(深い値を JSON.stringify しない: Node 22.19 でスタックが溢れるため)。
 */

/** 配列を levels 段入れ子にし、いちばん内側に "LEAF" を 1 つ置いた JSON テキスト */
function nested(levels: number): string {
  return `${"[".repeat(levels)}"LEAF"${"]".repeat(levels)}`;
}

/** $ の後ろに [0] を levels 回並べた JSONPath(nested(levels) の LEAF を指す) */
function leafPath(levels: number): string {
  return `$${"[0]".repeat(levels)}`;
}

const tmpRoot = join(process.cwd(), "tmp");
let server: Server;
let baseUrl = "";
let received: string[] = [];
let cwd = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const depth = /^\/depth\/(\d+)$/.exec(req.url ?? "");
      if (depth) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(nested(Number(depth[1])));
        return;
      }
      received.push(`${req.method} ${req.url} ${Buffer.concat(chunks).toString("utf-8")}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  ({ baseUrl } = await listenEphemeral(server));
  await mkdir(tmpRoot, { recursive: true });
});

afterAll(async () => {
  await closeServer(server);
});

beforeEach(async () => {
  received = [];
  cwd = await mkdtemp(join(tmpRoot, "klaus-deep-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** /depth/<levels> を取得して LEAF を capture し、次のステップで /sink へ送るフロー */
function captureFlow(levels: number) {
  return flowSchema.parse({
    name: "deep capture",
    steps: [
      {
        name: "fetch",
        request: { method: "GET", url: `${baseUrl}/depth/${levels}` },
        capture: { v: leafPath(levels) },
      },
      {
        name: "send",
        request: { method: "POST", url: `${baseUrl}/sink`, body: "value={{v}}" },
      },
    ],
  });
}

describe("深い JSON 応答の JSONPath capture", () => {
  it(`上限ちょうど(${MAX_JSON_BODY_DEPTH} 段)は構造化されて LEAF を capture でき、次のステップへ渡る`, async () => {
    const result = await executeFlow(captureFlow(MAX_JSON_BODY_DEPTH), "deep.yaml", {
      cwd,
      history: false,
    });

    expect(result.status).toBe("passed");
    expect(received).toEqual(["POST /sink value=LEAF"]);
  });

  it(`上限を 1 段超える(${MAX_JSON_BODY_DEPTH + 1} 段)と、capture は明示的なエラーで失敗し、文字(\`[\`)を次へ送らない`, async () => {
    const result = await executeFlow(captureFlow(MAX_JSON_BODY_DEPTH + 1), "deep.yaml", {
      cwd,
      history: false,
    });

    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain(BODY_TOO_DEEP_MESSAGE);
    expect(result.steps[1]?.status).toBe("skipped");
    expect(received).toEqual([]);
    // 応答自体は、テキストのままであることが分かる印つきで結果に残る
    expect(result.steps[0]?.response).toMatchObject({ status: 200, bodyTooDeep: true });
    expect(typeof result.steps[0]?.response?.body).toBe("string");
  });

  it("本文テキストへの regex の capture は、深い JSON でも使える", async () => {
    const flow = flowSchema.parse({
      name: "deep regex",
      steps: [
        {
          name: "fetch",
          request: { method: "GET", url: `${baseUrl}/depth/${MAX_JSON_BODY_DEPTH + 50}` },
          capture: { v: { regex: '"(LEAF)"' } },
        },
        { name: "send", request: { method: "POST", url: `${baseUrl}/sink`, body: "v={{v}}" } },
      ],
    });

    const result = await executeFlow(flow, "deep.yaml", { cwd, history: false });

    expect(result.status).toBe("passed");
    expect(received).toEqual(["POST /sink v=LEAF"]);
  });
});

describe("深い JSON 応答のアサーション", () => {
  it("body の path(exists を含む)と bodySchema は、評価せずに明示的なメッセージで失敗し、bodyText と status は評価される", async () => {
    const flow = flowSchema.parse({
      name: "deep assert",
      steps: [
        {
          name: "fetch",
          request: { method: "GET", url: `${baseUrl}/depth/${MAX_JSON_BODY_DEPTH + 1}` },
          assert: {
            status: 200,
            body: [{ path: "$[0][0][0]", exists: true }],
            bodySchema: { type: "object" },
            bodyText: { contains: "LEAF" },
          },
        },
      ],
    });

    const result = await executeFlow(flow, "deep.yaml", { cwd, history: false });

    const assertions = result.steps[0]?.assertions ?? [];
    expect(result.steps[0]?.status).toBe("failed");
    expect(assertions.filter((a) => a.ok).map((a) => a.kind)).toEqual(
      expect.arrayContaining(["status", "bodyText.contains"]),
    );
    const failed = assertions.filter((a) => !a.ok);
    expect(failed.map((a) => a.kind)).toEqual(["body", "bodySchema"]);
    for (const assertion of failed) expect(assertion.message).toContain(BODY_TOO_DEEP_MESSAGE);
  });

  it(`上限ちょうど(${MAX_JSON_BODY_DEPTH} 段)なら、path も bodySchema も通常どおり評価される`, async () => {
    const flow = flowSchema.parse({
      name: "deep assert ok",
      steps: [
        {
          name: "fetch",
          request: { method: "GET", url: `${baseUrl}/depth/${MAX_JSON_BODY_DEPTH}` },
          assert: {
            body: [{ path: leafPath(MAX_JSON_BODY_DEPTH), equals: "LEAF" }],
            bodySchema: { type: "array" },
          },
        },
      ],
    });

    const result = await executeFlow(flow, "deep.yaml", { cwd, history: false });

    expect(result.steps[0]?.status).toBe("passed");
  });
});

describe("カセットの再生と SSE / WS の要素", () => {
  it("カセットから再生した深い JSON 応答にも bodyTooDeep が付く(浅い応答には付かない)", () => {
    const entry = (bodyText: string) => ({
      v: 1 as const,
      method: "GET",
      url: "http://x/",
      status: 200,
      headers: { "content-type": "application/json" },
      bodyText,
    });

    const deep = cassetteEntryToHttpResponse(entry(nested(MAX_JSON_BODY_DEPTH + 1)));
    const shallow = cassetteEntryToHttpResponse(entry(nested(3)));

    expect(deep.bodyTooDeep).toBe(true);
    expect(typeof deep.body).toBe("string");
    expect(shallow.bodyTooDeep).toBeUndefined();
    expect(shallow.body).toEqual([[["LEAF"]]]);
  });

  it("SSE / WS の data が深すぎる JSON のとき、path は一致せず、メッセージで理由が分かる", () => {
    const deep = nested(MAX_JSON_BODY_DEPTH + 1);

    const indexed = assertEvents([{ index: 0, path: "$[0]", exists: true }], [{ data: deep }]);
    const anyEvent = assertEvents([{ path: "$[0]", exists: true }], [{ data: deep }]);

    expect(indexed[0]?.ok).toBe(false);
    expect(indexed[0]?.message).toContain("nested deeper than");
    expect(anyEvent[0]?.ok).toBe(false);
    expect(anyEvent[0]?.message).toContain("nested deeper than");
  });
});
