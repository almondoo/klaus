/**
 * klaus_history_show の path 引数のための、厳格な最小のパス指定(JSONPath のごく一部だけ)。
 *
 * JSONPath のライブラリは使わない。再帰下降(`$..a..a..a`)は入れ子の深い履歴エントリでヒープを使い果たしたり
 * イベントループを長時間止めたりし、フィルター・スクリプト式(`[?()]` / `[()]`)は動的な評価を持ち込むため、
 * 受け付ける構文そのものを次の 4 つに限る:
 * - `$`                 : ルート
 * - `.name`             : 識別子(英数字・`_`・`-`。先頭は英字か `_`)で指すキー
 * - `['name']` / `["name"]` : 引用符つきのキー(`\\` `\'` `\"` `\n` `\t` のエスケープ)
 * - `[n]`               : 配列の添字(0 以上の整数)
 * 結果は 0 個か 1 個の値。ワイルドカード・スライス・和集合・フィルター・再帰下降は構文として拒否する。
 */

export type PathSegment = string | number;

/** path が受け付ける構文ではないときのエラー */
export class InvalidPathError extends Error {
  constructor(path: string) {
    const shown = path.length > 80 ? `${path.slice(0, 80)}...` : path;
    super(
      `invalid path "${shown}": supported forms are $, .name, ['name'] or ["name"], and [n] (a non-negative index); recursive descent, wildcards, slices, unions, filters and script expressions are not supported`,
    );
    this.name = "InvalidPathError";
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_-]*/;
const INDEX = /^(0|[1-9][0-9]{0,8})\]/;
const ESCAPES: Record<string, string> = { "\\": "\\", "'": "'", '"': '"', n: "\n", t: "\t" };

/** path を区切りに分解する。構文に合わなければ InvalidPathError */
export function parseHistoryPath(path: string): PathSegment[] {
  if (!path.startsWith("$")) throw new InvalidPathError(path);
  const segments: PathSegment[] = [];
  let position = 1;
  while (position < path.length) {
    const rest = path.slice(position);
    if (rest.startsWith(".")) {
      const match = IDENTIFIER.exec(rest.slice(1));
      if (match === null) throw new InvalidPathError(path);
      segments.push(match[0]);
      position += 1 + match[0].length;
      continue;
    }
    if (rest.startsWith("[")) {
      const quote = rest[1];
      if (quote === "'" || quote === '"') {
        let key = "";
        let index = 2;
        for (;;) {
          const char = rest[index];
          if (char === undefined) throw new InvalidPathError(path);
          if (char === quote) break;
          if (char === "\\") {
            const escaped = ESCAPES[rest[index + 1] ?? ""];
            if (escaped === undefined) throw new InvalidPathError(path);
            key += escaped;
            index += 2;
            continue;
          }
          key += char;
          index += 1;
        }
        // 閉じ引用符の直後は `]` でなければならない(`['a','b']` のような和集合はここで拒否される)
        if (rest[index + 1] !== "]") throw new InvalidPathError(path);
        segments.push(key);
        position += index + 2;
        continue;
      }
      const match = INDEX.exec(rest.slice(1));
      if (match === null) throw new InvalidPathError(path);
      segments.push(Number(match[1]));
      position += 1 + match[0].length;
      continue;
    }
    throw new InvalidPathError(path);
  }
  return segments;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * segments が指す値を取り出す。見つからなければ found: false。
 * 継承されたプロパティ(`__proto__` / `constructor` など)・配列の `length`・文字列の文字には到達しない。
 */
export function selectHistoryPath(
  root: unknown,
  segments: PathSegment[],
): { found: true; value: unknown } | { found: false } {
  let current = root;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return { found: false };
      current = current[segment];
      continue;
    }
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) return { found: false };
    current = current[segment];
  }
  return { found: true, value: current };
}
