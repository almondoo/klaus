import Ajv2020 from "ajv/dist/2020";
import { JSONPath } from "jsonpath-plus";
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
function compileUserRegex(pattern: string): RegExp {
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
): void {
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
      actual: resolvedValue,
      message: ok
        ? `${subject} equals expected value`
        : `${subject}: expected ${JSON.stringify(matchers.equals)} but got ${JSON.stringify(resolvedValue)}`,
    });
  }
  if (matchers.contains !== undefined) {
    const actualStr = stringifyForMatch(resolvedValue);
    const ok = resolvedExists && actualStr.includes(matchers.contains);
    results.push({
      ok,
      kind: `${kindPrefix}.contains`,
      expected: matchers.contains,
      actual: actualStr,
      message: ok
        ? `${subject} contains "${matchers.contains}"`
        : `${subject}: expected to contain "${matchers.contains}" but got "${actualStr}"`,
    });
  }
  if (matchers.regex !== undefined) {
    const actualStr = stringifyForMatch(resolvedValue);
    const regex = precompiledRegex ?? compileUserRegex(matchers.regex);
    const ok = resolvedExists && regex.test(actualStr);
    results.push({
      ok,
      kind: `${kindPrefix}.regex`,
      expected: matchers.regex,
      actual: actualStr,
      message: ok
        ? `${subject} matches /${matchers.regex}/`
        : `${subject}: expected to match /${matchers.regex}/ but got "${actualStr}"`,
    });
  }
}

/** status アサーション */
export function assertStatus(
  expected: number | undefined,
  actualStatus: number,
): AssertionResult[] {
  if (expected === undefined) return [];
  const ok = actualStatus === expected;
  return [
    {
      ok,
      kind: "status",
      expected,
      actual: actualStatus,
      message: ok
        ? `status is ${actualStatus}`
        : `expected status ${expected} but got ${actualStatus}`,
    },
  ];
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
    pushMatchResults(results, "header", `header "${def.name}"`, def, exists, value);
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
