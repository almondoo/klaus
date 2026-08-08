import { apiFetchJson } from "./http";
import type { RunStreamCallbacks } from "./sse";
import { streamRun } from "./sse";
import type {
  EnvironmentListEntry,
  FlowDetail,
  FlowListEntry,
  GetHistoryParams,
  HistoryPage,
  RunRequestBody,
} from "./types";

export function getFlows(): Promise<FlowListEntry[]> {
  return apiFetchJson<FlowListEntry[]>("/api/flows");
}

export function getFlowDetail(path: string): Promise<FlowDetail> {
  return apiFetchJson<FlowDetail>(`/api/flows/detail?path=${encodeURIComponent(path)}`);
}

export function getEnvironments(): Promise<EnvironmentListEntry[]> {
  return apiFetchJson<EnvironmentListEntry[]>("/api/environments");
}

export function getHistory(params: GetHistoryParams = {}): Promise<HistoryPage> {
  const search = new URLSearchParams();
  if (params.flow) search.set("flow", params.flow);
  if (params.limit) search.set("limit", String(params.limit));
  if (params.before) search.set("before", params.before);
  const query = search.toString();
  return apiFetchJson<HistoryPage>(`/api/history${query ? `?${query}` : ""}`);
}

export function runFlow(
  body: RunRequestBody,
  callbacks: RunStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  return streamRun(body, callbacks, signal);
}
