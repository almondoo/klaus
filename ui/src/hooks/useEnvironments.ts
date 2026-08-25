import { useQuery } from "@tanstack/react-query";
import type { EnvironmentListEntry } from "../api/client";
import { environmentsOptions } from "../api/queries";

export interface UseEnvironmentsResult {
  environments: EnvironmentListEntry[];
  loading: boolean;
  error: string | null;
}

/** GET /api/environments を読み込む hook */
export function useEnvironments(): UseEnvironmentsResult {
  const { data, isPending, error } = useQuery(environmentsOptions());
  return {
    environments: data ?? [],
    loading: isPending,
    error: error instanceof Error ? error.message : error ? String(error) : null,
  };
}
