import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { GetHistoryDiffParams, RunDiff } from "../api/client";
import { historyDiffOptions } from "../api/queries";
import { queryErrorMessage } from "../utils/error";

export interface UseHistoryDiffResult {
  diff: RunDiff | undefined;
  /** 初回の読み込み中(以前の結果がある再取得中は false) */
  loading: boolean;
  /** 除外パスの変更などによる再取得中 */
  refetching: boolean;
  error: string | null;
}

/** GET /api/history/diff を読み込む hook。除外パスを変えて再取得する間も、直前の結果を表示し続ける */
export function useHistoryDiff(params: GetHistoryDiffParams): UseHistoryDiffResult {
  const { data, isPending, isFetching, error } = useQuery({
    ...historyDiffOptions(params),
    placeholderData: keepPreviousData,
  });
  return {
    diff: data,
    loading: isPending,
    refetching: isFetching && !isPending,
    error: queryErrorMessage(error),
  };
}
