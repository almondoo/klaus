import { createParser } from "eventsource-parser";
import { ApiError, apiFetch } from "./http";

export interface HistoryEventCallbacks {
  /** 接続が確立し、サーバー側の監視基準が確定したとき */
  onReady: () => void;
  /** 履歴ファイルに変化があったとき(中身は含まれない。取り直しは呼び出し側) */
  onChange: (change: { seq: number; dates: string[] }) => void;
}

/**
 * GET /api/history/events を購読する。EventSource はカスタムヘッダー(X-Klaus-Token)を送れないため
 * fetch + ストリーム読み取りで実装する。ストリームが終了するか abort されると resolve し、
 * 接続エラー・非 2xx は reject する(再接続は呼び出し側)。
 */
export async function streamHistoryEvents(
  callbacks: HistoryEventCallbacks,
  signal: AbortSignal,
): Promise<void> {
  const response = await apiFetch("/api/history/events", { signal });
  if (!response.ok || !response.body) {
    throw new ApiError(response.status, `Request failed: ${response.status}`);
  }

  const parser = createParser({
    onEvent(event) {
      if (event.event === "ready") callbacks.onReady();
      else if (event.event === "history" && event.data) {
        callbacks.onChange(JSON.parse(event.data) as { seq: number; dates: string[] });
      }
    },
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }
}
