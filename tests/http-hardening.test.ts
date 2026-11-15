import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryEntry } from "../src/core/history.js";
import { executeFlow } from "../src/core/runner.js";
import { flowSchema } from "../src/core/schema.js";
import { closeServer, listenEphemeral } from "./support/net.js";

interface Fixture {
  server: Server;
  port: number;
  baseUrl: string;
  requests: { url: string; headers: IncomingMessage["headers"]; body: string }[];
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await closeServer(server);
});

async function startHttp(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Fixture> {
  const requests: Fixture["requests"] = [];
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      handler(req, res);
    });
  });
  servers.push(server);
  const { port, baseUrl } = await listenEphemeral(server);
  return { server, port, baseUrl, requests };
}

const flowOf = (steps: unknown[], http?: unknown) =>
  flowSchema.parse({ name: "f", ...(http ? { http } : {}), steps });

async function run(
  flow: ReturnType<typeof flowOf>,
  options: Parameters<typeof executeFlow>[2] = {},
) {
  const entries: HistoryEntry[] = [];
  const result = await executeFlow(flow, "flow.yaml", {
    history: (entry) => {
      entries.push(entry);
    },
    ...options,
  });
  return { result, entries };
}

const get = (url: string, extra: Record<string, unknown> = {}, name = "s") => ({
  name,
  request: { method: "GET", url, ...extra },
});

describe("別オリジンへのリダイレクトは内容交渉のヘッダーだけを転送する(許可リスト方式)", () => {
  it("capture したセッショントークンを独自ヘッダーで送っても、別オリジンへは転送しない", async () => {
    const other = await startHttp((_req, res) => res.end("other"));
    const origin = await startHttp((req, res) => {
      if (req.url === "/login") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ session: "captured-session-token-777" }));
        return;
      }
      res.writeHead(302, { Location: `${other.baseUrl}/landing` });
      res.end();
    });
    const { result, entries } = await run(
      flowOf(
        [
          { ...get(`${origin.baseUrl}/login`, {}, "login"), capture: { tok: "$.session" } },
          get(
            `${origin.baseUrl}/go`,
            {
              headers: {
                "X-Session": "{{tok}}",
                "X-Anything": "harmless",
                Accept: "application/json",
                "Accept-Encoding": "identity",
              },
            },
            "go",
          ),
        ],
        { followRedirects: true },
      ),
    );
    expect(result.steps[1]?.status).toBe("passed");
    const landed = other.requests[0];
    expect(landed?.headers["x-session"]).toBeUndefined();
    expect(landed?.headers["x-anything"]).toBeUndefined();
    expect(landed?.headers.accept).toBe("application/json");
    expect(landed?.headers["accept-encoding"]).toBe("identity");
    expect(result.steps[1]?.droppedHeaders).toEqual([
      { hop: 1, headers: ["X-Session", "X-Anything"] },
    ]);
    expect(entries[1]?.droppedHeaders).toEqual(result.steps[1]?.droppedHeaders);
  });

  it("同一オリジンでは独自ヘッダーも含めてすべて保つ", async () => {
    const origin = await startHttp((req, res) => {
      if (req.url === "/go") {
        res.writeHead(302, { Location: "/landing" });
        res.end();
        return;
      }
      res.end("landed");
    });
    const { result } = await run(
      flowOf([get(`${origin.baseUrl}/go`, { headers: { "X-Session": "keep-me" } })], {
        followRedirects: true,
      }),
    );
    expect(origin.requests.find((r) => r.url === "/landing")?.headers["x-session"]).toBe("keep-me");
    expect(result.steps[0]?.droppedHeaders).toBeUndefined();
  });

  it("ボディを保つ 307 では content-type を転送し、GET に変わる 302 では転送しない", async () => {
    const other = await startHttp((_req, res) => res.end("other"));
    const origin = await startHttp((req, res) => {
      res.writeHead(req.url === "/keep" ? 307 : 302, { Location: `${other.baseUrl}/landing` });
      res.end();
    });
    const post = (path: string, name: string) => ({
      name,
      request: {
        method: "POST",
        url: `${origin.baseUrl}${path}`,
        headers: { "Content-Type": "text/plain", "X-Id": "1" },
        body: "payload",
      },
    });
    const { result } = await run(
      flowOf([post("/keep", "keep"), post("/drop", "drop")], { followRedirects: true }),
    );
    expect(other.requests[0]?.headers["content-type"]).toBe("text/plain");
    expect(other.requests[0]?.body).toBe("payload");
    expect(other.requests[1]?.headers["content-type"]).toBeUndefined();
    expect(other.requests[1]?.body).toBe("");
    expect(result.steps[0]?.droppedHeaders).toEqual([{ hop: 1, headers: ["X-Id"] }]);
  });
});

