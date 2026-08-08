import { useEffect, useState } from "react";
import type { FlowDetail } from "../api/client";
import { getFlowDetail } from "../api/client";

export interface UseFlowDetailResult {
  detail: FlowDetail | null;
  loading: boolean;
  error: string | null;
}

/** GET /api/flows/detail を読み込む hook。path が undefined の間は何もしない */
export function useFlowDetail(path: string | undefined): UseFlowDetailResult {
  const [detail, setDetail] = useState<FlowDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!path) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getFlowDetail(path)
      .then((data) => {
        if (!cancelled) setDetail(data);
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
  }, [path]);

  return { detail, loading, error };
}
