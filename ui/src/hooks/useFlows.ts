import { useEffect, useState } from "react";
import type { FlowListEntry } from "../api/client";
import { getFlows } from "../api/client";

export interface UseFlowsResult {
  flows: FlowListEntry[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** GET /api/flows を読み込む hook */
export function useFlows(): UseFlowsResult {
  const [flows, setFlows] = useState<FlowListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // reloadKey は値を参照せず、変化させることで再取得をトリガーするためだけに使う
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey は再実行トリガー専用(値自体は effect 内で未使用)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getFlows()
      .then((data) => {
        if (!cancelled) setFlows(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  return { flows, loading, error, reload: () => setReloadKey((k) => k + 1) };
}
