/**
 * GET /api/history が使うロジック。
 * .klaus/history/*.jsonl(core の appendHistory が書き込む契約)を新しい順に読み出し、ページングする。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HistoryEntry } from "../../core/index.js";
import type { HistoryPage } from "../types.js";

const DEFAULT_LIMIT = 50;

/** v が 1(既知のスキーマバージョン)の履歴エントリかどうかを判定する。未知の v の行は呼び出し側でスキップする */
function isHistoryEntryV1(value: unknown): value is HistoryEntry {
  return typeof value === "object" && value !== null && (value as { v?: unknown }).v === 1;
}

/** .klaus/history 配下の全 jsonl を新しい順(日付ファイル降順 × ファイル内行降順)に読み出す */
async function readAllHistoryEntries(cwd: string): Promise<HistoryEntry[]> {
  const dir = join(cwd, ".klaus", "history");
  let fileNames: string[];
  try {
    fileNames = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  // ファイル名は YYYY-MM-DD.jsonl(historyFilePath の契約)なので、文字列降順ソートで新しい日付から読む
  fileNames.sort().reverse();

  const entries: HistoryEntry[] = [];
  for (const fileName of fileNames) {
    const content = await readFile(join(dir, fileName), "utf-8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    // 1ファイル内は追記順(古い→新しい)で書かれているため、反転して新しい順にする
    for (const line of lines.reverse()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // 壊れた行はスキップ
      }
      if (!isHistoryEntryV1(parsed)) continue; // 未知の v の行はスキップ
      entries.push(parsed);
    }
  }
  return entries;
}

export interface GetHistoryQuery {
  // 呼び出し元(app.ts)がクエリパラメータ未指定時に明示的に undefined を渡すため許容する
  flow?: string | undefined;
  limit?: number | undefined;
  before?: string | undefined;
}

/** GET /api/history: flow フィルタ・limit・before カーソルでページングした履歴を返す */
export async function getHistoryPage(cwd: string, query: GetHistoryQuery): Promise<HistoryPage> {
  const limit = query.limit && query.limit > 0 ? query.limit : DEFAULT_LIMIT;

  let entries = await readAllHistoryEntries(cwd);
  if (query.flow) entries = entries.filter((entry) => entry.flow === query.flow);
  if (query.before) {
    const before = query.before;
    entries = entries.filter((entry) => entry.startedAt < before);
  }

  const page = entries.slice(0, limit);
  const nextBefore = entries.length > limit ? page[page.length - 1]?.startedAt : undefined;
  return { entries: page, nextBefore };
}
