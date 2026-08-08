import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AssertionResult, RequestSnapshot, ResponseSnapshot } from "./types.js";

/**
 * 実行履歴 1 行分のスキーマ。versioned にしてあるので、
 * 将来フィールドを変える場合は v を上げて後方互換を判断できるようにする。
 */
export interface HistoryEntry {
  v: 1;
  runId: string;
  flow: string;
  step: string;
  startedAt: string;
  durationMs: number;
  request: RequestSnapshot;
  response: ResponseSnapshot;
  assertions: AssertionResult[];
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
