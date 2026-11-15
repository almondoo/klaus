import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { streamHistoryEvents } from "@/api/historyEvents";
import { ApiError } from "@/api/http";
import { refreshHistoryQueries } from "@/api/queries";
import { backoffDelay, isLocalRunEcho, nextNewRunCount } from "@/utils/historyEvents";

export interface UseHistoryEventsOptions {
  /** 履歴タブを表示中か(表示中は「新着」を数えない) */
  viewingHistory: boolean;
  /** UI 自身の実行(フロー実行・単発リクエスト)が進行中か。その通知を「新着」に数えないために使う */
  localRunActive: boolean;
}

export interface UseHistoryEventsResult {
  /** 履歴タブ以外を表示している間に届いた、外部由来の更新通知の件数 */
  newRunCount: number;
}

/**
 * 履歴の変更通知(SSE)を購読し、受信のたびに履歴クエリを取り直す。App で 1 回だけ使う。
 * - 切断時は指数バックオフで再接続し、再接続時は取りこぼし分を取り直す
 * - タブが非表示の間は切断し、復帰時に再接続して 1 回だけ取り直す
 */
export function useHistoryEvents(options: UseHistoryEventsOptions): UseHistoryEventsResult {
  const queryClient = useQueryClient();
  const [newRunCount, setNewRunCount] = useState(0);

  // 購読の effect を作り直さずに最新の値を参照するための ref
  const viewingRef = useRef(options.viewingHistory);
  const localActiveRef = useRef(options.localRunActive);
  const lastLocalChangeRef = useRef(Number.NEGATIVE_INFINITY);
  viewingRef.current = options.viewingHistory;

  useEffect(() => {
    // 実行の開始・終了のどちらの時点も記録し、終了後も猶予の間は自分の通知として扱う
    localActiveRef.current = options.localRunActive;
    lastLocalChangeRef.current = Date.now();
  }, [options.localRunActive]);

  useEffect(() => {
    if (options.viewingHistory) setNewRunCount(0);
  }, [options.viewingHistory]);

  const refresh = useCallback(() => {
    void refreshHistoryQueries(queryClient);
  }, [queryClient]);

  useEffect(() => {
    // モック(開発用)にはサーバーが無い
    if (import.meta.env.VITE_KLAUS_MOCK === "1") return;

    let stopped = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    // 再接続・タブ復帰後は、切れていた間の変更を ready 時に 1 回取り直す
    let resyncOnReady = false;

    const connect = async () => {
      const current = new AbortController();
      controller = current;
      try {
        await streamHistoryEvents(
          {
            onReady: () => {
              attempt = 0;
              if (resyncOnReady) refresh();
              resyncOnReady = false;
            },
            onChange: () => {
              refresh();
              const localEcho = isLocalRunEcho(
                localActiveRef.current,
                lastLocalChangeRef.current,
                Date.now(),
              );
              setNewRunCount((count) =>
                nextNewRunCount(count, { viewingHistory: viewingRef.current, localEcho }),
              );
            },
          },
          current.signal,
        );
      } catch (error) {
        // 401 は認証ガード画面へ切り替わるため再試行しない
        if (error instanceof ApiError && error.status === 401) return;
      }
      if (stopped || current.signal.aborted) return;
      resyncOnReady = true;
      timer = setTimeout(() => void connect(), backoffDelay(attempt));
      attempt += 1;
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        clearTimeout(timer);
        controller?.abort();
        resyncOnReady = true;
      } else if (!stopped) {
        clearTimeout(timer);
        attempt = 0;
        void connect();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    if (!document.hidden) void connect();
    else resyncOnReady = true;

    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  return { newRunCount };
}
