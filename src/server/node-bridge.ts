/**
 * Hono の fetch ハンドラ(app.fetch)を node:http にブリッジする薄い層。
 * @hono/node-server は導入しない方針のため、Node 20 のグローバル fetch API
 * (Request/Response/Headers/ReadableStream)を使って自前で変換する。
 * SSE の逐次書き込みに対応するため、レスポンスボディはストリームのまま node:http に書き出す。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Hono } from "hono";

/** node:http の IncomingMessage を Web 標準の Request に変換する */
function toWebRequest(req: IncomingMessage, fallbackHost: string): Request {
  const host = req.headers.host ?? fallbackHost;
  const url = `http://${host}${req.url ?? "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.append(key, value);
    }
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    // IncomingMessage は非同期イテラブルな Node Readable なので、そのまま body として渡せる
    // (Web 標準の fetch 実装は stream body に対して duplex: "half" を要求する)
    body: hasBody ? (req as unknown as ReadableStream<Uint8Array>) : undefined,
    duplex: hasBody ? "half" : undefined,
  } as RequestInit);
}

/** Web 標準の Response を node:http の ServerResponse へストリーミングしながら書き出す */
async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return; // 個別処理する(複数件になり得るため)
    headers[key] = value;
  });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) headers["set-cookie"] = setCookie;

  res.writeHead(response.status, headers);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // SSE のような長時間ストリームでは backpressure を尊重して drain を待つが、
      // destroyed な ServerResponse では 'drain' が発火せず永久に待ってしまうため、
      // クライアント切断を示す 'close'/'error' と race させて切断を検知する
      if (!res.write(value)) {
        const disconnected = await waitForDrainOrDisconnect(res);
        if (disconnected) {
          // reader を cancel して上流(Hono の TransformStream)に切断を伝播させる。
          // これにより詰まっていた stream.writeSSE 側の書き込みも解放される
          await reader.cancel(new Error("client disconnected")).catch(() => {});
          break;
        }
      }
    }
  } finally {
    // すでに切断済みのレスポンスに対して end() を呼ぶと例外になり得るため、状態を確認してから呼ぶ
    if (!res.writableEnded && !res.destroyed) {
      res.end();
    }
  }
}

/**
 * res.write() が false(backpressure)を返した際に使う待機ヘルパー。
 * 'drain'(通常の再開)と 'close'/'error'(クライアント切断)を race させ、
 * 切断が先に発生した場合は true を返す。
 * どちらが先に発火しても once() のリスナーを確実に解放するため、リークや
 * MaxListenersExceededWarning は発生しない。
 */
function waitForDrainOrDisconnect(res: ServerResponse): Promise<boolean> {
  // 待ち始めた時点ですでに切断済みなら即座に切断扱いにする
  if (res.destroyed || res.writableEnded) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onDisconnect);
      res.off("error", onDisconnect);
    };
    const onDrain = () => {
      cleanup();
      resolve(false);
    };
    const onDisconnect = () => {
      cleanup();
      resolve(true);
    };
    res.once("drain", onDrain);
    res.once("close", onDisconnect);
    res.once("error", onDisconnect);
  });
}

/** Hono アプリの app.fetch を node:http のリクエストハンドラとして使えるようブリッジする */
export function bridgeHonoApp(
  app: Hono,
  fallbackHost: string,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const request = toWebRequest(req, fallbackHost);
      const response = await app.fetch(request);
      await writeWebResponse(res, response);
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end(`klaus server error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
