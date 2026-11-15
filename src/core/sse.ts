import { createParser } from "eventsource-parser";
import { RuntimeError } from "./errors.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  type HttpRequestOptions,
  type RawHttpResponse,
  sendRawRequest,
} from "./http.js";
import type { SseOptions } from "./schema.js";
import type { SseEvent } from "./types.js";

export interface SseResult {
  status: number;
  headers: Record<string, string>;
  events: SseEvent[];
  durationMs: number;
  /** リダイレクトを追った場合の経由 URL(runner が設定する)。追わなかった場合は省略 */
  redirects?: string[];
}

/** SSE 接続(ヘッダー受信まで)を行う関数。既定は sendRawRequest。runner がリダイレクト・cookie・proxy 対応の送信を渡す */
export type SseConnector = (options: HttpRequestOptions) => Promise<RawHttpResponse>;

const DEFAULT_MAX_EVENTS = 100;
const DEFAULT_MAX_DURATION_MS = 10000;

/**
 * SSE ストリームを受信する。
 * maxEvents / maxDurationMs のいずれかに達したら打ち切って正常終了する(エラーにしない)。
 * 接続不能・打ち切り以外のストリームエラーは RuntimeError にする。
 */
export async function receiveSse(
  requestOptions: HttpRequestOptions,
  sseOptions: Partial<SseOptions> = {},
  connect: SseConnector = sendRawRequest,
): Promise<SseResult> {
  const maxEvents = sseOptions.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxDurationMs = sseOptions.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  // 受信バイト数の上限(maxDurationMs の間に大量のデータを流し込まれてもメモリを使い切らない)
  const maxBytes = requestOptions.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  let receivedBytes = 0;

  const overallStartedAt = performance.now();

  // SSE モードを示す Accept ヘッダーを付与する(ユーザー指定があればそちらを優先)
  const headers = {
    Accept: "text/event-stream",
    ...requestOptions.headers,
  };

  const raw = await connect({ ...requestOptions, headers });

  const events: SseEvent[] = [];
  const decoder = new TextDecoder();

  const parser = createParser({
    onEvent(event) {
      events.push({ event: event.event, id: event.id, data: event.data });
    },
  });

  let cutOff = false;
  const timer = setTimeout(() => {
    cutOff = true;
    raw.bodyStream.destroy();
  }, maxDurationMs);

  try {
    for await (const chunk of raw.bodyStream) {
      receivedBytes += (chunk as Buffer).length;
      if (receivedBytes > maxBytes) {
        raw.bodyStream.on("error", () => {});
        raw.bodyStream.destroy();
        throw new RuntimeError(
          `SSE stream exceeds the limit of ${maxBytes} bytes (raise http.maxResponseBytes if this is expected)`,
          "response-too-large",
        );
      }
      parser.feed(decoder.decode(chunk as Buffer, { stream: true }));
      if (events.length >= maxEvents) {
        cutOff = true;
        raw.bodyStream.destroy();
        break;
      }
    }
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    // maxDurationMs による打ち切り(destroy)由来のエラーは正常終了として扱う
    if (!cutOff) {
      throw new RuntimeError(
        `SSE stream error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    status: raw.status,
    headers: raw.headers,
    events,
    durationMs: performance.now() - overallStartedAt,
  };
}
