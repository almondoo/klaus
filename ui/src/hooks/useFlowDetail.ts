import type { FlowDetail } from "../api/client";
import { getFlowDetail } from "../api/client";
import { useAsyncResource } from "./useAsyncResource";

export interface UseFlowDetailResult {
  detail: FlowDetail | null;
  loading: boolean;
  error: string | null;
}

/** GET /api/flows/detail を読み込む hook。path が undefined の間は何もしない */
export function useFlowDetail(path: string | undefined): UseFlowDetailResult {
  const { data, loading, error } = useAsyncResource<FlowDetail | null>(
    () => getFlowDetail(path ?? ""),
    null,
    [path],
    { initialLoading: false, enabled: path !== undefined, disabledReset: "data" },
  );
  return { detail: data, loading, error };
}
