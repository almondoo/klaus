import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { RuntimeError } from "../src/core/errors.js";
import { connectWebSocket } from "../src/core/ws.js";

/** 受信したメッセージをそのまま送り返すエコーサーバー */
function startEchoWsServer() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      socket.send(data.toString());
    });
  });
  return new Promise<{ wss: WebSocketServer; url: string }>((resolve) => {
    wss.once("listening", () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ wss, url: `ws://127.0.0.1:${port}` });
    });
  });
}

/** 接続後、一定間隔でメッセージを送り続ける(無限)サーバー */
function startTickingWsServer(intervalMs: number) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (socket) => {
    let i = 0;
    const timer = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ index: i }));
        i += 1;
      }
    }, intervalMs);
    socket.on("close", () => clearInterval(timer));
  });
  return new Promise<{ wss: WebSocketServer; url: string }>((resolve) => {
    wss.once("listening", () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ wss, url: `ws://127.0.0.1:${port}` });
    });
  });
}

describe("connectWebSocket", () => {
  let activeWss: WebSocketServer | undefined;

  afterEach(async () => {
    if (activeWss) {
      await new Promise<void>((resolve) => activeWss?.close(() => resolve()));
      activeWss = undefined;
    }
  });

  it("send したメッセージのエコーを受信する", async () => {
    const { wss, url } = await startEchoWsServer();
    activeWss = wss;

    const result = await connectWebSocket({
      url,
      send: ["hello", { foo: "bar" }],
      maxMessages: 2,
      maxDurationMs: 5000,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.data).toBe("hello");
    expect(result.messages[1]?.data).toBe(JSON.stringify({ foo: "bar" }));
  });

  it("maxMessages に達したら受信を打ち切る", async () => {
    const { wss, url } = await startTickingWsServer(20);
    activeWss = wss;

    const result = await connectWebSocket({ url, maxMessages: 3, maxDurationMs: 10000 });

    expect(result.messages).toHaveLength(3);
  }, 10000);

  it("maxDurationMs に達したら受信を打ち切る(サーバーが送信し続けても正常終了する)", async () => {
    const { wss, url } = await startTickingWsServer(300);
    activeWss = wss;

    const startedAt = Date.now();
    const result = await connectWebSocket({ url, maxMessages: 1000, maxDurationMs: 120 });
    const elapsed = Date.now() - startedAt;

    // サーバーは 300ms 間隔で送り続けるが、120ms で打ち切られるためすぐ返るはず
    expect(elapsed).toBeLessThan(1000);
    expect(result.messages.length).toBeLessThan(3);
  }, 5000);

  it("send アイテムの JSON.stringify が失敗すると RuntimeError で reject し、ソケットも速やかに close される", async () => {
    const { wss, url } = await startEchoWsServer();
    activeWss = wss;

    // サーバー側でソケットの close を検知するための Promise
    const serverSocketClosed = new Promise<void>((resolve) => {
      wss.on("connection", (socket) => {
        socket.on("close", () => resolve());
      });
    });

    // JSON.stringify(item) で toJSON が呼ばれ、そこで例外を投げる
    const badItem = {
      toJSON(): never {
        throw new Error("boom");
      },
    };

    await expect(connectWebSocket({ url, send: [badItem], maxDurationMs: 5000 })).rejects.toThrow(
      RuntimeError,
    );

    // maxDurationMs(5000ms)を待たずに close されることを確認する(バグ時は 5000ms まで開きっぱなしになる)
    const raceResult = await Promise.race([
      serverSocketClosed.then(() => "closed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1000)),
    ]);
    expect(raceResult).toBe("closed");
  }, 8000);

  it("接続不能なら RuntimeError になる", async () => {
    // 誰も listen していない、確実に接続不能なポートを1つ確保する
    const portServer = createServer();
    await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    const closedPort = (portServer.address() as AddressInfo).port;
    await new Promise<void>((resolve) => portServer.close(() => resolve()));

    await expect(
      connectWebSocket({ url: `ws://127.0.0.1:${closedPort}`, maxDurationMs: 3000 }),
    ).rejects.toThrow(RuntimeError);
  });
});
