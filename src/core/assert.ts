import Ajv2020 from "ajv/dist/2020";
import { JSONPath } from "jsonpath-plus";
import { maskCookieRequestHeader, maskSetCookieHeader } from "./cookie-jar.js";
import type {
  AssertDef,
  BodyAssertion,
  BodyTextAssertion,
  DurationAssertion,
  EventAssertion,
  EventCountAssertion,
  HeaderAssertion,
  MessageAssertion,
  MessageCountAssertion,
} from "./schema.js";
import type { AssertionResult, SseEvent, WsMessage } from "./types.js";

/**
 * assertBodySchema 専用の Ajv インスタンス。呼び出しごとに new Ajv2020() すると
 * コンパイルコストが毎回かかるため、モジュールレベルで1つだけ生成して使い回す。
 * オプションは従来 assertBodySchema 内で生成していたものと同一にする。
 */
const ajv = new Ajv2020({ allErrors: true, strict: false });

/**
 * ユーザー定義(フロー YAML の assert マッチャー・CLI 変数注入)由来の regex パターンをコンパイルする唯一の箇所。
 * CodeQL の js/regex-injection alert をこの 1 箇所に集約するため、ユーザー入力を new RegExp に渡すコードは
 * 必ずこの関数を経由すること(新たな構築箇所を作ると新規 alert が発生する)。
 *
 * パターンの由来はフロー YAML への直書きに限らない。assert の値はテンプレート展開されるため、
 * capture(検証対象 API のレスポンスから埋まる値)や --var 経由でも渡り得る。とくに capture 経由の場合は
 * パターン自体を検証対象 API 側が実質的に選べることになる(--var は CLI 実行者が与える値なので該当しない)。
 * いずれも可用性(評価のハングアップ)にのみ影響する既知のリスクとして許容している
 * (docs/guide/flow-definition.md の regex 節を参照)。
 */
export function compileUserRegex(pattern: string): RegExp {
  return new RegExp(pattern);
}

/**
 * スキーマオブジェクトの参照をキーにコンパイル済み validator をキャッシュする。
 * 同じ schema オブジェクトに対する複数回のアサーション評価(例: リトライ・複数レスポンスでの再利用)で
 * 再コンパイルを避ける。コンパイル失敗時はキャッシュしない(呼び出し元でエラーメッセージ化するのみ)。
 */
const compiledSchemaCache = new WeakMap<Record<string, unknown>, ReturnType<Ajv2020["compile"]>>();

function compileBodySchema(schema: Record<string, unknown>): ReturnType<Ajv2020["compile"]> {
  const cached = compiledSchemaCache.get(schema);
  if (cached) return cached;
  const validate = ajv.compile(schema);
  compiledSchemaCache.set(schema, validate);
  return validate;
}

/**
 * アサーション評価に使う入力値一式。
 * runner.ts がリクエスト実行結果から組み立てて渡す。
 */
export interface AssertionContext {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
  durationMs: number;
  events?: SseEvent[];
  messages?: WsMessage[];
}

/** SSE イベント・WS メッセージのどちらも満たす最小の形。件数系・個別要素系アサーションのロジック共有に使う */
interface DataItem {
  data: string;
}

// 以下2つの型は Zod スキーマ(schema.ts)由来のオブジェクトをそのまま受け取る。
// Zod の .optional() フィールドは値が明示的に undefined になり得るため、
// exactOptionalPropertyTypes 対応として "| undefined" を明示する。

/** 個別要素アサーション(SSE の event / WS の message)に共通のフィールド形状 */
interface ItemAssertionDef {
  index?: number | undefined;
  path?: string | undefined;
  exists?: boolean | undefined;
  equals?: unknown;
  contains?: string | undefined;
  regex?: string | undefined;
}

