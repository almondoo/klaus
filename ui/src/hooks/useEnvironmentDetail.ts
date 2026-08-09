import { useCallback, useEffect, useState } from "react";
import type { EnvironmentDetail } from "../api/client";
import { getEnvironmentDetail, updateEnvironment } from "../api/client";

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
  const [detail, setDetail] = useState<EnvironmentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // reloadKey は値を参照せず、変化させることで再取得をトリガーするためだけに使う
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey は再実行トリガー専用(値自体は effect 内で未使用)
  useEffect(() => {
    if (!name) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getEnvironmentDetail(name)
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [name, reloadKey]);

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
    [name],
  );

  return {
    detail,
    loading,
    error,
    saving,
    saveError,
    save,
    reload: () => setReloadKey((k) => k + 1),
  };
}
