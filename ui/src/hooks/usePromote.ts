import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PromoteRequestBody, PromoteResponse } from "../api/client";
import { ApiError, promoteHistory } from "../api/client";
import { flowsOptions, promotePreviewOptions } from "../api/queries";

export interface PromoteFailure {
  status: number | undefined;
  message: string;
  code: string | undefined;
}

function toFailure(error: unknown): PromoteFailure | null {
  if (!error) return null;
  if (error instanceof ApiError) {
    return { status: error.status, message: error.message, code: error.code };
  }
  return {
    status: undefined,
    message: error instanceof Error ? error.message : String(error),
    code: undefined,
  };
}

export interface UsePromotePreviewResult {
  preview: PromoteResponse | undefined;
  loading: boolean;
  failure: PromoteFailure | null;
}

/**
 * dryRun でフロー保存のプレビューを取得する hook。body が null の間は取得しない。
 * 入力が変わって再取得する間は直前のプレビューを残す(エラー時は failure を返し、保存は無効にする側で判断する)。
 */
export function usePromotePreview(body: PromoteRequestBody | null): UsePromotePreviewResult {
  const query = useQuery({
    ...promotePreviewOptions(body ?? { runIds: [] }),
    enabled: body !== null,
    placeholderData: keepPreviousData,
  });
  return {
    // エラー時は、古いプレビューを現在の入力の結果と取り違えないよう返さない
    preview: query.isError ? undefined : query.data,
    loading: body !== null && (query.isPending || query.isFetching),
    failure: toFailure(query.error),
  };
}

export interface UsePromoteSaveResult {
  saving: boolean;
  saved: PromoteResponse | null;
  failure: PromoteFailure | null;
  save: (body: PromoteRequestBody) => Promise<PromoteResponse | null>;
  reset: () => void;
}

/** POST /api/history/promote(dryRun なし)で新規フローを保存する hook。成功したらフロー一覧を取り直す */
export function usePromoteSave(): UsePromoteSaveResult {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (body: PromoteRequestBody) => promoteHistory({ ...body, dryRun: false }),
    onSuccess: () => {
      // 新しいフローがサイドバーの一覧に出るようにする
      void queryClient.invalidateQueries({ queryKey: flowsOptions().queryKey });
    },
  });
  return {
    saving: mutation.isPending,
    saved: mutation.data ?? null,
    failure: toFailure(mutation.error),
    save: async (body) => {
      try {
        return await mutation.mutateAsync(body);
      } catch {
        return null;
      }
    },
    reset: () => mutation.reset(),
  };
}
