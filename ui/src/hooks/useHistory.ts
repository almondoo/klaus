import { useInfiniteQuery } from "@tanstack/react-query";
import type { HistoryEntry } from "../api/client";
import { historyOptions } from "../api/queries";

export interface UseHistoryResult {
  entries: HistoryEntry[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
}

/** GET /api/history を before カーソルで遅延読み込みする hook */
export function useHistory(flow?: string): UseHistoryResult {
  const { data, isPending, isFetchingNextPage, error, fetchNextPage, hasNextPage } =
    useInfiniteQuery(historyOptions(flow));

  return {
    // ページごとの entries を1本のフラットな配列に結合する(元実装の accumulation 相当)
    entries: data ? data.pages.flatMap((page) => page.entries) : [],
    loading: isPending || isFetchingNextPage,
    error: error instanceof Error ? error.message : error ? String(error) : null,
    hasMore: hasNextPage,
    loadMore: () => {
      void fetchNextPage();
    },
  };
}
