/**
 * klaus core の公開 API。
 * CLI(src/cli)や将来の UI(src/server)はこのモジュールだけを import する。
 */

export type { AssertionContext } from "./assert.js";
export {
  assertBody,
  assertBodyText,
  assertDuration,
  assertEventCount,
  assertEvents,
  assertHeaders,
  assertMessageCount,
  assertMessages,
  assertStatus,
  evaluateAssertions,
} from "./assert.js";
export { collectYamlFiles, discoverFlowCandidates, isFlowCandidate } from "./discovery.js";
export {
  EnvironmentNotFoundError,
  loadEnvironment,
  resolveEnvironmentPath,
  saveEnvironment,
} from "./env.js";
export * from "./errors.js";
export type { HistoryEntry } from "./history.js";
export { appendHistory, historyDateFromTimestamp, historyFilePath } from "./history.js";
export type { GetHistoryQuery, HistoryPage } from "./history-query.js";
export {
  getHistoryPage,
  readAllHistoryEntries,
  resolveHistoryEntryStatus,
} from "./history-query.js";
export type { HttpRequestOptions, HttpResponse, RawHttpResponse } from "./http.js";
export { DEFAULT_TIMEOUT_MS, sendRawRequest, sendRequest } from "./http.js";
export type { FlowIssue, FlowValidationResult } from "./loader.js";
export {
  describeFlowSchemaIssues,
  formatZodError,
  loadEnvironmentFile,
  loadFlow,
  parseEnvironmentYaml,
  parseFlowYaml,
  validateFlowFile,
  validateFlowYaml,
} from "./loader.js";
export type {
  ExecuteSingleRequestOptions,
  ExecuteSingleRequestResult,
  RunFlowOptions,
  StepCompleteContext,
  StepStartContext,
} from "./runner.js";
export { captureValues, executeFlow, executeSingleRequest, runFlow, runFlows } from "./runner.js";
export type {
  AssertDef,
  BodyAssertion,
  BodyTextAssertion,
  DurationAssertion,
  Environment,
  EventAssertion,
  EventCountAssertion,
  Flow,
  GraphqlRequestDef,
  HeaderAssertion,
  MessageAssertion,
  MessageCountAssertion,
  RequestDef,
  SseOptions,
  Step,
  WsDef,
  WsSendItem,
} from "./schema.js";
export {
  assertSchema,
  bodyAssertionSchema,
  bodyTextAssertionSchema,
  durationAssertionSchema,
  environmentSchema,
  eventAssertionSchema,
  eventCountAssertionSchema,
  flowSchema,
  graphqlRequestSchema,
  headerAssertionSchema,
  messageAssertionSchema,
  messageCountAssertionSchema,
  requestSchema,
  sseOptionsSchema,
  stepSchema,
  wsSchema,
  wsSendItemSchema,
} from "./schema.js";
export type { SseResult } from "./sse.js";
export { receiveSse } from "./sse.js";
export type { TemplateContext } from "./template.js";
export { renderDeep, renderHeaders, renderString } from "./template.js";
export * from "./types.js";
export type { WsConnectOptions, WsConnectResult } from "./ws.js";
export { connectWebSocket } from "./ws.js";
