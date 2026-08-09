/**
 * GET /api/history が使うロジック。
 * クエリロジック本体(ファイル読み出し・フィルタ・ページング)は core/history-query.ts に移設済み
 * (CLI の `klaus history` とも共有するため)。ここでは app.ts の HTTP ハンドラから使う形で再エクスポートする。
 */
export type { GetHistoryQuery } from "../../core/index.js";
export { getHistoryPage } from "../../core/index.js";
