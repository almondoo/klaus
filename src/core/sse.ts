import { createParser } from "eventsource-parser";
import { RuntimeError } from "./errors.js";
import { type HttpRequestOptions, sendRawRequest } from "./http.js";
import type { SseOptions } from "./schema.js";
import type { SseEvent } from "./types.js";

export interface SseResult {
  status: number;
  headers: Record<string, string>;
  events: SseEvent[];
  durationMs: number;
}

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
): Promise<SseResult> {
  const maxEvents = sseOptions.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxDurationMs = sseOptions.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;

  const overallStartedAt = performance.now();

  // SSE モードを示す Accept ヘッダーを付与する(ユーザー指定があればそちらを優先)
  const headers = {
    Accept: "text/event-stream",
    ...requestOptions.headers,
  };

  const raw = await sendRawRequest({ ...requestOptions, headers });

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
      parser.feed(decoder.decode(chunk as Buffer, { stream: true }));
      if (events.length >= maxEvents) {
        cutOff = true;
        raw.bodyStream.destroy();
        break;
      }
    }
  } catch (error) {
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
