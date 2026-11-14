/**
 * TanStack Query の queryKey + queryFn を colocate する factory 群(v5 推奨パターン)。
 * hooks/ 側はこれらの queryOptions() をそのまま useQuery / useInfiniteQuery / queryClient に渡すだけにし、
 * key の重複定義(手書きの key-factory オブジェクト)を避ける。
 */
import {
  type InfiniteData,
  infiniteQueryOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { loadedEntryCount } from "../utils/historyEvents";
import {
  getEnvironmentDetail,
  getEnvironments,
  getFlowDetail,
  getFlows,
  getHistory,
} from "./client";
import type { HistoryPage } from "./types";

const PAGE_SIZE = 20;

export function flowsOptions() {
  return queryOptions({
    queryKey: ["flows"] as const,
    queryFn: () => getFlows(),
  });
}

export function flowDetailOptions(path: string) {
  return queryOptions({
    queryKey: ["flows", "detail", path] as const,
    queryFn: () => getFlowDetail(path),
  });
}

export function environmentsOptions() {
  return queryOptions({
    queryKey: ["environments"] as const,
    queryFn: () => getEnvironments(),
  });
}

export function environmentDetailOptions(name: string) {
  return queryOptions({
    queryKey: ["environments", name] as const,
    queryFn: () => getEnvironmentDetail(name),
  });
}

export function historyOptions(flow: string | undefined) {
  return infiniteQueryOptions({
    queryKey: ["history", flow ?? null] as const,
    queryFn: ({ pageParam }) => getHistory({ flow, before: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextBefore,
  });
}

/**
 * 履歴の変更通知を受けたときの再取得。キャッシュ済みの履歴クエリごとに、読み込み済みの件数ぶんを
 * 先頭から1ページとして取り直して差し替える(ページ単位の再取得だと、先頭へ新規分が増えた分だけ
 * ページ境界のエントリが欠落するため)。件数と順序は維持されるので、画面側のスクロール位置・
 * 展開状態は保たれ、loading 表示も出ない。
 */
export async function refreshHistoryQueries(queryClient: QueryClient): Promise<void> {
  // 進行中の「さらに読み込む」が古いカーソルで結果を追記するのを防ぐ
  await queryClient.cancelQueries({ queryKey: ["history"] });
  const cached = queryClient.getQueriesData<InfiniteData<HistoryPage, string | undefined>>({
    queryKey: ["history"],
  });
  await Promise.all(
    cached.map(async ([key, data]) => {
      if (!data) {
        await queryClient.invalidateQueries({ queryKey: key });
        return;
      }
      const flow = (key[1] as string | null) ?? undefined;
      try {
        const page = await getHistory({ flow, limit: loadedEntryCount(data, PAGE_SIZE) });
        queryClient.setQueryData<InfiniteData<HistoryPage, string | undefined>>(key, {
          pages: [page],
          pageParams: [undefined],
        });
      } catch {
        // 一時的な失敗は次の通知・再接続時の再取得に任せ、表示中のデータは維持する
      }
    }),
  );
}