describe("Host ヘッダー", () => {
  it("guard.allowedHosts があるとき、URL と違う Host は拒否して履歴に残す(送信しない)", async () => {
    const target = await startHttp((_req, res) => res.end("ok"));
    const { result, entries } = await run(
      flowOf([get(`${target.baseUrl}/x`, { headers: { Host: "evil.internal" } })]),
      { guard: { allowedHosts: [`127.0.0.1:${target.port}`] } },
    );
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("Host header that differs");
    expect(entries[0]?.status).toBe("error");
    expect(target.requests).toHaveLength(0);
  });

  it("URL と同じ Host(大文字小文字・ポート表記は問わない)は許可リストがあっても通る", async () => {
    const target = await startHttp((_req, res) => res.end("ok"));
    const { result } = await run(
      flowOf([get(`${target.baseUrl}/x`, { headers: { host: `127.0.0.1:${target.port}` } })]),
      { guard: { allowedHosts: [`127.0.0.1:${target.port}`] } },
    );
    expect(result.steps[0]?.status).toBe("passed");
    expect(target.requests[0]?.headers.host).toBe(`127.0.0.1:${target.port}`);
  });

  it("許可リストも proxy も無いときは従来どおり Host をそのまま送る", async () => {
    const target = await startHttp((_req, res) => res.end("ok"));
    const { result } = await run(
      flowOf([get(`${target.baseUrl}/x`, { headers: { Host: "virtual.example" } })]),
    );
    expect(result.steps[0]?.status).toBe("passed");
    expect(target.requests[0]?.headers.host).toBe("virtual.example");
  });

  describe("proxy 設定時", () => {
    async function startProxy() {
      const forwarded: { url: string; headers: IncomingMessage["headers"] }[] = [];
      const server = createHttpServer((req, res) => {
        forwarded.push({ url: req.url ?? "", headers: req.headers });
        res.end("via-proxy");
      });
      server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
        const [host, port] = (req.url ?? "").split(":");
        const upstream = netConnect(Number(port), host, () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => upstream.destroy());
      });
      servers.push(server);
      const { url } = { url: (await listenEphemeral(server)).baseUrl };
      return { forwarded, url };
    }

    it("URL と違う Host は(許可リストが無くても)拒否し、proxy へは何も送らない", async () => {
      const proxy = await startProxy();
      const target = await startHttp((_req, res) => res.end("direct"));
      const { result, entries } = await run(
        flowOf([get(`${target.baseUrl}/x`, { headers: { Host: "evil.internal" } })]),
        { http: { proxy: proxy.url } },
      );
      expect(result.steps[0]?.status).toBe("error");
      expect(result.steps[0]?.error).toContain("Host header that differs");
      expect(entries[0]?.status).toBe("error");
      expect(proxy.forwarded).toHaveLength(0);
    });

    it("URL と同じ Host は通る", async () => {
      const proxy = await startProxy();
      const target = await startHttp((_req, res) => res.end("direct"));
      const { result } = await run(
        flowOf([get(`${target.baseUrl}/x`, { headers: { Host: `127.0.0.1:${target.port}` } })]),
        { http: { proxy: proxy.url } },
      );
      expect(result.steps[0]?.status).toBe("passed");
      expect(proxy.forwarded).toHaveLength(1);
    });

    it.each(["Connection", "Keep-Alive", "TE", "Trailer", "Upgrade", "Transfer-Encoding"])(
      "ホップ間ヘッダー %s は拒否する",
      async (name) => {
        const proxy = await startProxy();
        const target = await startHttp((_req, res) => res.end("direct"));
        const { result } = await run(
          flowOf([get(`${target.baseUrl}/x`, { headers: { [name]: "x" } })]),
          { http: { proxy: proxy.url } },
        );
        expect(result.steps[0]?.status).toBe("error");
        expect(result.steps[0]?.error).toContain("hop-by-hop");
        expect(proxy.forwarded).toHaveLength(0);
      },
    );

    it("proxy が無ければホップ間ヘッダーの扱いは変えない(Host も含めて拒否しない)", async () => {
      const target = await startHttp((_req, res) => res.end("direct"));
      const { result } = await run(
        flowOf([get(`${target.baseUrl}/x`, { headers: { Host: "virtual.example" } })]),
      );
      expect(result.steps[0]?.status).toBe("passed");
    });
  });
});

