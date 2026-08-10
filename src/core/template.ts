import { randomUUID } from "node:crypto";
import { mapDeepStrings } from "./deep-map.js";
import { RuntimeError } from "./errors.js";
import type { Environment } from "./schema.js";

/**
 * テンプレート変数解決に使うコンテキスト。
 * 解決順: ①ステップキャプチャ変数 ②環境ファイル変数。
 */
export interface TemplateContext {
  /** これまでのステップで capture した変数 */
  captures: Record<string, unknown>;
  /** 環境ファイル(environments/<name>.yaml)の変数 */
  env: Environment;
  /**
   * {{env.X}} で解決した値を収集する先(履歴に書き込む前のシークレットマスクに使う)。
   * 呼び出し元(runner)がフロー実行単位で1つ生成し、全ステップの TemplateContext に共有して渡す想定。
   * 未指定の場合は収集しない(単体テスト等で不要な場合に省略できる)。
   */
  secrets?: Set<string>;
}

const TEMPLATE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

/** テンプレート関数(引数なし)。値は評価のたびに再計算する */
const templateFunctions: Record<string, () => string> = {
  newUuid: () => randomUUID(),
  newDate: () => new Date().toISOString(),
  newTimestamp: () => String(Date.now()),
};

/** 値を文字列に変換する(オブジェクト・配列は JSON 文字列化) */
function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** 単一の変数名(env.X / newUuid 等を含む)を解決する。未解決は RuntimeError */
function resolveVariable(name: string, context: TemplateContext): string {
  if (name.startsWith("env.")) {
    const envKey = name.slice("env.".length);
    const value = process.env[envKey];
    if (value === undefined) {
      throw new RuntimeError(`OS environment variable "${envKey}" is not defined`);
    }
    // OS 環境変数はシークレットとして扱い、履歴マスク用に収集する
    context.secrets?.add(value);
    return value;
  }

  const fn = templateFunctions[name];
  if (fn) {
    return fn();
  }

  if (Object.hasOwn(context.captures, name)) {
    return stringifyValue(context.captures[name]);
  }

  if (Object.hasOwn(context.env, name)) {
    return stringifyValue(context.env[name]);
  }

  throw new RuntimeError(
    `template variable "${name}" could not be resolved (available: ${formatAvailableVariables(context)})`,
  );
}

/**
 * 未解決変数のエラーメッセージに添える「その時点で解決可能な変数名一覧」を作る。
 * 値そのものは絶対に含めない(キー名のみ。secrets の値漏えい防止)。
 * captures / env のどちらも空の場合は "none" と表示する。
 */
function formatAvailableVariables(context: TemplateContext): string {
  const envNames = Object.keys(context.env);
  const captureNames = Object.keys(context.captures);
  const parts: string[] = [];
  if (envNames.length > 0) {
    parts.push(`env: ${envNames.join(", ")}`);
  }
  if (captureNames.length > 0) {
    parts.push(`captures: ${captureNames.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "none";
}

/**
 * 文字列内の {{...}} をすべて展開する。
 * 値全体が単一の {{x}} の場合でも文字列に統一して返す(型保持はしない)。
 */
export function renderString(input: string, context: TemplateContext): string {
  return input.replace(TEMPLATE_PATTERN, (_match, rawName: string) => {
    return resolveVariable(rawName.trim(), context);
  });
}

/**
 * 任意の JSON 互換値(body など)を深く辿り、文字列だけをテンプレート展開する。
 * オブジェクト・配列はそのまま再帰し、数値・真偽値・null はそのまま返す。
 */
export function renderDeep<T>(value: T, context: TemplateContext): T {
  return mapDeepStrings(value, (s) => renderString(s, context));
}

/** Record<string,string>(headers 等)をテンプレート展開する */
export function renderHeaders(
  headers: Record<string, string> | undefined,
  context: TemplateContext,
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = renderString(value, context);
  }
  return result;
}
