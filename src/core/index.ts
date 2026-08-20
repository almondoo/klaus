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
export type { CassetteEntry } from "./cassette.js";
export {
  appendCassetteEntry,
  buildCassetteEntry,
  cassetteEntryToHttpResponse,
  cassetteFilePath,
  findCassetteEntry,
  loadCassetteIndex,
} from "./cassette.js";
export type { DataRow } from "./data.js";
export { loadDataFile } from "./data.js";
export { collectYamlFiles, discoverFlowCandidates, isFlowCandidate } from "./discovery.js";
export {
  assertTrustedAncestorSource,
  EnvironmentNotFoundError,
  loadEnvironment,
  resolveEnvironmentPath,
  saveEnvironment,
} from "./env.js";
export * from "./errors.js";
export type { HistoryEntry } from "./history.js";
export {
  appendHistory,
  expandSecretVariants,
  historyDateFromTimestamp,
  historyFilePath,
  maskDeep,
  maskString,
} from "./history.js";
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
export { isPathWithinDir, isRealPathWithinDir } from "./path-guard.js";
export type {
  ExecuteSingleRequestOptions,
  ExecuteSingleRequestResult,
  LoadedFlowEntry,
  RunFlowOptions,
  StepCompleteContext,
  StepStartContext,
} from "./runner.js";
export {
  captureValues,
  executeFlow,
  executeSingleRequest,
  resolveRequestMethod,
  runFlow,
  runFlows,
  runLoadedFlows,
} from "./runner.js";
export type {
  AssertDef,
  BodyAssertion,
  BodyTextAssertion,
  CliConfig,
  DurationAssertion,
  Environment,
  EventAssertion,
  EventCountAssertion,
  Flow,
  GraphqlRequestDef,
  HeaderAssertion,
  MessageAssertion,
  MessageCountAssertion,
  ReportFormat,
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
  configSchema,
  durationAssertionSchema,
  environmentSchema,
  eventAssertionSchema,
  eventCountAssertionSchema,
  flowSchema,
  graphqlRequestSchema,
  headerAssertionSchema,
  messageAssertionSchema,
  messageCountAssertionSchema,
  parseReportFormatList,
  REPORT_FORMATS,
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
