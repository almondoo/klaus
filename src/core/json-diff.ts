/**
 * JSON 値の構造 diff(依存なしの純粋関数)。
 * 実行履歴の run 同士の比較(klaus diff)でレスポンス body の差分を列挙するために使う。
 * - 差分は {path, kind, before, after} のリスト。path は JSONPath 風("$.items[0].name")
 * - オブジェクトはキーで突き合わせ(キー順の違いは差分にしない)、配列はインデックスで突き合わせる(順序依存)
 * - 型が違う場合は type-changed を1件だけ報告し、配下は辿らない
 * - 除外パス(揮発する id・タイムスタンプ等)は parseJsonPathPattern で解釈したパターンで指定する
 */

export type JsonDifferenceKind = "added" | "removed" | "changed" | "type-changed" | "too-deep";

export interface JsonDifference {
  path: string;
  kind: JsonDifferenceKind;
  /** added / too-deep では省略 */
  before?: unknown;
  /** removed / too-deep では省略 */
  after?: unknown;
}

type PathSegment = string | number;

/** 除外パターンに含められる `..`(任意の深さ)の最大個数と式の最大長(病的なパターンによる負荷の抑制) */
export const MAX_DESCENDANT_OPERATORS = 2;
const MAX_PATTERN_LENGTH = 256;
/** この深さを超えるノードは、パスを追わずに等価判定だけを行い、異なれば too-deep の差分を1件報告する */
const MAX_COMPARE_DEPTH = 256;
/** 差分に載せる値(before / after)の最大の入れ子の深さ。超える値は文字列に置き換える */
const MAX_VALUE_DEPTH = 100;
const TOO_DEEP_VALUE = "[too deep to display]";

type PatternSegment =
  | { type: "key"; name: string }
  | { type: "index"; index: number }
  | { type: "wildcard" }
  | { type: "descendant" };

/** 除外パスとして解釈済みの JSONPath 風パターン。parseJsonPathPattern で作る */
export interface JsonPathPattern {
  /** 元の式(エラーメッセージ・表示用) */
  source: string;
  segments: PatternSegment[];
}

type JsonType = "null" | "array" | "object" | "string" | "number" | "boolean" | "undefined";