interface MatchOptions {
  equals?: unknown;
  contains?: string | undefined;
  regex?: string | undefined;
  exists?: boolean | undefined;
  gt?: number | undefined;
  gte?: number | undefined;
  lt?: number | undefined;
  lte?: number | undefined;
  length?: number | { min?: number | undefined; max?: number | undefined } | undefined;
  type?: JsonTypeName | undefined;
  oneOf?: unknown[] | undefined;
}

type JsonTypeName = "string" | "number" | "integer" | "boolean" | "null" | "array" | "object";

/** 値の JSON 型名(integer は number の部分集合として type: number にも一致させる) */
function matchesJsonType(value: unknown, type: JsonTypeName): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

/** 数値比較の対象値。header は常に文字列なので numericStrings 指定時だけ数値文字列を数値として扱う */
function numericValue(value: unknown, numericStrings: boolean): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // 10 進数の表記(符号・小数点つき)だけを数値とみなす。Number() が受け付ける 0x10(16 進)・0b1・
  // 1e3(指数)・Infinity などは、ヘッダー値としては数値のつもりで書かれないため数値に含めない
  if (
    numericStrings &&
    typeof value === "string" &&
    /^[+-]?(\d+\.?\d*|\.\d+)$/.test(value.trim())
  ) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** 構造的な等価比較(JSON 値用) */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** contains / regex マッチング用に値を文字列化する */
