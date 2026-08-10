import type { FlowListEntry } from "../api/client";
import { getFlows } from "../api/client";
import { useAsyncResource } from "./useAsyncResource";

export interface UseFlowsResult {
  flows: FlowListEntry[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/** GET /api/flows を読み込む hook */
export function useFlows(): UseFlowsResult {
  const { data, loading, error, reload } = useAsyncResource<FlowListEntry[]>(getFlows, [], []);
  return { flows: data, loading, error, reload };
}