function jsonTypeOf(value: unknown): JsonType {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** パスセグメント列を JSONPath 風の文字列("$.a[0]['b-c']")にする */
export function formatJsonPath(segments: readonly PathSegment[]): string {
  let result = "$";
  for (const segment of segments) {
    if (typeof segment === "number") {
      result += `[${segment}]`;
    } else if (IDENTIFIER.test(segment)) {
      result += `.${segment}`;
    } else {
      result += `['${segment.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
    }
  }
  return result;
}

/**
 * 除外パスの式を解釈する。対応する構文(JSONPath のごく一部):
 * `$`、`.name`、`['name']` / `["name"]`、`[0]`、`.*` / `[*]`、`..name`(任意の深さ)。
 * 解釈できない式は undefined を返す(呼び出し側が引数エラーにする)。
 */
export function parseJsonPathPattern(source: string): JsonPathPattern | undefined {
  if (!source.startsWith("$") || source.length > MAX_PATTERN_LENGTH) return undefined;
  const segments: PatternSegment[] = [];
  let descendants = 0;
  let i = 1;
  while (i < source.length) {
    const char = source[i];
    if (char === ".") {
      if (source[i + 1] === ".") {
        // `..` の直後は名前・* ・[ のいずれかが必要
        descendants += 1;
        if (descendants > MAX_DESCENDANT_OPERATORS) return undefined;
        segments.push({ type: "descendant" });
        i += 2;
        if (i >= source.length) return undefined;
        if (source[i] === "[") continue;
      } else {
        i += 1;
      }
      let end = i;
      while (end < source.length && source[end] !== "." && source[end] !== "[") end += 1;
      const name = source.slice(i, end);
      if (name === "") return undefined;
      segments.push(name === "*" ? { type: "wildcard" } : { type: "key", name });
      i = end;
    } else if (char === "[") {
      const closing = findBracketEnd(source, i);
      if (closing === undefined) return undefined;
      const inner = source.slice(i + 1, closing);
      i = closing + 1;
      if (inner === "*") {
        segments.push({ type: "wildcard" });
      } else if (/^\d+$/.test(inner)) {
        segments.push({ type: "index", index: Number.parseInt(inner, 10) });
      } else {
        const quote = inner[0];
        if ((quote !== "'" && quote !== '"') || inner.length < 2 || inner.at(-1) !== quote) {
          return undefined;
        }
        segments.push({
          type: "key",
          name: inner.slice(1, -1).replace(/\\(.)/g, "$1"),
        });
      }
    } else {
      return undefined;
    }
  }
  // 末尾が descendant のままのパターンは無効(`$..` のみ等)
  if (segments.at(-1)?.type === "descendant") return undefined;
  return { source, segments };
}

/** `[` の対応する `]` の位置を返す(クォート内の `]` は無視)。無ければ undefined */
function findBracketEnd(source: string, start: number): number | undefined {
  let quote: string | undefined;
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "]") {
      return i;
    }
  }
  return undefined;
}

function matchSegment(pattern: PatternSegment, actual: PathSegment): boolean {
  switch (pattern.type) {
    case "key":
      return typeof actual === "string" && actual === pattern.name;
    case "index":
      return typeof actual === "number" && actual === pattern.index;
    case "wildcard":
      return true;
    default:
      return false;
  }
}

/** パターンとパスの一致判定。(patternIndex, pathIndex) ごとにメモ化し、`..` が複数あっても多項式時間で終わる */
function matchPattern(segments: readonly PatternSegment[], path: readonly PathSegment[]): boolean {
  const memo = new Map<number, boolean>();
  const width = path.length + 1;
  const match = (patternIndex: number, pathIndex: number): boolean => {
    if (patternIndex === segments.length) return pathIndex === path.length;
    const key = patternIndex * width + pathIndex;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const segment = segments[patternIndex] as PatternSegment;
    let result = false;
    if (segment.type === "descendant") {
      const next = segments[patternIndex + 1] as PatternSegment;
      for (let k = pathIndex; k < path.length && !result; k++) {
        result = matchSegment(next, path[k] as PathSegment) && match(patternIndex + 2, k + 1);
      }
    } else {
      result =
        pathIndex < path.length &&
        matchSegment(segment, path[pathIndex] as PathSegment) &&
        match(patternIndex + 1, pathIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

/** パスを親ポインタで持つ(階層ごとに配列をコピーしないため) */
interface PathNode {
  parent: PathNode | undefined;
  segment: PathSegment;
  depth: number;
}

function pathOf(node: PathNode | undefined): PathSegment[] {
  const segments: PathSegment[] = [];
  for (let current = node; current; current = current.parent) segments.push(current.segment);
  return segments.reverse();
}

export interface DiffJsonOptions {
  /** 差分から除外するパス。一致したノードは配下も含めて比較しない */
  ignorePaths?: readonly JsonPathPattern[];
}

/** 値の入れ子が max を超えるか(反復で数えるためスタックを消費しない) */
export function exceedsDepth(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop() as [unknown, number];
    if (current === null || typeof current !== "object") continue;
    if (depth >= max) return true;
    for (const child of Array.isArray(current) ? current : Object.values(current)) {
      stack.push([child, depth + 1]);
    }
  }
  return false;
}

function displayValue(value: unknown): unknown {
  return exceedsDepth(value, MAX_VALUE_DEPTH) ? TOO_DEEP_VALUE : value;
}

/** 反復による深い等価判定(キー順は無視)。深すぎるサブツリーの比較に使う */
function deepEqual(a: unknown, b: unknown): boolean {
  const stack: Array<[unknown, unknown]> = [[a, b]];
  while (stack.length > 0) {
    const [x, y] = stack.pop() as [unknown, unknown];
    const typeX = jsonTypeOf(x);
    if (typeX !== jsonTypeOf(y)) return false;
    if (typeX === "array") {
      const left = x as unknown[];
      const right = y as unknown[];
      if (left.length !== right.length) return false;
      for (let i = 0; i < left.length; i++) stack.push([left[i], right[i]]);
    } else if (typeX === "object") {
      const left = x as Record<string, unknown>;
      const right = y as Record<string, unknown>;
      const keys = Object.keys(left);
      if (keys.length !== Object.keys(right).length) return false;
      for (const key of keys) {
        if (!Object.hasOwn(right, key)) return false;
        stack.push([left[key], right[key]]);
      }
    } else if (x !== y) {
      return false;
    }
  }
  return true;
}

type Task =
  | { op: "walk"; before: unknown; after: unknown; node: PathNode | undefined }
  | { op: "added"; after: unknown; node: PathNode }
  | { op: "removed"; before: unknown; node: PathNode };

/**
 * before と after の構造差分を、出現順(オブジェクトは before のキー順 → after にだけあるキー順、配列はインデックス順)
 * で返す。差が無ければ空配列。root が undefined の場合は「存在しない」として added / removed になる。
 * 反復(明示スタック)で走査するため、深い入れ子でもスタックを溢れさせない。入れ子が深すぎるサブツリー
 * (256 階層超)は等価判定だけを行い、異なれば too-deep の差分を1件返す。
 */
export function diffJson(
  before: unknown,
  after: unknown,
  options: DiffJsonOptions = {},
): JsonDifference[] {
  const ignore = options.ignorePaths ?? [];
  const out: JsonDifference[] = [];
  const isIgnored = (node: PathNode | undefined): boolean => {
    if (ignore.length === 0) return false;
    const path = pathOf(node);
    return ignore.some((pattern) => matchPattern(pattern.segments, path));
  };

  const stack: Task[] = [{ op: "walk", before, after, node: undefined }];
  while (stack.length > 0) {
    const task = stack.pop() as Task;
    if (isIgnored(task.node)) continue;
    const path = () => formatJsonPath(pathOf(task.node));

    if (task.op === "added") {
      out.push({ path: path(), kind: "added", after: displayValue(task.after) });
      continue;
    }
    if (task.op === "removed") {
      out.push({ path: path(), kind: "removed", before: displayValue(task.before) });
      continue;
    }

    const left = task.before;
    const right = task.after;
    const beforeType = jsonTypeOf(left);
    const afterType = jsonTypeOf(right);

    if (beforeType === "undefined" || afterType === "undefined") {
      if (beforeType !== afterType) {
        out.push(
          beforeType === "undefined"
            ? { path: path(), kind: "added", after: displayValue(right) }
            : { path: path(), kind: "removed", before: displayValue(left) },
        );
      }
      continue;
    }
    if (beforeType !== afterType) {
      out.push({
        path: path(),
        kind: "type-changed",
        before: displayValue(left),
        after: displayValue(right),
      });
      continue;
    }
    if (beforeType !== "array" && beforeType !== "object") {
      if (left !== right) {
        out.push({ path: path(), kind: "changed", before: left, after: right });
      }
      continue;
    }

    const depth = task.node?.depth ?? 0;
    if (depth >= MAX_COMPARE_DEPTH) {
      if (!deepEqual(left, right)) out.push({ path: path(), kind: "too-deep" });
      continue;
    }

    const children: Task[] = [];
    const child = (segment: PathSegment): PathNode => ({
      parent: task.node,
      segment,
      depth: depth + 1,
    });
    if (beforeType === "array") {
      const l = left as unknown[];
      const r = right as unknown[];
      for (let i = 0; i < Math.max(l.length, r.length); i++) {
        if (i >= l.length) children.push({ op: "added", after: r[i], node: child(i) });
        else if (i >= r.length) children.push({ op: "removed", before: l[i], node: child(i) });
        else children.push({ op: "walk", before: l[i], after: r[i], node: child(i) });
      }
    } else {
      const l = left as Record<string, unknown>;
      const r = right as Record<string, unknown>;
      for (const key of Object.keys(l)) {
        if (Object.hasOwn(r, key)) {
          children.push({ op: "walk", before: l[key], after: r[key], node: child(key) });
        } else {
          children.push({ op: "removed", before: l[key], node: child(key) });
        }
      }
      for (const key of Object.keys(r)) {
        if (!Object.hasOwn(l, key)) children.push({ op: "added", after: r[key], node: child(key) });
      }
    }
    // スタックは後入れ先出しなので、出現順を保つため逆順に積む
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as Task);
  }
  return out;
}
