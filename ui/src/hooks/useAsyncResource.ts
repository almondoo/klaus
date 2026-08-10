import type { DependencyList, Dispatch, SetStateAction } from "react";
import { useEffect, useState } from "react";

export interface UseAsyncResourceOptions {
  /** 初期 loading 状態(省略時 true)。取得が name/path 等の条件付きで、初期値が未確定な hook では false を渡す */
  initialLoading?: boolean;
  /** false の間は取得をスキップする(未選択時など)。省略時は常に取得する */
  enabled?: boolean;
  /**
   * enabled が false の間の状態リセット範囲。
   * "data" は data のみ、"all" は data/error/loading をすべてリセットする(省略時 "all")
   */
  disabledReset?: "data" | "all";
}

export interface UseAsyncResourceResult<T> {
  data: T;
  loading: boolean;
  error: string | null;
  reload: () => void;
  /** fetch を経由せず data を直接更新する(例: PUT のレスポンスをそのまま反映する場合) */
  setData: Dispatch<SetStateAction<T>>;
}

/**
 * 「effect 内で fetch し、cancelled フラグで競合を防ぎつつ loading/error を管理する」パターンの共通実装。
 * useFlows / useEnvironments / useFlowDetail / useEnvironmentDetail の内部実装として使う薄い基盤 hook。
 * reload() は常に返すが、公開するかどうか(戻り値に含めるか)は呼び出し側の各 hook に委ねる。
 */
export function useAsyncResource<T>(
  fetcher: () => Promise<T>,
  initialData: T,
  deps: DependencyList,
  options: UseAsyncResourceOptions = {},
): UseAsyncResourceResult<T> {
  const { initialLoading = true, enabled = true, disabledReset = "all" } = options;
  const [data, setData] = useState<T>(initialData);
  const [loading, setLoading] = useState(initialLoading);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // fetcher/initialData/disabledReset は呼び出し側で毎レンダー生成されるため deps には含めない。
  // 再取得のトリガーは呼び出し側が渡す deps と reloadKey(reload() 呼び出し)のみで管理する
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetcher/initialData/disabledReset は上記コメントの理由により対象外
  useEffect(() => {
    if (!enabled) {
      setData(initialData);
      if (disabledReset === "all") {
        setError(null);
        setLoading(false);
      }
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetcher()
      .then((result) => {
        if (!cancelled) setData(result);
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
  }, [...deps, enabled, reloadKey]);

  return { data, loading, error, reload: () => setReloadKey((k) => k + 1), setData };
}
