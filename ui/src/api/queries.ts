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
  getHistoryDiff,
  getSnapshotMismatches,
  promoteHistory,
} from "./client";
import type { GetHistoryDiffParams, HistoryPage, PromoteRequestBody } from "./types";

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
 * 2 つの run の差分。キーは履歴一覧(["history", flow])と衝突させない(refreshHistoryQueries が
 * ["history"] 配下を無限クエリとして扱うため、別のルートキーにする)。履歴は追記のみで過去の run の内容は
 * 変わらないので、同じ入力のキャッシュは有効なまま使える。
 */
export function historyDiffOptions(params: GetHistoryDiffParams) {
  return queryOptions({
    queryKey: [
      "historyDiff",
      params.a,
      params.b,
      params.flow ?? null,
      params.ignorePaths ?? [],
    ] as const,
    queryFn: () => getHistoryDiff(params),
  });
}

/**
 * run の承認待ちスナップショット。履歴は追記のみなので run ごとの内容は変わらないが、承認で
 * 基準ファイルは変わる(承認済みかどうかは UI 側のセッション状態で持つ)ため、取得は run 単位に分ける。
 */
export function snapshotMismatchesOptions(runId: string) {
  return queryOptions({
    queryKey: ["snapshotMismatches", runId] as const,
    queryFn: () => getSnapshotMismatches(runId),
  });
}

/** 「フローとして保存」のプレビュー(dryRun)。保存結果とは別のルートキーにする */
export function promotePreviewOptions(body: PromoteRequestBody) {
  return queryOptions({
    queryKey: ["promotePreview", body] as const,
    queryFn: () => promoteHistory({ ...body, dryRun: true }),
    // プレビューは入力のたびに変わるため、キャッシュを使い回さず、使われなくなったら破棄する
    gcTime: 0,
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
