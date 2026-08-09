import { apiFetchJson } from "./http";
import type { RunStreamCallbacks } from "./sse";
import { streamRun } from "./sse";
import type {
  EnvironmentCaptureRequestBody,
  EnvironmentDetail,
  EnvironmentListEntry,
  EnvironmentUpdateRequestBody,
  FlowDetail,
  FlowListEntry,
  GetHistoryParams,
  HistoryPage,
  RunRequestBody,
  SingleRequestRequestBody,
  SingleRequestResultPayload,
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

export function getEnvironmentDetail(name: string): Promise<EnvironmentDetail> {
  return apiFetchJson<EnvironmentDetail>(`/api/environments/${encodeURIComponent(name)}`);
}

export function updateEnvironment(
  name: string,
  values: Record<string, string>,
): Promise<EnvironmentDetail> {
  const body: EnvironmentUpdateRequestBody = { values };
  return apiFetchJson<EnvironmentDetail>(`/api/environments/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

/** POST /api/request: フロー定義を経由せず単発でリクエストを実行する */
export function runSingleRequest(
  body: SingleRequestRequestBody,
): Promise<SingleRequestResultPayload> {
  return apiFetchJson<SingleRequestResultPayload>("/api/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** POST /api/environments/:name/capture: レスポンスボディから JSONPath で抽出した値を env の1キーへ保存する */
export function captureToEnvironment(
  name: string,
  body: EnvironmentCaptureRequestBody,
): Promise<EnvironmentDetail> {
  return apiFetchJson<EnvironmentDetail>(`/api/environments/${encodeURIComponent(name)}/capture`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
