/**
 * TanStack Query の queryKey + queryFn を colocate する factory 群(v5 推奨パターン)。
 * hooks/ 側はこれらの queryOptions() をそのまま useQuery / useInfiniteQuery / queryClient に渡すだけにし、
 * key の重複定義(手書きの key-factory オブジェクト)を避ける。
 */
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  getEnvironmentDetail,
  getEnvironments,
  getFlowDetail,
  getFlows,
  getHistory,
} from "./client";

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
