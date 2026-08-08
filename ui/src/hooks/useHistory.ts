import { useCallback, useEffect, useState } from "react";
import type { HistoryEntry } from "../api/client";
import { getHistory } from "../api/client";

const PAGE_SIZE = 20;

export interface UseHistoryResult {
  entries: HistoryEntry[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
}

/** GET /api/history を before カーソルで遅延読み込みする hook */
export function useHistory(flow?: string): UseHistoryResult {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before?: string) => {
      setLoading(true);
      setError(null);
      try {
        const page = await getHistory({ flow, before, limit: PAGE_SIZE });
        setEntries((prev) => (before ? [...prev, ...page.entries] : page.entries));
        setNextBefore(page.nextBefore);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [flow],
  );

  // flow が変わるたびに1ページ目から読み直す(load 自体も flow の変化で再生成されるが、
  // 「flow が変わった」ことを明示するため依存配列にも残す)
  // biome-ignore lint/correctness/useExhaustiveDependencies: flow は load 経由で間接参照だが意図を明示するため残す
  useEffect(() => {
    setEntries([]);
    setNextBefore(undefined);
    void load(undefined);
  }, [flow, load]);

  return {
    entries,
    loading,
    error,
    hasMore: nextBefore !== undefined,
    loadMore: () => {
      if (nextBefore) void load(nextBefore);
    },
  };
}
