import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer as createNetServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RuntimeError } from "../src/core/errors.js";
import { sendRequest } from "../src/core/http.js";
import { closeServer, listenEphemeral } from "./support/net.js";

async function startServer() {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf-8");

      if (req.url === "/json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, method: req.method }));
        return;
      }
      if (req.url === "/text") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("plain text body");
        return;
      }
      if (req.url === "/echo") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            receivedContentType: req.headers["content-type"] ?? null,
            receivedBody: bodyText,
          }),
        );
        return;
      }
      if (req.url === "/broken-json") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{not valid json");
        return;
      }
      if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }, 500);
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  const { port, baseUrl } = await listenEphemeral(server);
  return { server, port, baseUrl };
}

describe("sendRequest", () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await closeServer(ctx.server);
  });

  it("content-type が JSON ならパースして body に入れる", async () => {
    const response = await sendRequest({ method: "GET", url: `${ctx.baseUrl}/json` });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, method: "GET" });
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("content-type が JSON でなければテキストのまま返す", async () => {
    const response = await sendRequest({ method: "GET", url: `${ctx.baseUrl}/text` });
    expect(response.body).toBe("plain text body");
    expect(response.bodyText).toBe("plain text body");
  });

  it("body が object のとき Content-Type 未指定なら application/json を自動付与する", async () => {
    const response = await sendRequest({
      method: "POST",
      url: `${ctx.baseUrl}/echo`,
      body: { hello: "world" },
    });
    const parsed = response.body as { receivedContentType: string; receivedBody: string };
    expect(parsed.receivedContentType).toContain("application/json");
    expect(JSON.parse(parsed.receivedBody)).toEqual({ hello: "world" });
  });

  it("content-type が JSON でもボディが壊れている場合はテキストのまま返す", async () => {
    const response = await sendRequest({ method: "GET", url: `${ctx.baseUrl}/broken-json` });
    expect(response.body).toBe("{not valid json");
    expect(response.bodyText).toBe("{not valid json");
  });

  it("body が string ならそのまま送信する", async () => {
    const response = await sendRequest({
      method: "POST",
      url: `${ctx.baseUrl}/echo`,
      headers: { "Content-Type": "text/plain" },
      body: "raw text",
    });
    const parsed = response.body as { receivedContentType: string; receivedBody: string };
    expect(parsed.receivedContentType).toBe("text/plain");
    expect(parsed.receivedBody).toBe("raw text");
  });

  it("タイムアウトすると RuntimeError になる", async () => {
    await expect(
      sendRequest({ method: "GET", url: `${ctx.baseUrl}/slow`, timeoutMs: 50 }),
    ).rejects.toThrow(RuntimeError);
  });

  it("接続不能なら RuntimeError になる", async () => {
    const unusedServer = await startServer();
    const deadPort = unusedServer.port;
    await closeServer(unusedServer.server);

    await expect(
      sendRequest({ method: "GET", url: `http://127.0.0.1:${deadPort}/json`, timeoutMs: 2000 }),
    ).rejects.toThrow(RuntimeError);
  });
});

describe("sendRequest: 重複 Content-Type ヘッダー", () => {
  // node:http の res.setHeader は Content-Type の重複を配列化してくれない(coalesce される)ため、
  // node:net の生ソケットでリテラルな HTTP レスポンスバイト列を書き、undici に
  // headers["content-type"] を string[] として渡させる(実サーバーの多重ヘッダーを再現する)。
  it("Content-Type が重複して配列になる場合は JSON パースせずテキストのまま返す", async () => {
    const bodyText = JSON.stringify({ ok: true });
    const server = createNetServer((socket) => {
      socket.once("data", () => {
        const raw =
          "HTTP/1.1 200 OK\r\n" +
          "Content-Type: application/json\r\n" +
          "Content-Type: text/plain\r\n" +
          `Content-Length: ${Buffer.byteLength(bodyText)}\r\n` +
          "Connection: close\r\n" +
          "\r\n" +
          bodyText;
        socket.end(raw);
      });
    });
    // listenEphemeral は node:http の Server 型を前提とするため、node:net の生ソケットには使えない。
    // ここだけ listen(0, ...) から port を取り出す処理を直接書く。
    const { baseUrl } = await new Promise<{ port: number; baseUrl: string }>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        resolve({ port, baseUrl: `http://127.0.0.1:${port}` });
      });
    });

    try {
      const response = await sendRequest({ method: "GET", url: `${baseUrl}/` });
      expect(typeof response.body).toBe("string");
      expect(response.body).toBe(bodyText);
      expect(response.bodyText).toBe(bodyText);
    } finally {
      await closeServer(server);
    }
  });
});
