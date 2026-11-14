/**
 * 実行履歴の2つの run を比較する core ロジック(klaus diff の本体)。
 * 履歴エントリ(マスク済みで保存されている)だけを入力に取る純粋関数群で、I/O は行わない。
 * - ステップは (flow, step, iteration) で突き合わせる(同一キーが複数あれば出現順で n 番目同士)
 * - 差分はステータス・HTTP ステータス・レスポンスヘッダー・レスポンス body・リクエスト(method/URL/body)・
 *   SSE イベント・(閾値指定時のみ)所要時間
 * - マスク値("***")は保存済みの文字列として比較するため、シークレットの変化は検出できない
 */
import type { HistoryActor, HistoryEntry, HistoryGit } from "./history.js";
import { resolveHistoryEntryStatus } from "./history-query.js";
import { diffJson, type JsonDifference, type JsonPathPattern } from "./json-diff.js";
import { diffLines, type LineChange } from "./text-diff.js";

/** 既定で比較対象から外すレスポンスヘッダー(小文字)。リクエストごとに必ず変わる、または body の複製にすぎないもの */
export const DEFAULT_IGNORED_HEADERS: readonly string[] = [
  "date",
  "age",
  "content-length",
  "server-timing",
  "x-request-id",
  "x-correlation-id",
  "request-id",
  "x-trace-id",
  "x-amzn-trace-id",
  "x-amz-request-id",
  "x-amz-id-2",
  "traceparent",
  "cf-ray",
];

export interface RunDiffOptions {
  /** 比較から外すレスポンスヘッダー名(大文字小文字は無視) */
  ignoreHeaders: readonly string[];
  /** body(レスポンス・リクエスト)の JSON 差分から除外するパス */
  ignorePaths: readonly JsonPathPattern[];
  /** 指定時のみ、所要時間の差の絶対値がこの値を超えたステップを差分として扱う */
  durationThresholdMs?: number | undefined;
  /** 1ステップ・1セクション(レスポンス body / リクエスト body / events)あたりに保持する差分の最大数 */
  maxDifferences: number;
}

export interface Change<T> {
  a?: T;
  b?: T;
}

export interface HeaderDiff {
  added: Record<string, string>;
  removed: Record<string, string>;
  changed: Record<string, { a: string; b: string }>;
}

export interface DifferenceList {
  /** 打ち切り前の差分の総数 */
  total: number;
  /** maxDifferences で省略した件数(total - differences.length) */
  omitted: number;
  differences: JsonDifference[];
}

export type BodyDiff =
  | ({ kind: "json" } & DifferenceList)
  | {
      kind: "text";
      added: number;
      removed: number;
      omitted: number;
      lines: LineChange[];
    };

export interface RequestDiff {
  method?: Change<string>;
  url?: Change<string>;
  body?: BodyDiff;
}

export interface StepDiff {
  flow: string;
  step: string;
  iteration?: number;
  change: "same" | "different" | "added" | "removed";
  status?: Change<string>;
  httpStatus?: Change<number>;
  /** リクエスト自体の差(レスポンスの差とは別に扱う) */
  request?: RequestDiff;
  responseHeaders?: HeaderDiff;
  body?: BodyDiff;
  events?: DifferenceList;
  error?: Change<string>;
  durationMs?: { a: number; b: number; delta: number };
}

export interface RunSummary {
  runId: string;
  flows: string[];
  /** run 内で最も早い startedAt */
  startedAt: string;
  steps: number;
  status: "passed" | "failed" | "error";
  env?: string;
  file?: string;
  actor?: HistoryActor;
  git?: HistoryGit;
}

export interface RunDiff {
  status: "same" | "different";
  runs: { a: RunSummary; b: RunSummary };
  counts: { same: number; different: number; added: number; removed: number };
  steps: StepDiff[];
}

function byStartedAt(a: HistoryEntry, b: HistoryEntry): number {
  return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
}

/**
 * readAllHistoryEntries の結果(新しい順。同一 startedAt の並びは追記順の逆)から、指定 run(と任意で flow)の
 * エントリを「追記順(古い順)」で取り出す。同一ミリ秒に開始したステップの順序を、履歴ファイルの行順で確定させる
 * ため、diff / promote はこの関数経由で run のエントリを得る(startedAt だけの昇順ソートでは同時刻が逆順になる)。
 */
export function selectRunEntries(
  history: readonly HistoryEntry[],
  runId: string,
  flow?: string,
): HistoryEntry[] {
  return history
    .filter((entry) => entry.runId === runId && (flow === undefined || entry.flow === flow))
    .reverse();
}

/** 1 run 分のエントリを実行順(startedAt 昇順。同時刻は与えられた順 = 追記順を保つ安定ソート)に並べる */
export function sortRunEntries(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort(byStartedAt);
}

