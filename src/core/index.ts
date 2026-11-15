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
  loadCassetteEntries,
  loadCassetteIndex,
} from "./cassette.js";
export { CookieJar, splitSetCookieHeader } from "./cookie-jar.js";
export type { DataRow } from "./data.js";
export { loadDataFile } from "./data.js";
export {
  collectYamlFiles,
  discoverFlowCandidates,
  discoverFlowCandidatesWithRaw,
  isFlowCandidate,
} from "./discovery.js";
export type {
  DryRunFlowResult,
  DryRunGuardStatus,
  DryRunOptions,
  DryRunResult,
  DryRunStepResult,
} from "./dry-run.js";
export { dryRunFlow, dryRunLoadedFlows } from "./dry-run.js";
export {
  assertTrustedAncestorSource,
  EnvironmentNotFoundError,
  loadEnvironment,
  resolveEnvironmentPath,
  saveEnvironment,
} from "./env.js";
export * from "./errors.js";
export type { AllowedHostPattern, GuardOptions } from "./guard.js";
export { checkHostAllowed, isSafeMethod, parseAllowedHostEntry } from "./guard.js";
export type { HistoryActor, HistoryEntry, HistoryGit } from "./history.js";
export {
  appendHistory,
  expandSecretVariants,
  historyDateFromTimestamp,
  historyFilePath,
  maskCookieHeadersDeep,
  maskDeep,
  maskString,
} from "./history.js";
export type { GetHistoryQuery, HistoryEntryStatus, HistoryPage } from "./history-query.js";
export {
  getHistoryPage,
  HISTORY_ENTRY_STATUSES,
  readAllHistoryEntries,
  resolveHistoryEntryStatus,
} from "./history-query.js";
export type { HttpRequestOptions, HttpResponse, RawHttpResponse } from "./http.js";
/**
 * 注意: sendRawRequest / sendRequest は低レベルの送信関数で、安全柵(guard.allowedHosts・
 * $protected)の判定を行わない(設計上の仕様)。判定が効くのは runFlow / runFlows / runLoadedFlows /
 * executeFlow / executeSingleRequest など、runner.ts のエントリポイント経由の実行のみ。
 * ライブラリとして直接呼ぶ場合は、呼び出し側で送信先を検証すること。
 */
