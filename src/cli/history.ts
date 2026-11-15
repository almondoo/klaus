import type { HistoryEntry } from "../core/index.js";
import { getHistoryPage, readAllHistoryEntries, resolveHistoryEntryStatus } from "../core/index.js";
import { sanitizeForTerminal } from "./reporters/sanitize.js";
import { isJsonOutputMode } from "./reporters/text.js";

/**
 * `klaus history` サブコマンド群の実装。
 * core/history-query.ts のクエリロジックを呼び出すだけで、server 層(src/server)は import しない
 * (CLI から HTTP サーバーを起動せずに履歴を参照できるようにするための層分離)。
 */

/** --fields 未指定時のデフォルト列。巨大になりがちな request/response のボディを含まない */
export const DEFAULT_HISTORY_FIELDS = "startedAt,runId,flow,step,status,durationMs";

/** klaus history(一覧)のオプション。commander から渡される値を正規化した形 */
export interface HistoryListOptions {
  flow?: string;
  failed?: boolean;
  last: number;
  fields: string;
  json?: boolean;
}

/** klaus history show のオプション */
export interface HistoryShowOptions {
  step?: string;
}

/** カンマ区切りの --fields 文字列を空白除去したフィールド名配列にする(空文字は除外) */
function parseFields(csv: string): string[] {
  const fields = csv
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0);
  return fields.length > 0 ? fields : parseFields(DEFAULT_HISTORY_FIELDS);
}

/**
 * assertions[].snapshot.candidate(応答のマスク済みコピー全体)を取り除いたエントリを返す。
 * 一覧や run 全体の表示では大きすぎるため省く。candidate を持たなければ元のエントリをそのまま返す。
 * 元のエントリは変異させない。
 */
function omitSnapshotCandidates(entry: HistoryEntry): HistoryEntry {
  if (!entry.assertions?.some((assertion) => assertion.snapshot?.candidate !== undefined)) {
    return entry;
  }
  return {
    ...entry,
    assertions: entry.assertions.map((assertion) => {
      if (assertion.snapshot?.candidate === undefined) return assertion;
      const { candidate: _candidate, ...snapshot } = assertion.snapshot;
      return { ...assertion, snapshot };
    }),
  };
}

/**
 * エントリから指定フィールドだけを取り出す。
 * "status" は旧エントリ(status フィールド無し)でも assertions から導出した値を返す。
 * 未知のフィールド名は undefined になる(JSON では省略、テキストでは空欄)。
 */
function pickFields(entry: HistoryEntry, fields: string[]): Record<string, unknown> {
  const source = entry as unknown as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    result[field] = field === "status" ? resolveHistoryEntryStatus(entry) : source[field];
  }
  return result;
}

/**
 * テキスト表の1セル分の値を文字列化する(オブジェクト/配列は compact JSON にする)。
 * flow/step 等は flow YAML の name 由来、request/response/assertions 等は外部サーバー由来で
 * いずれも攻撃者制御になり得るため、ここで一括してサニタイズする。renderTable は formatCell の
 * 返り値から列幅を計算するので、後段でサニタイズすると幅計算と実際の出力がずれてしまう
 * (このため sanitize はここでしか行わない)。
 */
function formatCell(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return sanitizeForTerminal(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return sanitizeForTerminal(JSON.stringify(value));
}

/** フィールド名をヘッダーにした簡易テキスト表(列は2スペース区切り、左寄せパディング)を組み立てる */
function renderTable(fields: string[], rows: Record<string, unknown>[]): string {
  const cells = rows.map((row) => fields.map((field) => formatCell(row[field])));
  const widths = fields.map((field, i) =>
    Math.max(field.length, ...cells.map((row) => row[i]?.length ?? 0)),
  );
  const lines = [fields.map((field, i) => field.padEnd(widths[i] as number)).join("  ")];
  for (const row of cells) {
    lines.push(
      row
        .map((value, i) => value.padEnd(widths[i] as number))
        .join("  ")
        .trimEnd(),
    );
  }
  return lines.join("\n");
}

/**
 * klaus history(一覧)本体。
 * flow / failed / last(取得件数)でフィルタし、fields で選択した列のみ出力する。
 * 出力モードは run コマンドと同じ TTY 判定規約: --json または非 TTY なら JSON(compact)、
 * TTY なら簡潔なテキスト表。
 */
export async function historyListCommand(
  options: HistoryListOptions,
  cwd: string = process.cwd(),
): Promise<number> {
  const useJson = isJsonOutputMode(options.json);
  const fields = parseFields(options.fields);

  const page = await getHistoryPage(cwd, {
    flow: options.flow,
    limit: options.last,
    failed: options.failed || undefined,
  });
  // 一覧では --fields assertions を選んでも snapshot の candidate は出さない(全文は history show --step で見る)
  const rows = page.entries.map((entry) => pickFields(omitSnapshotCandidates(entry), fields));

  if (useJson) {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
  } else {
    process.stdout.write(`${renderTable(fields, rows)}\n`);
  }

  return 0;
}

/**
 * klaus history show 本体。
 * 指定 runId(必要なら step でも)に一致する履歴エントリを、保存されたまま(マスク済)の形で
 * 実行順(startedAt 昇順)に JSON(compact)出力する。ただしスナップショットの candidate(応答の全文コピー)は
 * --step で 1 ステップに絞ったときだけ含め、run 全体を出すときは省く。TTY 判定はせず常に JSON を出す
 * (単一 run のフル詳細を参照する用途で、エージェント・人間どちらでも同じ形式で扱えるようにするため)。
 * 該当エントリが無い場合は stderr にメッセージを出して 1 を返す。
 */
export async function historyShowCommand(
  runId: string,
  options: HistoryShowOptions,
  cwd: string = process.cwd(),
): Promise<number> {
  const allEntries = await readAllHistoryEntries(cwd);
  const entries = allEntries
    .filter((entry) => entry.runId === runId)
    .filter((entry) => !options.step || entry.step === options.step)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  if (entries.length === 0) {
    const stepSuffix = options.step ? ` (step "${options.step}")` : "";
    process.stderr.write(`klaus: no history entries found for runId "${runId}"${stepSuffix}\n`);
    return 1;
  }

  const output = options.step ? entries : entries.map(omitSnapshotCandidates);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}
