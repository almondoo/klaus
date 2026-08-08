import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeFlow } from "../src/core/runner.js";
import { flowSchema } from "../src/core/schema.js";

/**
 * graphql リクエストを受け取り、実際に受信した method / Content-Type / body をそのまま返すテストサーバー。
 * GET /seed はテンプレート展開の元になる値を返す。
 */
function startGraphqlServer() {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/seed") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ userId: "u1", userName: "Alice" }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf-8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          receivedMethod: req.method,
          receivedContentType: req.headers["content-type"] ?? null,
          receivedBody: JSON.parse(bodyText || "{}"),
        }),
      );
    });
  });

  return new Promise<{ server: ReturnType<typeof createServer>; baseUrl: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

interface EchoResponseBody {
  receivedMethod: string;
  receivedContentType: string | null;
  receivedBody: { query: string; variables?: unknown };
}

describe("graphql request", () => {
  let ctx: Awaited<ReturnType<typeof startGraphqlServer>>;

  beforeAll(async () => {
    ctx = await startGraphqlServer();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  });

  it("method 未指定なら POST、Content-Type 未指定なら application/json、body は { query, variables } になる", async () => {
    const flow = flowSchema.parse({
      name: "graphql flow",
      steps: [
        {
          name: "query",
          request: {
            url: ctx.baseUrl,
            graphql: {
              query: "query { me { id } }",
              variables: { id: 1 },
            },
          },
          assert: { status: 200 },
        },
      ],
    });

    const result = await executeFlow(flow, "graphql-flow.yaml", { history: false });

    expect(result.status).toBe("passed");
    const body = result.steps[0]?.response?.body as EchoResponseBody;
    expect(body.receivedMethod).toBe("POST");
    expect(body.receivedContentType).toContain("application/json");
    expect(body.receivedBody).toEqual({ query: "query { me { id } }", variables: { id: 1 } });
  });

  it("query / variables の文字列値はテンプレート展開される(前ステップの capture を参照できる)", async () => {
    const flow = flowSchema.parse({
      name: "graphql template flow",
      steps: [
        {
          name: "seed",
          request: { method: "GET", url: `${ctx.baseUrl}/seed` },
          capture: { userId: "$.userId", userName: "$.userName" },
          assert: { status: 200 },
        },
        {
          name: "query",
          request: {
            url: ctx.baseUrl,
            graphql: {
              query: 'query { user(id: "{{userId}}") { id } }',
              variables: { name: "{{userName}}" },
            },
          },
          assert: { status: 200 },
        },
      ],
    });

    const result = await executeFlow(flow, "graphql-template-flow.yaml", { history: false });

    expect(result.status).toBe("passed");
    const body = result.steps[1]?.response?.body as EchoResponseBody;
    expect(body.receivedBody.query).toBe('query { user(id: "u1") { id } }');
    expect(body.receivedBody.variables).toEqual({ name: "Alice" });
  });
});
