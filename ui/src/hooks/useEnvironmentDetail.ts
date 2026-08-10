import { useCallback, useState } from "react";
import type { EnvironmentDetail } from "../api/client";
import { getEnvironmentDetail, updateEnvironment } from "../api/client";
import { useAsyncResource } from "./useAsyncResource";

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
  const {
    data: detail,
    loading,
    error,
    reload,
    setData: setDetail,
  } = useAsyncResource<EnvironmentDetail | null>(
    () => getEnvironmentDetail(name ?? ""),
    null,
    [name],
    { initialLoading: false, enabled: name !== undefined, disabledReset: "all" },
  );

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useCallback(
    async (values: Record<string, string>): Promise<boolean> => {
      if (!name) return false;
      setSaving(true);
      setSaveError(null);
      try {
        const updated = await updateEnvironment(name, values);
        setDetail(updated);
        return true;
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [name, setDetail],
  );

  return { detail, loading, error, saving, saveError, save, reload };
}
