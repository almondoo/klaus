/**
 * MCP ツールの結果の型と、結果(JSON テキスト)への直列化。
 * SDK には依存しない(server.ts が CallToolResult に写す)ので、単体でテストできる。
 */

/** 直列化した結果の上限(バイト)。これを超えると巨大な文字列・ボディを印に置き換えて JSON を保つ */
export const MAX_RESULT_BYTES = 256 * 1024;

/** 期待される失敗(検証エラー・安全柵の拒否・不明な runId・拒否されたパス・定義エラー)。isError の結果になる */
export interface ToolFailure {
  ok: false;
  error: string;
  /** core の ErrorCode(guard.* など)。該当するものがあるときだけ */
  errorCode?: string;
  /** エージェントが次に取るべき行動の案内 */
  hint?: string;
  /** 履歴から引ける runId(拒否も履歴に記録されるため) */
  runId?: string;
}

export type ToolOutcome = { ok: true; data: unknown } | ToolFailure;

/** ハンドラの内部から投げる、期待される失敗。tools.ts の境界で ToolFailure に変換される */
export class ToolError extends Error {
  readonly errorCode: string | undefined;
  readonly hint: string | undefined;

  constructor(message: string, options: { errorCode?: string; hint?: string } = {}) {
    super(message);
    this.name = "ToolError";
    this.errorCode = options.errorCode;
    this.hint = options.hint;
  }
}

export function toFailure(error: ToolError): ToolFailure {
  return {
    ok: false,
    error: error.message,
    ...(error.errorCode !== undefined ? { errorCode: error.errorCode } : {}),
    ...(error.hint !== undefined ? { hint: error.hint } : {}),
  };
}

/**
 * 切り詰めた値の代わりに入れる印。元のサイズと、全文の読み方を示す。
 * klaus_history_show は step と path(履歴エントリへの JSONPath。例 $.response.body)で値を選び、
 * 文字列の値は offset / length で区切って読める(これも切り詰めの対象外にならない大きさに収まる)。
 */
function truncationMarker(bytes: number): string {
  return `[truncated: ${bytes} bytes; read it with klaus_history_show: pass step and path (a JSONPath into the history entry, for example $.response.body) and, for a string value, offset and length to read it in windows; the stored record is also in .klaus/history]`;
}

/** 文字列の切り詰めを段階的に厳しくする閾値(バイト)。上から順に、収まるまで試す */
const TRUNCATION_LIMITS = [16 * 1024, 4 * 1024, 1024, 256];

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * limit バイトを超える文字列と、limit バイトを超える body(文字列以外の巨大な JSON)を印に置き換えた複製を返す。
 * 構造(キーの順序・配列の長さ)は保つ。元の値は変更しない。
 */
function truncateLargeValues(value: unknown, limit: number): unknown {
  if (typeof value === "string") {
    const bytes = byteLength(value);
    return bytes > limit ? truncationMarker(bytes) : value;
  }
  if (Array.isArray(value)) return value.map((item) => truncateLargeValues(item, limit));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "body" && child !== null && typeof child === "object") {
        const bytes = byteLength(JSON.stringify(child));
        if (bytes > limit) {
          result[key] = truncationMarker(bytes);
          continue;
        }
      }
      result[key] = truncateLargeValues(child, limit);
    }
    return result;
  }
  return value;
}

/**
 * 値を整形した JSON にし、maxBytes を超える場合は巨大な文字列・body から順に印へ置き換えて収める。
 * それでも収まらないとき(小さな要素が大量にある場合)は、切り詰めを知らせる小さな JSON に差し替える。
 * 返す文字列は常に有効な JSON。
 */
export function stringifyWithLimit(value: unknown, maxBytes: number = MAX_RESULT_BYTES): string {
  const full = JSON.stringify(value, null, 2);
  const originalBytes = byteLength(full);
  if (originalBytes <= maxBytes) return full;

  for (const limit of TRUNCATION_LIMITS) {
    const shrunk = truncateLargeValues(value, limit);
    const marked =
      shrunk !== null && typeof shrunk === "object" && !Array.isArray(shrunk)
        ? { ...(shrunk as Record<string, unknown>), resultTruncated: true }
        : shrunk;
    const text = JSON.stringify(marked, null, 2);
    if (byteLength(text) <= maxBytes) return text;
  }
  return JSON.stringify(
    {
      resultTruncated: true,
      originalBytes,
      message:
        "the result is too large to return; narrow the request (a smaller limit, a single step, or a single run)",
    },
    null,
    2,
  );
}

/** ツールの結果を、JSON テキストと isError の組にする */
export function serializeOutcome(
  outcome: ToolOutcome,
  maxBytes: number = MAX_RESULT_BYTES,
): { text: string; isError: boolean } {
  if (outcome.ok) return { text: stringifyWithLimit(outcome.data, maxBytes), isError: false };
  const { ok: _ok, ...failure } = outcome;
  return { text: stringifyWithLimit(failure, maxBytes), isError: true };
}
