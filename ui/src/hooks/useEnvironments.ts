import type { EnvironmentListEntry } from "../api/client";
import { getEnvironments } from "../api/client";
import { useAsyncResource } from "./useAsyncResource";

export interface UseEnvironmentsResult {
  environments: EnvironmentListEntry[];
  loading: boolean;
  error: string | null;
}

/** GET /api/environments を読み込む hook */
export function useEnvironments(): UseEnvironmentsResult {
  const { data, loading, error } = useAsyncResource<EnvironmentListEntry[]>(
    getEnvironments,
    [],
    [],
  );
  return { environments: data, loading, error };
}
