import { useQuery } from "@tanstack/react-query";
import type { FlowDetail } from "../api/client";
import { flowDetailOptions } from "../api/queries";

export interface UseFlowDetailResult {
  detail: FlowDetail | null;
  loading: boolean;
  error: string | null;
}

/** GET /api/flows/detail を読み込む hook。path が undefined の間は何もしない */
export function useFlowDetail(path: string | undefined): UseFlowDetailResult {
  const { data, isPending, error } = useQuery({
    ...flowDetailOptions(path ?? ""),
    enabled: path !== undefined,
  });
  return {
    // enabled=false の間は元実装(useAsyncResource の disabledReset: "data")と同様、
    // detail を null にリセットする(loading/error は queryFn 未実行のため元々変化しない)
    detail: path === undefined ? null : (data ?? null),
    loading: isPending && path !== undefined,
    error: error instanceof Error ? error.message : error ? String(error) : null,
  };
}