function stringifyForMatch(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

/**
 * 1つの対象(header 1件 / body path 1件 等)に対して、指定されたマッチャー(exists/equals/contains/regex)
 * それぞれを個別の AssertionResult として積む。
 */
function pushMatchResults(
  results: AssertionResult[],
  kindPrefix: string,
  subject: string,
  matchers: MatchOptions,
  resolvedExists: boolean,
  resolvedValue: unknown,
  /**
   * regex マッチャーを事前コンパイル済みの RegExp で渡したい場合に指定する。
   * 未指定時は従来どおり matchers.regex から都度 new RegExp する(assertItems の
   * 要素ループのように同一 def を何度も評価する呼び出し元だけが、ループの外でコンパイルして渡す)。
   */
  precompiledRegex?: RegExp,
  /** header のように値が常に文字列になる対象で、gt/gte/lt/lte に数値文字列を許す */
  numericStrings = false,
  /**
   * 実際の値を結果の actual / message に載せるときの表示用変換(Cookie / Set-Cookie ヘッダー用)。
   * 比較には常に生の値を使い、保存・出力される actual と message だけを変換後の値にする
   */
  maskDisplay?: (value: string) => string,
): void {
  // 結果に載せる値(文字列のときだけ表示用に変換する)
  const shown = (value: unknown): unknown =>
    maskDisplay !== undefined && typeof value === "string" ? maskDisplay(value) : value;
  if (matchers.exists !== undefined) {
    const ok = resolvedExists === matchers.exists;
    results.push({
      ok,
      kind: `${kindPrefix}.exists`,
      expected: matchers.exists,
      actual: resolvedExists,
      message: ok
        ? `${subject} exists=${matchers.exists}`
        : `${subject}: expected exists=${matchers.exists} but got ${resolvedExists}`,
    });
  }
  if (matchers.equals !== undefined) {
    const ok = resolvedExists && deepEqual(resolvedValue, matchers.equals);
    results.push({
      ok,
      kind: `${kindPrefix}.equals`,
      expected: matchers.equals,
      actual: shown(resolvedValue),
      message: ok
        ? `${subject} equals expected value`
        : `${subject}: expected ${JSON.stringify(matchers.equals)} but got ${JSON.stringify(shown(resolvedValue))}`,
    });
  }
  if (matchers.contains !== undefined) {
    const actualStr = stringifyForMatch(resolvedValue);
    const shownStr = stringifyForMatch(shown(resolvedValue));
    const ok = resolvedExists && actualStr.includes(matchers.contains);
    results.push({
      ok,
      kind: `${kindPrefix}.contains`,
      expected: matchers.contains,
      actual: shownStr,
      message: ok
        ? `${subject} contains "${matchers.contains}"`
        : `${subject}: expected to contain "${matchers.contains}" but got "${shownStr}"`,
    });
  }
  if (matchers.regex !== undefined) {
    const actualStr = stringifyForMatch(resolvedValue);
    const shownStr = stringifyForMatch(shown(resolvedValue));
    const regex = precompiledRegex ?? compileUserRegex(matchers.regex);
    const ok = resolvedExists && regex.test(actualStr);
    results.push({
      ok,
      kind: `${kindPrefix}.regex`,
      expected: matchers.regex,
      actual: shownStr,
      message: ok
        ? `${subject} matches /${matchers.regex}/`
        : `${subject}: expected to match /${matchers.regex}/ but got "${shownStr}"`,
    });
  }
  const comparisons = [
    ["gt", matchers.gt, (a: number, b: number) => a > b, ">"],
    ["gte", matchers.gte, (a: number, b: number) => a >= b, ">="],
    ["lt", matchers.lt, (a: number, b: number) => a < b, "<"],
    ["lte", matchers.lte, (a: number, b: number) => a <= b, "<="],
  ] as const;
  for (const [key, limit, compare, symbol] of comparisons) {
    if (limit === undefined) continue;
    const actual = numericValue(resolvedValue, numericStrings);
    const ok = resolvedExists && actual !== undefined && compare(actual, limit);
    results.push({
      ok,
      kind: `${kindPrefix}.${key}`,
      expected: limit,
      actual: shown(resolvedValue),
      message: ok
        ? `${subject} ${actual} ${symbol} ${limit}`
        : `${subject}: expected a number ${symbol} ${limit} but got ${JSON.stringify(shown(resolvedValue))}`,
    });
  }
  if (matchers.length !== undefined) {
    const range =
      typeof matchers.length === "number"
        ? { min: matchers.length, max: matchers.length }
        : matchers.length;
    const size =
      typeof resolvedValue === "string" || Array.isArray(resolvedValue)
        ? resolvedValue.length
        : undefined;
    const ok =
      resolvedExists &&
      size !== undefined &&
      (range.min === undefined || size >= range.min) &&
      (range.max === undefined || size <= range.max);
    const expectedText =
      typeof matchers.length === "number" ? `${matchers.length}` : JSON.stringify(matchers.length);
    results.push({
      ok,
      kind: `${kindPrefix}.length`,
      expected: matchers.length,
      actual: size,
      message: ok
        ? `${subject} length ${size} matches ${expectedText}`
        : size === undefined
          ? `${subject}: length applies to strings and arrays but the value is ${describeType(resolvedExists, resolvedValue)}`
          : `${subject}: expected length ${expectedText} but got ${size}`,
    });
  }
  if (matchers.type !== undefined) {
    const ok = resolvedExists && matchesJsonType(resolvedValue, matchers.type);
    results.push({
      ok,
      kind: `${kindPrefix}.type`,
      expected: matchers.type,
      actual: describeType(resolvedExists, resolvedValue),
      message: ok
        ? `${subject} is ${matchers.type}`
        : `${subject}: expected type ${matchers.type} but got ${describeType(resolvedExists, resolvedValue)}`,
    });
  }
  if (matchers.oneOf !== undefined) {
    const ok =
      resolvedExists && matchers.oneOf.some((candidate) => deepEqual(resolvedValue, candidate));
    results.push({
      ok,
      kind: `${kindPrefix}.oneOf`,
      expected: matchers.oneOf,
      actual: shown(resolvedValue),
      message: ok
        ? `${subject} is one of the expected values`
        : `${subject}: expected one of ${JSON.stringify(matchers.oneOf)} but got ${JSON.stringify(shown(resolvedValue))}`,
    });
  }
}

/** メッセージ用の型名(存在しない値は "missing") */
function describeType(exists: boolean, value: unknown): string {
  if (!exists) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** status の期待値(数値 / 数値の配列 / "2xx" 形式)に実際のステータスが合うか */
function statusMatches(expected: number | number[] | string, actual: number): boolean {
  if (typeof expected === "number") return actual === expected;
  if (Array.isArray(expected)) return expected.includes(actual);
  return Math.floor(actual / 100) === Number(expected[0]);
}

/** status アサーション */
export function assertStatus(
  expected: number | number[] | string | undefined,
  actualStatus: number,
): AssertionResult[] {
  if (expected === undefined) return [];
  const ok = statusMatches(expected, actualStatus);
  const expectedText = Array.isArray(expected) ? `one of [${expected.join(", ")}]` : `${expected}`;
  return [
    {
      ok,
      kind: "status",
      expected,
      actual: actualStatus,
      message: ok
        ? `status is ${actualStatus}`
        : `expected status ${expectedText} but got ${actualStatus}`,
    },
  ];
}

/**
 * header アサーションの結果に載せる値を位置でマスクする関数(Cookie / Set-Cookie だけ)。
 * 値は自由文字列として actual / message に入り、maskDeep(ヘッダーオブジェクトの構造で判定する)では
 * 見えないため、アサーションの評価時点で変換しておく。比較そのものは生の値で行う。
 */
function cookieDisplayMask(headerName: string): ((value: string) => string) | undefined {
  const lower = headerName.toLowerCase();
  if (lower === "cookie") return maskCookieRequestHeader;
  if (lower === "set-cookie") return maskSetCookieHeader;
  return undefined;
}

/** header アサーション(ヘッダー名は大文字小文字を無視) */
export function assertHeaders(
  defs: HeaderAssertion[] | undefined,
  headers: Record<string, string>,
): AssertionResult[] {
  if (!defs) return [];
  const results: AssertionResult[] = [];
  const lowerHeaders = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  for (const def of defs) {
    const value = lowerHeaders.get(def.name.toLowerCase());
    const exists = value !== undefined;
    pushMatchResults(
      results,
      "header",
      `header "${def.name}"`,
      def,
      exists,
      value,
      undefined,
      true,
      cookieDisplayMask(def.name),
    );
  }
  return results;
}

/** jsonpath 評価を安全に行う(不正な path・非対応の json 形状でも例外を投げない) */
function safeJsonPath(path: string, json: unknown): { exists: boolean; value: unknown } {
  try {
    const value = JSONPath({ path, json: json as never, wrap: false });
    return { exists: value !== undefined, value };
  } catch {
    return { exists: false, value: undefined };
  }
}

/** body(JSON)に対する jsonpath ベースのアサーション */
export function assertBody(defs: BodyAssertion[] | undefined, json: unknown): AssertionResult[] {
  if (!defs) return [];
  const results: AssertionResult[] = [];
  for (const def of defs) {
    const { exists, value } = safeJsonPath(def.path, json);
    pushMatchResults(results, "body", `body path "${def.path}"`, def, exists, value);
  }
  return results;
}

/**
 * body(JSON)に対する JSON Schema(draft 2020-12)ベースのアサーション。
 * ajv のコンパイル・検証は例外を投げず、失敗時は ok:false の AssertionResult として返す。
 * 検証失敗時は違反ごとに個別の AssertionResult を返す(複数違反の一括報告)。
 */
export function assertBodySchema(
  schema: Record<string, unknown> | undefined,
  body: unknown,
): AssertionResult[] {
  if (!schema) return [];
  if (body === undefined) {
    return [
      {
        ok: false,
        kind: "bodySchema",
        message: "bodySchema assertion requires a JSON body, but the response has none",
      },
    ];
  }

  let validate: ReturnType<Ajv2020["compile"]>;
  try {
    validate = compileBodySchema(schema);
  } catch (err) {
    return [
      {
        ok: false,
        kind: "bodySchema",
        message: `invalid JSON Schema: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  const ok = validate(body);
  if (ok) {
    return [
      {
        ok: true,
        kind: "bodySchema",
        message: "body matches JSON Schema",
      },
    ];
  }

  return (validate.errors ?? []).map((error) => {
    const instancePath = error.instancePath || "(root)";
    return {
      ok: false,
      kind: "bodySchema",
      expected: error.params,
      actual: error.data,
      message: `${instancePath} ${error.message ?? "does not match schema"}`,
    };
  });
}

/** 生テキストに対するアサーション */
export function assertBodyText(
  def: BodyTextAssertion | undefined,
  bodyText: string,
): AssertionResult[] {
  if (!def) return [];
  const results: AssertionResult[] = [];
  pushMatchResults(results, "bodyText", "body text", def, true, bodyText);
  return results;
}

/** 所要時間に対するアサーション */
export function assertDuration(
  def: DurationAssertion | undefined,
  durationMs: number,
): AssertionResult[] {
  if (!def) return [];
  const ok = durationMs <= def.maxMs;
  return [
    {
      ok,
      kind: "duration",
      expected: def.maxMs,
      actual: durationMs,
      message: ok
        ? `duration ${durationMs}ms <= ${def.maxMs}ms`
        : `expected duration <= ${def.maxMs}ms but got ${durationMs}ms`,
    },
  ];
}

/**
 * 受信件数(SSE イベント数 / WS メッセージ数)に対するアサーションの共通ロジック。
 * assertEventCount / assertMessageCount はこれの薄いラッパー。
 */
function assertItemCount(
  def:
    | { min?: number | undefined; max?: number | undefined; equals?: number | undefined }
    | undefined,
  items: DataItem[],
  kindPrefix: string,
  subject: string,
): AssertionResult[] {
  if (!def) return [];
  const results: AssertionResult[] = [];
  const count = items.length;
  if (def.equals !== undefined) {
    const ok = count === def.equals;
    results.push({
      ok,
      kind: `${kindPrefix}.equals`,
      expected: def.equals,
      actual: count,
      message: ok
        ? `${subject} count is ${count}`
        : `expected ${subject} count ${def.equals} but got ${count}`,
    });
  }
  if (def.min !== undefined) {
    const ok = count >= def.min;
    results.push({
      ok,
      kind: `${kindPrefix}.min`,
      expected: def.min,
      actual: count,
      message: ok
        ? `${subject} count ${count} >= ${def.min}`
        : `expected ${subject} count >= ${def.min} but got ${count}`,
    });
  }
  if (def.max !== undefined) {
    const ok = count <= def.max;
    results.push({
      ok,
      kind: `${kindPrefix}.max`,
      expected: def.max,
      actual: count,
      message: ok
        ? `${subject} count ${count} <= ${def.max}`
        : `expected ${subject} count <= ${def.max} but got ${count}`,
    });
  }
  return results;
}

/** SSE 受信イベント数に対するアサーション */
export function assertEventCount(
  def: EventCountAssertion | undefined,
  events: SseEvent[],
): AssertionResult[] {
  return assertItemCount(def, events, "eventCount", "event");
}

/** WS 受信メッセージ数に対するアサーション。セマンティクスは assertEventCount と同一 */
export function assertMessageCount(
  def: MessageCountAssertion | undefined,
  messages: WsMessage[],
): AssertionResult[] {
  return assertItemCount(def, messages, "messageCount", "message");
}

/** item.data を path があれば JSON parse して jsonpath 適用、なければ生文字列を返す */
function resolveItemValue(
  item: DataItem,
  path: string | undefined,
): { exists: boolean; value: unknown } {
  if (!path) {
    return { exists: true, value: item.data };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.data);
  } catch {
    return { exists: false, value: undefined };
  }
  return safeJsonPath(path, parsed);
}

/**
 * SSE 個別イベント / WS 個別メッセージに対するアサーションの共通ロジック。
 * index 指定時はその1件のみ、未指定時はいずれかの要素が一致すれば pass とする。
 * assertEvents / assertMessages はこれの薄いラッパー。
 */
function assertItems(
  defs: ItemAssertionDef[] | undefined,
  items: DataItem[],
  kindPrefix: string,
  subjectNoun: string,
): AssertionResult[] {
  if (!defs) return [];
  const results: AssertionResult[] = [];

  for (const def of defs) {
    if (def.index !== undefined) {
      const target = items[def.index];
      const subject = `${subjectNoun}[${def.index}]${def.path ? ` path "${def.path}"` : ""}`;
      if (!target) {
        pushMatchResults(results, kindPrefix, subject, def, false, undefined);
        continue;
      }
      const { exists, value } = resolveItemValue(target, def.path);
      pushMatchResults(results, kindPrefix, subject, def, exists, value);
      continue;
    }

    // index 未指定: いずれかの要素がマッチャーを満たせば pass
    const matcherKeys = ["exists", "equals", "contains", "regex"] as const;
    for (const key of matcherKeys) {
      const expected = def[key];
      if (expected === undefined) continue;
      // regex は items 件数分 new RegExp するとイベント/メッセージ数に比例してコストがかかるため、
      // ループの外で1回だけコンパイルして使い回す
      const precompiledRegex = key === "regex" ? compileUserRegex(expected as string) : undefined;
      let anyOk = false;
      for (const item of items) {
        const { exists, value } = resolveItemValue(item, def.path);
        const tmp: AssertionResult[] = [];
        pushMatchResults(
          tmp,
          kindPrefix,
          subjectNoun,
          { [key]: expected } as MatchOptions,
          exists,
          value,
          precompiledRegex,
        );
        if (tmp[0]?.ok) {
          anyOk = true;
          break;
        }
      }
      const subject = `any ${subjectNoun}${def.path ? ` path "${def.path}"` : ""}`;
      results.push({
        ok: anyOk,
        kind: `${kindPrefix}.${key}`,
        expected,
        actual: anyOk ? "matched" : `no match among ${items.length} ${subjectNoun}s`,
        message: anyOk
          ? `${subject}: at least one ${subjectNoun} matches ${key}`
          : `${subject}: no ${subjectNoun} matched ${key}=${JSON.stringify(expected)} (checked ${items.length} ${subjectNoun}s)`,
      });
    }
  }

  return results;
}

/**
 * SSE 個別イベントに対するアサーション。
 * index 指定時はそのイベントのみ、未指定時はいずれかのイベントが一致すれば pass とする。
 */
export function assertEvents(
  defs: EventAssertion[] | undefined,
  events: SseEvent[],
): AssertionResult[] {
  return assertItems(defs, events, "event", "event");
}

/** WS 個別メッセージに対するアサーション。セマンティクスは assertEvents と同一 */
export function assertMessages(
  defs: MessageAssertion[] | undefined,
  messages: WsMessage[],
): AssertionResult[] {
  return assertItems(defs, messages, "message", "message");
}

/** ステップの assert 定義全体を評価する。例外は投げない */
export function evaluateAssertions(
  def: AssertDef | undefined,
  context: AssertionContext,
): AssertionResult[] {
  if (!def) return [];
  return [
    ...assertStatus(def.status, context.status),
    ...assertHeaders(def.headers, context.headers),
    ...assertBody(def.body, context.body),
    ...assertBodySchema(def.bodySchema, context.body),
    ...assertBodyText(def.bodyText, context.bodyText),
    ...assertDuration(def.duration, context.durationMs),
    ...assertEventCount(def.eventCount, context.events ?? []),
    ...assertEvents(def.events, context.events ?? []),
    ...assertMessageCount(def.messageCount, context.messages ?? []),
    ...assertMessages(def.messages, context.messages ?? []),
  ];
}
