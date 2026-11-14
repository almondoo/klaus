/**
 * API クライアントのファサード。
 * VITE_KLAUS_MOCK=1 のときは mock.ts に、それ以外は real.ts(実 fetch)に処理を委譲する。
 * UI コンポーネント・hooks はこのモジュールだけを import すればよい。
 */
import * as mock from "./mock";
import * as real from "./real";

const useMock = import.meta.env.VITE_KLAUS_MOCK === "1";

const impl = useMock ? mock : real;

export const getFlows = impl.getFlows;
export const getFlowDetail = impl.getFlowDetail;
export const getEnvironments = impl.getEnvironments;
export const getEnvironmentDetail = impl.getEnvironmentDetail;
export const updateEnvironment = impl.updateEnvironment;
export const captureToEnvironment = impl.captureToEnvironment;
export const getHistory = impl.getHistory;
export const getHistoryDiff = impl.getHistoryDiff;
export const promoteHistory = impl.promoteHistory;
export const getSnapshotMismatches = impl.getSnapshotMismatches;
export const acceptSnapshot = impl.acceptSnapshot;
export const runFlow = impl.runFlow;
export const runSingleRequest = impl.runSingleRequest;

export { ApiError } from "./http";
export type { RunStreamCallbacks } from "./sse";
export { getToken, onUnauthorized } from "./token";
export type {
  AcceptSnapshotRequestBody,
  AcceptSnapshotResult,
  AssertionResult,
  BodyDiff,
  DifferenceList,
  EnvironmentCaptureRequestBody,
  EnvironmentDetail,
  EnvironmentListEntry,
  EnvironmentUpdateRequestBody,
  FlowDetail,
  FlowListEntry,
  FlowResult,
  GetHistoryDiffParams,
  GetHistoryParams,
  HeaderDiff,
  HistoryEntry,
  HistoryPage,
  JsonDifference,
  OpenApiRunSummary,
  PromoteRequestBody,
  PromoteResponse,
  RunDiff,
  RunRequestBody,
  RunResultPayload,
  RunSummary,
  SingleRequestRequestBody,
  SingleRequestResultPayload,
  SnapshotMismatch,
  SnapshotMismatchesPayload,
  StepDiff,
  StepResult,
  StepResultPayload,
  StepStartPayload,
} from "./types";
