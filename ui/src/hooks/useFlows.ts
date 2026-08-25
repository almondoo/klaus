import { useQuery } from "@tanstack/react-query";
import type { FlowListEntry } from "../api/client";
import { flowsOptions } from "../api/queries";

export interface UseFlowsResult {
  flows: FlowListEntry[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** GET /api/flows を読み込む hook */
export function useFlows(): UseFlowsResult {
  const { data, isPending, error, refetch } = useQuery(flowsOptions());
  return {
    flows: data ?? [],
    loading: isPending,
    error: error instanceof Error ? error.message : error ? String(error) : null,
    reload: () => {
      void refetch();
    },
  };
}
