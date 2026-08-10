import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { receiveSse } from "../src/core/sse.js";
import { closeServer, listenEphemeral } from "./support/net.js";

interface SseEventDef {
  event?: string;
  data: string;
  id?: string;
}

/** SSE イベントを一定間隔で(必要なら無限に)送り続けるテストサーバー */
async function startSseServer(options: {
  events?: SseEventDef[];
  intervalMs: number;
  infinite?: boolean;
}) {
  const server = createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let i = 0;
    const timer = setInterval(() => {
      const events = options.events ?? [];
      const def: SseEventDef = options.infinite
        ? { data: JSON.stringify({ index: i }) }
        : (events[i] as SseEventDef);

      if (!options.infinite && i >= events.length) {
        clearInterval(timer);
        res.end();
        return;
      }

      let chunk = "";
      if (def.id) chunk += `id: ${def.id}\n`;
      if (def.event) chunk += `event: ${def.event}\n`;
      chunk += `data: ${def.data}\n\n`;
      res.write(chunk);
      i += 1;
    }, options.intervalMs);

    req.on("close", () => clearInterval(timer));
    res.on("close", () => clearInterval(timer));
  });

  const { baseUrl } = await listenEphemeral(server);
  return { server, baseUrl };
}

describe("receiveSse", () => {
  let activeServer: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    if (activeServer) {
      await closeServer(activeServer);
      activeServer = undefined;
    }
  });

  it("受信したイベントを配列で返す", async () => {
    const { server, baseUrl } = await startSseServer({
      events: [
        { event: "message", data: "1", id: "a" },
        { event: "message", data: "2", id: "b" },
        { event: "message", data: "3", id: "c" },
      ],
      intervalMs: 10,
    });
    activeServer = server;

    const result = await receiveSse(
      { method: "GET", url: baseUrl },
      { maxEvents: 100, maxDurationMs: 5000 },
    );

    expect(result.status).toBe(200);
    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.data)).toEqual(["1", "2", "3"]);
    expect(result.events[0]?.id).toBe("a");
  });

  it("maxEvents に達したら受信を打ち切る", async () => {
    const events = Array.from({ length: 10 }, (_, i) => ({ data: String(i) }));
    const { server, baseUrl } = await startSseServer({ events, intervalMs: 30 });
    activeServer = server;

    const result = await receiveSse(
      { method: "GET", url: baseUrl },
      { maxEvents: 3, maxDurationMs: 10000 },
    );

    expect(result.events.length).toBeGreaterThanOrEqual(3);
    expect(result.events.length).toBeLessThan(10);
  }, 10000);

  it("maxDurationMs に達したら受信を打ち切る(サーバーが送信し続けても正常終了する)", async () => {
    const { server, baseUrl } = await startSseServer({ intervalMs: 300, infinite: true });
    activeServer = server;

    const startedAt = Date.now();
    const result = await receiveSse(
      { method: "GET", url: baseUrl },
      { maxEvents: 1000, maxDurationMs: 120 },
    );
    const elapsed = Date.now() - startedAt;

    // サーバーは 300ms 間隔で送り続けるが、120ms で打ち切られるためすぐ返るはず
    expect(elapsed).toBeLessThan(1000);
    expect(result.events.length).toBeLessThan(3);
  }, 5000);
});
