/**
 * RequestEditor が使う純ロジック(key-value 行 → Record 変換、body テキストの解釈)。
 * DOM に依存しないため、コンポーネントテストなしでもここだけ単体テストできる。
 */

/** headers/query の1行編集分 */
export interface KeyValueRow {
  id: string;
  key: string;
  value: string;
}

/**
 * key-value 行の配列を Record<string, string> に変換する。
 * key が空(前後の空白のみを含む)の行は除外し、有効な行が1つも無ければ undefined を返す
 * (headers/query を省略してリクエストを送るため)。
 */
export function rowsToRecord(rows: KeyValueRow[]): Record<string, string> | undefined {
  const entries = rows
    .filter((row) => row.key.trim() !== "")
    .map((row) => [row.key, row.value] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * body 欄のテキストを送信用の値に変換する。
 * 空文字は undefined(body 省略)、JSON.parse に成功すればパース済みの値、
 * 失敗すれば入力文字列そのものを返す(仕様どおり)。
 */
export function parseRequestBody(text: string): unknown {
  if (text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