/** run の監査項目の要約を作る(entries は1件以上) */
export function summarizeRun(runId: string, entries: readonly HistoryEntry[]): RunSummary {
  const sorted = sortRunEntries(entries);
  const flows: string[] = [];
  for (const entry of sorted) if (!flows.includes(entry.flow)) flows.push(entry.flow);
  const statuses = sorted.map(resolveHistoryEntryStatus);
  const status = statuses.includes("error")
    ? "error"
    : statuses.includes("failed")
      ? "failed"
      : "passed";
  const withEnv = sorted.find((entry) => entry.env !== undefined);
  const withFile = sorted.find((entry) => entry.file !== undefined);
  const withActor = sorted.find((entry) => entry.actor !== undefined);
  const withGit = sorted.find((entry) => entry.git !== undefined);
  return {
    runId,
    flows,
    startedAt: sorted[0]?.startedAt ?? "",
    steps: sorted.length,
    status,
    ...(withEnv?.env !== undefined ? { env: withEnv.env } : {}),
    ...(withFile?.file !== undefined ? { file: withFile.file } : {}),
    ...(withActor?.actor !== undefined ? { actor: withActor.actor } : {}),
    ...(withGit?.git !== undefined ? { git: withGit.git } : {}),
  };
}

export type ResolveRunResult = { ok: true; runId: string } | { ok: false; message: string };

/** flow 指定がある場合にその flow を含む run だけを、新しい順(run 内最早 startedAt の降順)に列挙する */
function listRunIdsNewestFirst(entries: readonly HistoryEntry[], flow: string): string[] {
  const earliest = new Map<string, string>();
  for (const entry of entries) {
    if (entry.flow !== flow) continue;
    const current = earliest.get(entry.runId);
    if (current === undefined || entry.startedAt < current)
      earliest.set(entry.runId, entry.startedAt);
  }
  return [...earliest.entries()]
    .sort((x, y) => (x[1] < y[1] ? 1 : x[1] > y[1] ? -1 : 0))
    .map(([runId]) => runId);
}

/**
 * run の参照("latest" / "previous" / runId)を runId に解決する。
 * latest / previous は flow の指定が必須(単発リクエストや他フローの run が混ざると基準が曖昧になるため)。
 * runId は完全一致のみ(klaus history show と同じ。前方一致は受け付けない)。
 */
export function resolveRunRef(
  entries: readonly HistoryEntry[],
  ref: string,
  flow?: string,
): ResolveRunResult {
  if (ref === "latest" || ref === "previous") {
    if (flow === undefined) {
      return { ok: false, message: `"${ref}" requires --flow <name>` };
    }
    const runIds = listRunIdsNewestFirst(entries, flow);
    const index = ref === "latest" ? 0 : 1;
    const runId = runIds[index];
    if (runId === undefined) {
      return {
        ok: false,
        message: `no ${ref} run found for flow "${flow}" (${runIds.length} run(s) recorded)`,
      };
    }
    return { ok: true, runId };
  }
  if (!entries.some((entry) => entry.runId === ref)) {
    return { ok: false, message: `no history entries found for runId "${ref}"` };
  }
  return { ok: true, runId: ref };
}

function pairingKey(entry: HistoryEntry, occurrence: number): string {
  return JSON.stringify([entry.flow, entry.step, entry.iteration ?? null, occurrence]);
}

/** エントリ列に (flow, step, iteration, 出現順) のキーを付ける */
function keyEntries(entries: readonly HistoryEntry[]): Map<string, HistoryEntry> {
  const seen = new Map<string, number>();
  const keyed = new Map<string, HistoryEntry>();
  for (const entry of entries) {
    const base = pairingKey(entry, 0);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    keyed.set(pairingKey(entry, occurrence), entry);
  }
  return keyed;
}

function limitDifferences(differences: JsonDifference[], max: number): DifferenceList {
  const kept = differences.slice(0, max);
  return {
    total: differences.length,
    omitted: differences.length - kept.length,
    differences: kept,
  };
}

/** body 同士を比較する。差が無ければ undefined */
function diffBodies(
  before: unknown,
  after: unknown,
  options: RunDiffOptions,
): BodyDiff | undefined {
  if (typeof before === "string" && typeof after === "string") {
    if (before === after) return undefined;
    const lines = diffLines(before, after);
    const kept = lines.changes.slice(0, options.maxDifferences);
    return {
      kind: "text",
      added: lines.added,
      removed: lines.removed,
      omitted: lines.changes.length - kept.length,
      lines: kept,
    };
  }
  const differences = diffJson(before, after, { ignorePaths: options.ignorePaths });
  if (differences.length === 0) return undefined;
  return { kind: "json", ...limitDifferences(differences, options.maxDifferences) };
}

