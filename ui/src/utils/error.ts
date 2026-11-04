/** TanStack Query の error 値を表示用メッセージに変換する(未発生なら null) */
export function queryErrorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : error ? String(error) : null;
}
