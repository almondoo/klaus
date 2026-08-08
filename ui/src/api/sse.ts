import { createParser } from "eventsource-parser";
import { ApiError } from "./http";
import { getToken } from "./token";
import type {
  RunRequestBody,
  RunResultPayload,
  StepResultPayload,
  StepStartPayload,
} from "./types";

export interface RunStreamCallbacks {
  onStepStart?: (payload: StepStartPayload) => void;
  onStepResult?: (payload: StepResultPayload) => void;
  onRunResult?: (payload: RunResultPayload) => void;
}

/**
 * ReadableStream を eventsource-parser で読み進め、イベント種別ごとに callbacks へ振り分ける。
 * fetch から切り離してあるので、テストではモックの ReadableStream を直接渡せる。
 */
export async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  callbacks: RunStreamCallbacks,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  const parser = createParser({
    onEvent(event) {
      if (!event.data) return;
      switch (event.event) {
        case "step-start":
          callbacks.onStepStart?.(JSON.parse(event.data) as StepStartPayload);
          break;
        case "step-result":
          callbacks.onStepResult?.(JSON.parse(event.data) as StepResultPayload);
          break;
        case "run-result":
          callbacks.onRunResult?.(JSON.parse(event.data) as RunResultPayload);
          break;
        default:
          // 未知の event 種別は無視する(将来の拡張に対して寛容にする)
          break;
      }
    },
  });

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }
}

/** POST /api/runs を実行し、SSE ストリームをライブで callbacks に配信する */
export async function streamRun(
  body: RunRequestBody,
  callbacks: RunStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const token = getToken();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("X-Klaus-Token", token);

  const response = await fetch("/api/runs", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok || !response.body) {
    const message = await response.text().catch(() => response.statusText);
    throw new ApiError(response.status, message || `Request failed: ${response.status}`);
  }

  await parseSseStream(response.body, callbacks);
}
