import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AcceptSnapshotRequestBody, AcceptSnapshotResult } from "../api/client";
import { acceptSnapshot } from "../api/client";
import { snapshotMismatchesOptions } from "../api/queries";
import { queryErrorMessage } from "../utils/error";

/** run の承認待ちスナップショットを読み込む hook。enabled が false の間は取得しない */
export function useSnapshotMismatches(runId: string, enabled = true) {
  const query = useQuery({ ...snapshotMismatchesOptions(runId), enabled });
  return {
    mismatches: query.data?.mismatches ?? [],
    acceptRefusal: query.data?.acceptRefusal,
    loading: enabled && query.isPending,
    error: queryErrorMessage(query.error),
  };
}

/**
 * POST /api/snapshots/accept を実行する hook。成功したら承認待ちの一覧を取り直す
 * (履歴は追記のみなので承認済みの項目も一覧には残る。承認済みかどうかは呼び出し側のセッション状態で持つ)。
 */
export function useAcceptSnapshot(runId: string) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: AcceptSnapshotRequestBody) => acceptSnapshot(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: snapshotMismatchesOptions(runId).queryKey });
    },
  });
  return {
    accepting: mutation.isPending,
    /** 失敗は例外ではなく null と message で返す(呼び出し側が項目ごとに表示するため) */
    accept: async (
      body: AcceptSnapshotRequestBody,
    ): Promise<{ result: AcceptSnapshotResult } | { error: string }> => {
      try {
        return { result: await mutation.mutateAsync(body) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
