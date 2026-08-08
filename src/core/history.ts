import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssertionResult, RequestSnapshot, ResponseSnapshot, SseEvent } from "./types.js";

/**
 * 実行履歴 1 行分のスキーマ。versioned にしてあるので、
 * 将来フィールドを変える場合は v を上げて後方互換を判断できるようにする。
 * v は 1 のまま(追加のみの後方互換な変更): status を新設し、
 * request/response は skipped ステップのため省略可能にし、SSE イベントを events に追加した。
 */
export interface HistoryEntry {
  v: 1;
  runId: string;
  flow: string;
  step: string;
  startedAt: string;
  durationMs: number;
  /**
   * 新規に書き込むエントリでは常に設定する。
   * 既存の(このフィールド追加前に書かれた)行には無いため、読み出し側は
   * 省略時に assertions から従来通り導出するフォールバックを持つこと。
   */
  status?: "passed" | "failed" | "skipped";
  /** skipped ステップでは省略する */
  request?: RequestSnapshot;
  /** skipped ステップでは省略する */
  response?: ResponseSnapshot;
  /** SSE ステップで受信したイベント一覧(SSE ステップ以外では省略) */
  events?: SseEvent[];
  assertions: AssertionResult[];
}

/**
 * マスク対象とみなす秘密情報の最小文字数。
 * これより短い値は誤検知(意図しない部分一致による過剰マスク)を避けるためマスクしない。
 */
const MIN_SECRET_LENGTH = 4;

/** 文字列中に含まれる秘密情報値をすべて "***" に置換する */
function maskString(value: string, secrets: readonly string[]): string {
  let masked = value;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    masked = masked.split(secret).join("***");
  }
  return masked;
}

/** 任意の JSON 互換値を深く辿り、文字列だけを秘密情報マスクする(template.ts の renderDeep と対称の実装) */
function maskDeep<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") {
    return maskString(value, secrets) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskDeep(item, secrets)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      result[key] = maskDeep(v, secrets);
    }
    return result as unknown as T;
  }
  return value;
}

function maskHeaders(
  headers: Record<string, string>,
  secrets: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = maskString(value, secrets);
  }
  return result;
}

/** 省略可能な文字列フィールド(SseEvent.event / .id 等)を、値がある場合のみマスクする */
function maskOptionalString(
  value: string | undefined,
  secrets: readonly string[],
): string | undefined {
  return value === undefined ? undefined : maskString(value, secrets);
}

/**
 * assertions 配列をマスクする。expected/actual は任意の JSON 互換値になり得るため maskDeep で辿り、
 * message は人間可読な文字列としてそのままマスクする。
 * StepResult と同じ配列オブジェクトを共有しているため、要素を書き換えず新しい配列・オブジェクトとして返す。
 */
function maskAssertions(
  assertions: readonly AssertionResult[],
  secrets: readonly string[],
): AssertionResult[] {
  return assertions.map((assertion) => ({
    ...assertion,
    expected: maskDeep(assertion.expected, secrets),
    actual: maskDeep(assertion.actual, secrets),
    message: maskString(assertion.message, secrets),
  }));
}

/**
 * 履歴エントリ内の秘密情報({{env.X}} で解決した値)をマスクする。
 * request/response の url・headers・body、events の id・event・data、assertions の
 * expected・actual・message を対象に "***" へ置換する。
 * secrets が空の場合は何もせず entry をそのまま返す(不要なコピーを避ける)。
 */
export function maskHistoryEntry(entry: HistoryEntry, secrets: readonly string[]): HistoryEntry {
  if (secrets.length === 0) return entry;

  const request = entry.request
    ? {
        ...entry.request,
        url: maskString(entry.request.url, secrets),
        headers: maskHeaders(entry.request.headers, secrets),
        body: maskDeep(entry.request.body, secrets),
      }
    : undefined;

  const response = entry.response
    ? {
        ...entry.response,
        headers: maskHeaders(entry.response.headers, secrets),
        body: maskDeep(entry.response.body, secrets),
      }
    : undefined;

  const events = entry.events?.map((event) => ({
    ...event,
    event: maskOptionalString(event.event, secrets),
    id: maskOptionalString(event.id, secrets),
    data: maskString(event.data, secrets),
  }));

  const assertions = maskAssertions(entry.assertions, secrets);

  return {
    ...entry,
    assertions,
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
    ...(events ? { events } : {}),
  };
}

/** cwd 基準で今日の履歴ファイルパスを返す(.klaus/history/<YYYY-MM-DD>.jsonl) */
export function historyFilePath(cwd: string, date: Date = new Date()): string {
  const dateStr = date.toISOString().slice(0, 10);
  return join(cwd, ".klaus", "history", `${dateStr}.jsonl`);
}

/** 履歴を1行(JSON Lines)追記する。ディレクトリが無ければ作成する */
export async function appendHistory(cwd: string, entry: HistoryEntry): Promise<void> {
  const filePath = historyFilePath(cwd);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
}