function diffHeaders(
  before: Record<string, string>,
  after: Record<string, string>,
  ignored: ReadonlySet<string>,
): HeaderDiff | undefined {
  const normalize = (headers: Record<string, string>): Map<string, string> => {
    const map = new Map<string, string>();
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (!ignored.has(lower)) map.set(lower, value);
    }
    return map;
  };
  const left = normalize(before);
  const right = normalize(after);
  const result: HeaderDiff = { added: {}, removed: {}, changed: {} };
  for (const [name, value] of left) {
    const other = right.get(name);
    if (other === undefined) result.removed[name] = value;
    else if (other !== value) result.changed[name] = { a: value, b: other };
  }
  for (const [name, value] of right) {
    if (!left.has(name)) result.added[name] = value;
  }
  const empty =
    Object.keys(result.added).length === 0 &&
    Object.keys(result.removed).length === 0 &&
    Object.keys(result.changed).length === 0;
  return empty ? undefined : result;
}

function diffStepPair(
  a: HistoryEntry,
  b: HistoryEntry,
  options: RunDiffOptions,
  ignored: ReadonlySet<string>,
): StepDiff {
  const diff: StepDiff = {
    flow: a.flow,
    step: a.step,
    ...(a.iteration !== undefined ? { iteration: a.iteration } : {}),
    change: "same",
  };

  const statusA = resolveHistoryEntryStatus(a);
  const statusB = resolveHistoryEntryStatus(b);
  if (statusA !== statusB) diff.status = { a: statusA, b: statusB };

  if (a.response?.status !== b.response?.status) {
    diff.httpStatus = {
      ...(a.response ? { a: a.response.status } : {}),
      ...(b.response ? { b: b.response.status } : {}),
    };
  }

  // 片側に request / response が無い(skipped・error)場合は、ステータスと HTTP ステータスの変化で表現し、
  // 「全体が追加・削除された」というノイズの多い body / request 差分は出さない
  if (a.request && b.request) {
    const request: RequestDiff = {};
    if (a.request.method !== b.request.method) {
      request.method = { a: a.request.method, b: b.request.method };
    }
    if (a.request.url !== b.request.url) request.url = { a: a.request.url, b: b.request.url };
    const requestBody = diffBodies(a.request.body, b.request.body, options);
    if (requestBody) request.body = requestBody;
    if (Object.keys(request).length > 0) diff.request = request;
  }

  if (a.response && b.response) {
    const headers = diffHeaders(a.response.headers, b.response.headers, ignored);
    if (headers) diff.responseHeaders = headers;
    const body = diffBodies(a.response.body, b.response.body, options);
    if (body) diff.body = body;
  }

  if (a.events !== undefined || b.events !== undefined) {
    const events = diffJson(a.events, b.events, { ignorePaths: options.ignorePaths });
    if (events.length > 0) diff.events = limitDifferences(events, options.maxDifferences);
  }

  if (a.error !== b.error) {
    diff.error = {
      ...(a.error !== undefined ? { a: a.error } : {}),
      ...(b.error !== undefined ? { b: b.error } : {}),
    };
  }

  if (options.durationThresholdMs !== undefined) {
    const delta = b.durationMs - a.durationMs;
    if (Math.abs(delta) > options.durationThresholdMs) {
      diff.durationMs = { a: a.durationMs, b: b.durationMs, delta };
    }
  }

  const { flow: _flow, step: _step, iteration: _iteration, change: _change, ...rest } = diff;
  if (Object.keys(rest).length > 0) diff.change = "different";
  return diff;
}

/** 2つの run のエントリ列を比較する */
export function diffRuns(
  runA: { runId: string; entries: readonly HistoryEntry[] },
  runB: { runId: string; entries: readonly HistoryEntry[] },
  options: RunDiffOptions,
): RunDiff {
  const ignored = new Set(options.ignoreHeaders.map((name) => name.toLowerCase()));
  const keyedA = keyEntries(sortRunEntries(runA.entries));
  const keyedB = keyEntries(sortRunEntries(runB.entries));

  const steps: StepDiff[] = [];
  for (const [key, entryA] of keyedA) {
    const entryB = keyedB.get(key);
    if (entryB) {
      steps.push(diffStepPair(entryA, entryB, options, ignored));
    } else {
      steps.push(onlyOneSide("removed", entryA));
    }
  }
  for (const [key, entryB] of keyedB) {
    if (!keyedA.has(key)) steps.push(onlyOneSide("added", entryB));
  }

  const counts = { same: 0, different: 0, added: 0, removed: 0 };
  for (const step of steps) counts[step.change] += 1;

  return {
    status: counts.different + counts.added + counts.removed === 0 ? "same" : "different",
    runs: {
      a: summarizeRun(runA.runId, runA.entries),
      b: summarizeRun(runB.runId, runB.entries),
    },
    counts,
    steps,
  };
}

function onlyOneSide(change: "added" | "removed", entry: HistoryEntry): StepDiff {
  const status = resolveHistoryEntryStatus(entry);
  return {
    flow: entry.flow,
    step: entry.step,
    ...(entry.iteration !== undefined ? { iteration: entry.iteration } : {}),
    change,
    status: change === "added" ? { b: status } : { a: status },
  };
}
