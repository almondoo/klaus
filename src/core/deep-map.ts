/**
 * 任意の JSON 互換値を深く辿り、文字列だけを mapString で変換する汎用ウォーカー。
 * template.ts の renderDeep(テンプレート展開)と history.ts の maskDeep(シークレットマスク)が
 * 構造的に同一の再帰処理(文字列リーフの変換だけが異なる)を持っていたため、ここに切り出して共有する。
 * オブジェクト・配列はそのまま再帰し、数値・真偽値・null はそのまま返す。元の value は変異させない。
 */
export function mapDeepStrings<T>(value: T, mapString: (input: string) => string): T {
  if (typeof value === "string") {
    return mapString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => mapDeepStrings(item, mapString)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      result[key] = mapDeepStrings(v, mapString);
    }
    return result as unknown as T;
  }
  return value;
}