describe("リダイレクトの Location の形式", () => {
  const redirectingTo = async (location: (selfPort: number) => string) => {
    const self: { port: number } = { port: 0 };
    const origin = await startHttp((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: location(self.port) });
        res.end();
        return;
      }
      res.end("landed");
    });
    self.port = origin.port;
    return origin;
  };

  it("userinfo つきの Location は辿らない(認証情報を URL として記録しない)", async () => {
    const origin = await redirectingTo(
      (port) => `http://user:pass-secret@127.0.0.1:${port}/landing`,
    );
    const { result, entries } = await run(
      flowOf([get(`${origin.baseUrl}/start`)], { followRedirects: true }),
    );
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("containing credentials");
    expect(JSON.stringify({ result, entries })).not.toContain("pass-secret");
    expect(origin.requests.map((r) => r.url)).toEqual(["/start"]);
  });

  it("フラグメントは送らず、記録する URL にも残さない", async () => {
    const origin = await redirectingTo(() => "/landing#frag-secret");
    const { result } = await run(
      flowOf([get(`${origin.baseUrl}/start`)], { followRedirects: true }),
    );
    expect(result.steps[0]?.status).toBe("passed");
    expect(result.steps[0]?.redirects).toEqual([`${origin.baseUrl}/landing`]);
    expect(JSON.stringify(result)).not.toContain("frag-secret");
  });

  it.each([
    ["プロトコル相対", (port: number) => `//localhost:${port}/landing`],
    ["バックスラッシュ", (port: number) => `\\\\localhost:${port}\\landing`],
    ["スキーム省略のバックスラッシュ混在", (port: number) => `/\\localhost:${port}/landing`],
  ])(
    "%s の Location も解決後のホストで許可リストを判定する(許可外なら拒否)",
    async (_n, location) => {
      const origin = await redirectingTo(location);
      const { result, entries } = await run(
        flowOf([get(`${origin.baseUrl}/start`)], { followRedirects: true }),
        { guard: { allowedHosts: [`127.0.0.1:${origin.port}`] } },
      );
      expect(result.steps[0]?.status).toBe("error");
      expect(result.steps[0]?.error).toContain("redirect hop 1");
      expect(entries[0]?.status).toBe("error");
      expect(origin.requests.map((r) => r.url)).toEqual(["/start"]);
    },
  );

  it("プロトコル相対の Location が許可されたホストなら辿る", async () => {
    const origin = await redirectingTo((port) => `//127.0.0.1:${port}/landing`);
    const { result } = await run(
      flowOf([get(`${origin.baseUrl}/start`)], { followRedirects: true }),
      { guard: { allowedHosts: [`127.0.0.1:${origin.port}`] } },
    );
    expect(result.steps[0]?.status).toBe("passed");
    expect(result.steps[0]?.redirects).toEqual([`${origin.baseUrl}/landing`]);
  });
});

describe("レスポンスサイズの上限(http.maxResponseBytes)", () => {
  it("上限を超えるボディは読み切らず、明確なメッセージで step を error にする(Content-Length あり・なし)", async () => {
    const big = "x".repeat(5000);
    const withLength = await startHttp((_req, res) => {
      res.writeHead(200, { "Content-Length": String(big.length) });
      res.end(big);
    });
    const chunked = await startHttp((_req, res) => {
      res.writeHead(200);
      res.write(big.slice(0, 2500));
      setTimeout(() => res.end(big.slice(2500)), 10);
    });
    for (const server of [withLength, chunked]) {
      const { result } = await run(flowOf([get(`${server.baseUrl}/`)], { maxResponseBytes: 1000 }));
      expect(result.steps[0]?.status).toBe("error");
      expect(result.steps[0]?.error).toBe(
        "response body exceeds the limit of 1000 bytes (raise http.maxResponseBytes if this is expected)",
      );
    }
  });

  it("上限以内なら通常どおり読める。config 側の値は run オプションの http から渡る", async () => {
    const server = await startHttp((_req, res) => res.end("small"));
    const flowRun = await run(flowOf([get(`${server.baseUrl}/`)], { maxResponseBytes: 1000 }));
    expect(flowRun.result.steps[0]?.response?.body).toBe("small");
    const viaConfig = await run(flowOf([get(`${server.baseUrl}/`)]), {
      http: { maxResponseBytes: 3 },
    });
    expect(viaConfig.result.steps[0]?.status).toBe("error");
  });

  it("SSE のストリームにも同じ上限がかかる", async () => {
    const server = await startHttp((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${"y".repeat(4000)}\n\n`);
      setTimeout(() => res.end(), 50);
    });
    const { result } = await run(
      flowOf(
        [
          {
            name: "sse",
            request: { method: "GET", url: `${server.baseUrl}/` },
            sse: { maxEvents: 5, maxDurationMs: 1000 },
          },
        ],
        { maxResponseBytes: 1000 },
      ),
    );
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("SSE stream exceeds the limit of 1000 bytes");
  });
});
