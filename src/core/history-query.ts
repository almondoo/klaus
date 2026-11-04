/**
 * 履歴(.klaus/history/*.jsonl)を読み出し・フィルタ・ページングする core ロジック。
 * server(GET /api/history)と CLI(klaus history)の両方がこのモジュールを使う
 * (CLI が server 層を import しないための共通化)。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type HistoryEntry, historyFileStartedAtUpperBound } from "./history.js";

const DEFAULT_LIMIT = 50;

/** v が 1(既知のスキーマバージョン)の履歴エントリかどうかを判定する。未知の v の行は呼び出し側でスキップする */
function isHistoryEntryV1(value: unknown): value is HistoryEntry {
  return typeof value === "object" && value !== null && (value as { v?: unknown }).v === 1;
}

/** startedAt 降順の比較関数(Array#sort は ES2019 以降で安定ソートが仕様上保証されている) */
function compareStartedAtDesc(a: HistoryEntry, b: HistoryEntry): number {
  return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0;
}

/**
 * .klaus/history 配下の jsonl ファイル名を新しい日付順(ファイル名の文字列降順)で返す。
 * ディレクトリが読めない場合は undefined を返す。
 */
async function listHistoryFileNamesDesc(dir: string): Promise<string[] | undefined> {
  let fileNames: string[];
  try {
    fileNames = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return undefined;
  }
  // ファイル名は YYYY-MM-DD.jsonl(historyFilePath の契約)なので、文字列降順ソートで新しい日付から読む
  fileNames.sort().reverse();
  return fileNames;
}

/** 履歴ファイル1件を読み、有効なエントリをファイル内行の逆順(新しい順)で返す */
async function readHistoryFileEntries(dir: string, fileName: string): Promise<HistoryEntry[]> {
  const content = await readFile(join(dir, fileName), "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const entries: HistoryEntry[] = [];
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
  return entries;
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
  const fileNames = await listHistoryFileNamesDesc(dir);
  if (!fileNames) return [];

  const entries: HistoryEntry[] = [];
  for (const fileName of fileNames) {
    entries.push(...(await readHistoryFileEntries(dir, fileName)));
  }
  // startedAt 降順で確定させる。
  // これにより before カーソルによるフィルタ・ページングの前提(順序が startedAt と一致する)が成り立つ。
  entries.sort(compareStartedAtDesc);
  return entries;
}

/** エントリが flow / before / failed の各フィルタにすべて一致するかを判定する */
function matchesHistoryQuery(entry: HistoryEntry, query: GetHistoryQuery): boolean {
  if (query.flow && entry.flow !== query.flow) return false;
  if (query.before && !(entry.startedAt < query.before)) return false;
  if (query.failed && resolveHistoryEntryStatus(entry) !== "failed") return false;
  return true;
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

/**
 * flow フィルタ・failed フィルタ・limit・before カーソルでページングした履歴を返す。
 * 結果は「全ファイルを読み、startedAt 降順に安定ソートしてからフィルタ・slice する」場合と完全に一致させつつ
 * (startedAt が ISO-8601 UTC 文字列のデータに限る。historyFileStartedAtUpperBound の不変条件を参照)、
 * 新しいファイルから順に読んで、より古いファイルが結果の先頭 limit+1 件に入り得なくなった時点で打ち切る。
 * - フィルタは順序を保つため、ソート前後どちらで適用しても結果は同じ(ここでは読み込み時に適用する)
 * - 打ち切り条件: 一致済みエントリを安定ソートした limit+1 件目の startedAt が、残りファイルの
 *   startedAt 上限(historyFileStartedAtUpperBound。ファイル名降順なので次のファイルの上限が最大)以上であること。
 *   残りファイルのエントリは startedAt がそれより厳密に小さいため limit+1 件目より後ろにしか並ばず、
 *   先頭 limit+1 件(page と nextBefore の判定に必要な範囲)は変わらない
 * - before カーソルの日付でファイルを読み飛ばすことはしない(古い startedAt のエントリが新しい日付の
 *   ファイルに書かれ得るため)
 * - 同一 startedAt の並びは従来どおり「ファイル名降順 × ファイル内行逆順」の連結順を安定ソートで保つ
 */
export async function getHistoryPage(cwd: string, query: GetHistoryQuery): Promise<HistoryPage> {
  const limit = query.limit && query.limit > 0 ? query.limit : DEFAULT_LIMIT;

  const dir = join(cwd, ".klaus", "history");
  const fileNames = (await listHistoryFileNamesDesc(dir)) ?? [];

  // 各位置 i について「i 以降の全ファイル名が上限を決められる(契約どおりの日付名)か」を後ろから求める
  const boundedFrom: boolean[] = new Array(fileNames.length + 1).fill(true);
  for (let i = fileNames.length - 1; i >= 0; i--) {
    boundedFrom[i] =
      (boundedFrom[i + 1] ?? true) &&
      historyFileStartedAtUpperBound(fileNames[i] as string) !== undefined;
  }

  // entries は常に「読み込み済み一致エントリを連結順で安定ソートした先頭 limit+1 件」を保つ。
  // 既存分を先に置いて安定ソートするため、全件連結→安定ソートした場合と同じ順序になる
  // (順序は (startedAt 降順, 連結位置昇順) の全順序)。切り捨てた要素の前には既に limit+1 件あり、
  // 後から来る要素はいずれも連結位置が後ろなので、切り捨てた要素が先頭 limit+1 件へ戻ることはない。
  let entries: HistoryEntry[] = [];
  for (let i = 0; i < fileNames.length; i++) {
    const matched = (await readHistoryFileEntries(dir, fileNames[i] as string)).filter((entry) =>
      matchesHistoryQuery(entry, query),
    );
    entries = [...entries, ...matched].sort(compareStartedAtDesc).slice(0, limit + 1);
    const nextFileName = fileNames[i + 1];
    if (nextFileName === undefined || entries.length <= limit || !boundedFrom[i + 1]) continue;
    const upperBound = historyFileStartedAtUpperBound(nextFileName) as string;
    const threshold = entries[limit]?.startedAt;
    if (typeof threshold === "string" && threshold >= upperBound) break;
  }

  const page = entries.slice(0, limit);
  const nextBefore = entries.length > limit ? page[page.length - 1]?.startedAt : undefined;
  return { entries: page, nextBefore };
}
