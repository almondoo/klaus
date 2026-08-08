import { useEffect, useState } from "react";
import type { EnvironmentListEntry } from "../api/client";
import { getEnvironments } from "../api/client";

export interface UseEnvironmentsResult {
  environments: EnvironmentListEntry[];
  loading: boolean;
  error: string | null;
}

/** GET /api/environments を読み込む hook */
export function useEnvironments(): UseEnvironmentsResult {
  const [environments, setEnvironments] = useState<EnvironmentListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getEnvironments()
      .then((data) => {
        if (!cancelled) setEnvironments(data);
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
  }, []);

  return { environments, loading, error };
}
