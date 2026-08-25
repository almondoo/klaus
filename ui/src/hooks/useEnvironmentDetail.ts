import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { EnvironmentDetail } from "../api/client";
import { updateEnvironment } from "../api/client";
import { environmentDetailOptions, environmentsOptions } from "../api/queries";

export interface UseEnvironmentDetailResult {
  detail: EnvironmentDetail | null;
  loading: boolean;
  error: string | null;
  saving: boolean;
  saveError: string | null;
  /** 保存に成功したら true、失敗したら false を返す(呼び出し側で編集モードの終了判断に使う) */
  save: (values: Record<string, string>) => Promise<boolean>;
  reload: () => void;
}

/**
 * GET/PUT /api/environments/:name を扱う hook。
 * name が未指定(env セレクタ未選択)の間は取得を行わない。
 */
export function useEnvironmentDetail(name: string | undefined): UseEnvironmentDetailResult {
  const queryClient = useQueryClient();
  const {
    data: detail,
    isPending,
    error,
    refetch,
  } = useQuery({
    ...environmentDetailOptions(name ?? ""),
    enabled: name !== undefined,
  });

  const mutation = useMutation({
    mutationFn: (values: Record<string, string>) => {
      if (!name) throw new Error("env 未選択のため保存できません");
      return updateEnvironment(name, values);
    },
    onSuccess: (updated) => {
      if (!name) return;
      // PUT レスポンスをそのまま詳細キャッシュへ反映し、一覧側は再取得させる
      queryClient.setQueryData(environmentDetailOptions(name).queryKey, updated);
      queryClient.invalidateQueries({ queryKey: environmentsOptions().queryKey, exact: true });
    },
  });

  const save = useCallback(
    async (values: Record<string, string>): Promise<boolean> => {
      if (!name) return false;
      try {
        await mutation.mutateAsync(values);
        return true;
      } catch {
        return false;
      }
    },
    [name, mutation],
  );

  return {
    detail: name === undefined ? null : (detail ?? null),
    loading: isPending && name !== undefined,
    error: error instanceof Error ? error.message : error ? String(error) : null,
    saving: mutation.isPending,
    saveError:
      mutation.error instanceof Error
        ? mutation.error.message
        : mutation.error
          ? String(mutation.error)
          : null,
    save,
    reload: () => {
      void refetch();
    },
  };
}