export { DEFAULT_TIMEOUT_MS, sendRawRequest, sendRequest } from "./http.js";
export { DEFAULT_MAX_REDIRECTS, mergeHttpConfig, resolveHttpTlsPaths } from "./http-session.js";
export type {
  DiffJsonOptions,
  JsonDifference,
  JsonDifferenceKind,
  JsonPathPattern,
} from "./json-diff.js";
export {
  diffJson,
  formatJsonPath,
  MAX_DESCENDANT_OPERATORS,
  parseJsonPathPattern,
  replaceIgnoredPaths,
} from "./json-diff.js";
export type { FlowIssue, FlowValidationResult } from "./loader.js";
export {
  describeFlowSchemaIssues,
  formatSchemaValidationMessage,
  formatZodError,
  loadEnvironmentFile,
  loadFlow,
  parseEnvironmentYaml,
  parseFlowYaml,
  toParseError,
  validateFlowFile,
  validateFlowYaml,
} from "./loader.js";
export type { MockCollision, MockMatcher, MockMatcherOptions, MockResponse } from "./mock.js";
export {
  buildMockResponse,
  createMockMatcher,
  normalizeOrigin,
  parseRequestTarget,
} from "./mock.js";
export type { OpenApiCheckInput, OpenApiLoadOptions, OpenApiResponseInput } from "./openapi.js";
export { MAX_OPENAPI_VIOLATIONS, OpenApiValidator } from "./openapi.js";
export {
  findUnsafeSymlinkInWritePath,
  isPathWithinDir,
  isRealPathWithinDir,
  toDisplayPath,
} from "./path-guard.js";
export type {
  PromoteAssertMode,
  PromoteCaptureLink,
  PromotedFlow,
  PromotedStepInfo,
  PromoteOptions,
  PromoteOutcome,
  PromotePlaceholder,
  PromoteResult,
  PromoteRunInput,
  PromoteSkipped,
} from "./promote.js";
export { inferJsonSchema, promoteRuns, renderPromotedYaml } from "./promote.js";
export type {
  BodyDiff,
  Change,
  DifferenceList,
  HeaderDiff,
  RequestDiff,
  ResolveRunResult,
  RunDiff,
  RunDiffOptions,
  RunSummary,
  StepDiff,
} from "./run-diff.js";
export {
  DEFAULT_IGNORED_HEADERS,
  diffRuns,
  resolveRunRef,
  selectRunEntries,
  sortRunEntries,
  summarizeRun,
} from "./run-diff.js";
export type {
  CaptureResponse,
  EntryPoint,
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
  AuthDef,
  BodyAssertion,
  BodyTextAssertion,
  CaptureDef,
  CliConfig,
  DurationAssertion,
  Environment,
  EventAssertion,
  EventCountAssertion,
  Flow,
  FlowHttpConfig,
  GraphqlRequestDef,
  HeaderAssertion,
  HttpConfig,
  HttpTlsConfig,
  MessageAssertion,
  MessageCountAssertion,
  ReportFormat,
  RequestDef,
  SnapshotAssertionDef,
  SseOptions,
  Step,
  WsDef,
  WsSendItem,
} from "./schema.js";
export {
  assertSchema,
  authSchema,
  bodyAssertionSchema,
  bodyTextAssertionSchema,
  configSchema,
  durationAssertionSchema,
  environmentSchema,
  eventAssertionSchema,
  eventCountAssertionSchema,
  flowHttpSchema,
  flowSchema,
  graphqlRequestSchema,
  headerAssertionSchema,
  httpConfigSchema,
  httpTlsSchema,
  messageAssertionSchema,
  messageCountAssertionSchema,
  parseReportFormatList,
  REPORT_FORMATS,
  requestSchema,
  SNAPSHOT_INCLUDE_VALUES,
  snapshotAssertionSchema,
  sseOptionsSchema,
  stepSchema,
  wsSchema,
  wsSendItemSchema,
} from "./schema.js";
export type {
  AcceptSnapshotResult,
  AcceptSnapshotTarget,
  SnapshotMismatch,
  SnapshotSpec,
} from "./snapshot.js";
export {
  acceptSnapshot,
  buildSnapshotKey,
  describeSnapshotDifference,
  listSnapshotMismatches,
  normalizeSnapshotSpec,
  SNAPSHOT_DIR,
  SNAPSHOT_PLACEHOLDER,
  SNAPSHOT_SUFFIX,
  snapshotFilePath,
} from "./snapshot.js";
export type { SseResult } from "./sse.js";
/**
 * 注意: receiveSse は低レベルの受信関数で、安全柵(guard.allowedHosts・$protected)の判定を行わない。
 * 判定が効くのは runFlow / runFlows / runLoadedFlows / executeFlow / executeSingleRequest 経由の実行のみ。
 */
export { receiveSse } from "./sse.js";
export type { TemplateContext } from "./template.js";
export { renderDeep, renderHeaders, renderString } from "./template.js";
export type { LineChange, LineDiff } from "./text-diff.js";
export { diffLines } from "./text-diff.js";
export * from "./types.js";
export type { WsConnectOptions, WsConnectResult } from "./ws.js";
/**
 * 注意: connectWebSocket は低レベルの接続関数で、安全柵(guard.allowedHosts・$protected)の判定を行わない。
 * 判定が効くのは runFlow / runFlows / runLoadedFlows / executeFlow / executeSingleRequest 経由の実行のみ。
 */
export { connectWebSocket } from "./ws.js";
export { parseYamlQuietly } from "./yaml-quiet.js";
