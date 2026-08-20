/**
 * 履歴(.klaus/history/*.jsonl)を読み出し・フィルタ・ページングする core ロジック。
 * server(GET /api/history)と CLI(klaus history)の両方がこのモジュールを使う
 * (CLI が server 層を import しないための共通化)。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HistoryEntry } from "./history.js";

const DEFAULT_LIMIT = 50;

/** v が 1(既知のスキーマバージョン)の履歴エントリかどうかを判定する。未知の v の行は呼び出し側でスキップする */
function isHistoryEntryV1(value: unknown): value is HistoryEntry {
  return typeof value === "object" && value !== null && (value as { v?: unknown }).v === 1;
}

/**
 * .klaus/history 配下の全 jsonl を新しい順(startedAt 降順)に読み出す。
 * ファイル名降順 × ファイル内行降順を初期順序としつつ、最後に startedAt 降順の安定ソートを
 * かけて確定させる。--jobs>1 での並列実行時は完了順に追記されるため、ファイル内の行順が
 * 必ずしも startedAt の昇順(=追記順)と一致しない(実行完了順で書かれる)ためこの補正が必要。
 * 安定ソートにより、startedAt が同一のエントリ同士は上記の初期順序を保つ。
 */
export async function readAllHistoryEntries(cwd: string): Promise<HistoryEntry[]> {
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
    // 1ファイル内は基本的に追記順(古い→新しい)で書かれているため、反転して新しい順にする
    // (並列実行時の完了順ずれは後段の startedAt 降順ソートで補正する)
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
  // startedAt 降順で確定させる(Array#sort は ES2019 以降で安定ソートが仕様上保証されている)。
  // これにより before カーソルによるフィルタ・ページングの前提(順序が startedAt と一致する)が成り立つ。
  entries.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return entries;
}

/**
 * エントリ1件の成否を判定する。
 * - status フィールドがあればそれをそのまま使う
 * - 無ければ(旧エントリ)従来通り assertions から導出する(1件でも ok:false があれば "failed")
 * (ui/src/utils/history.ts の resolveStepStatus と同じ規約。core からは ui を参照できないため個別に持つ)
 * CLI(klaus history)の --failed フィルタ・status 表示からも参照するため公開する。
 */
export function resolveHistoryEntryStatus(entry: HistoryEntry): "passed" | "failed" | "skipped" {
  if (entry.status) return entry.status;
  return entry.assertions.some((assertion) => !assertion.ok) ? "failed" : "passed";
}

export interface GetHistoryQuery {
  // 呼び出し元(app.ts / CLI)がクエリパラメータ未指定時に明示的に undefined を渡すため許容する
  flow?: string | undefined;
  limit?: number | undefined;
  before?: string | undefined;
  /** true の場合、status が "failed"(または旧エントリで assertions から failed と導出される)エントリのみに絞る */
  failed?: boolean | undefined;
}

/** GET /api/history のレスポンスおよび CLI 出力の共通形 */
export interface HistoryPage {
  entries: HistoryEntry[];
  /** さらに古い履歴がある場合、次回 before に渡すカーソル(ISO 日時) */
  nextBefore?: string | undefined;
}

/** flow フィルタ・failed フィルタ・limit・before カーソルでページングした履歴を返す */
export async function getHistoryPage(cwd: string, query: GetHistoryQuery): Promise<HistoryPage> {
  const limit = query.limit && query.limit > 0 ? query.limit : DEFAULT_LIMIT;

  let entries = await readAllHistoryEntries(cwd);
  if (query.flow) entries = entries.filter((entry) => entry.flow === query.flow);
  if (query.before) {
    const before = query.before;
    entries = entries.filter((entry) => entry.startedAt < before);
  }
  if (query.failed)
    entries = entries.filter((entry) => resolveHistoryEntryStatus(entry) === "failed");

  const page = entries.slice(0, limit);
  const nextBefore = entries.length > limit ? page[page.length - 1]?.startedAt : undefined;
  return { entries: page, nextBefore };
}
