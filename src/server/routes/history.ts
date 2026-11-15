/**
 * GET /api/history が使うロジック。
 * クエリロジック本体(ファイル読み出し・フィルタ・ページング)は core/history-query.ts に移設済み
 * (CLI の `klaus history` とも共有するため)。ここでは app.ts の HTTP ハンドラから使う形で再エクスポートする。
 */
import type { HistoryEntry, HistoryPage } from "../../core/index.js";

export type { GetHistoryQuery } from "../../core/index.js";
export { getHistoryPage } from "../../core/index.js";

/**
 * 履歴エントリから snapshot アサーションの承認用の候補(candidate)を取り除く。
 * candidate はマスク済みの応答全体のコピーで、一覧を大きくするだけでクライアントは使わない
 * (承認は POST /api/snapshots/accept がサーバー側の履歴から読む)。元のエントリは変更しない。
 */
export function stripSnapshotCandidates(entry: HistoryEntry): HistoryEntry {
  if (!entry.assertions.some((assertion) => assertion.snapshot?.candidate !== undefined)) {
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

/** ページ内の全エントリから candidate を取り除く */
export function stripPageCandidates(page: HistoryPage): HistoryPage {
  return { ...page, entries: page.entries.map(stripSnapshotCandidates) };
}
