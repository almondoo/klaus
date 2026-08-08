import { WebSocket } from "undici";
import { RuntimeError } from "./errors.js";
import type { WsMessage } from "./types.js";

/** WS 接続オプション。url / headers / send はすでにテンプレート展開済みの値を渡す */
export interface WsConnectOptions {
  url: string;
  headers?: Record<string, string>;
  /** 接続後に順次送信するメッセージ。文字列はそのまま、それ以外は JSON.stringify して送信する */
  send?: unknown[];
  maxMessages?: number;
  maxDurationMs?: number;
}

export interface WsConnectResult {
  messages: WsMessage[];
  durationMs: number;
}

const DEFAULT_MAX_MESSAGES = 100;
const DEFAULT_MAX_DURATION_MS = 10000;

/**
 * WebSocket に接続し、send を順次送信したのち受信メッセージを蓄積する。
 * maxMessages / maxDurationMs のいずれかに達したら close() して正常終了する(エラーにしない)。
 * 接続失敗・(打ち切りによらない)異常切断は RuntimeError にする。
 * HTTP レイヤーの再実装を避けるため undici の WebSocket 実装をそのまま使う。
 */
export async function connectWebSocket(options: WsConnectOptions): Promise<WsConnectResult> {
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const startedAt = performance.now();

  const socket = new WebSocket(options.url, { headers: options.headers });
  const messages: WsMessage[] = [];

  return await new Promise<WsConnectResult>((resolve, reject) => {
    let settled = false;
    let opened = false;
    // maxMessages / maxDurationMs による意図的な打ち切りかどうか(true なら close は正常終了扱い)
    let cutOff = false;

    const durationTimer = setTimeout(() => {
      cutOff = true;
      socket.close();
    }, maxDurationMs);

    // finish/fail どちらの終了経路でもタイマー解除とソケットの後始末を必ず行う(1箇所に集約する)
    const cleanup = () => {
      clearTimeout(durationTimer);
      // OPEN/CONNECTING のまま放置すると maxDurationMs まで接続がリークし続けるため、
      // 未クローズなら明示的に close する
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ messages, durationMs: performance.now() - startedAt });
    };

    const fail = (error: RuntimeError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    socket.addEventListener("open", () => {
      opened = true;
      try {
        for (const item of options.send ?? []) {
          socket.send(typeof item === "string" ? item : JSON.stringify(item));
        }
      } catch (error) {
        fail(
          new RuntimeError(
            `WebSocket send failed: ${options.url}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });

    socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : String(event.data);
      messages.push({ data });
      if (messages.length >= maxMessages) {
        cutOff = true;
        socket.close();
      }
    });

    socket.addEventListener("error", () => {
      fail(new RuntimeError(`WebSocket connection error: ${options.url}`));
    });

    socket.addEventListener("close", (event) => {
      if (cutOff && opened) {
        // 受信中(接続確立後)に自分から打ち切った close は正常終了
        finish();
        return;
      }
      if (cutOff && !opened) {
        // 接続が確立する前に maxDurationMs に達した
        fail(new RuntimeError(`WebSocket did not open within ${maxDurationMs}ms: ${options.url}`));
        return;
      }
      if (event.wasClean) {
        // 相手側からの正常な close(サーバー側が能動的に会話を終える等)
        finish();
        return;
      }
      fail(
        new RuntimeError(
          `WebSocket closed abnormally (code ${event.code}${
            event.reason ? `: ${event.reason}` : ""
          }): ${options.url}`,
        ),
      );
    });
  });
}
