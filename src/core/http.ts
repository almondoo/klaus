import { type Dispatcher, request } from "undici";
import { RuntimeError } from "./errors.js";

/** リクエスト共通オプション */
export interface HttpRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/** 完全にボディを読み切ったレスポンス(通常の JSON / テキストリクエスト用) */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** content-type が JSON なら parse 済みの値、それ以外は文字列 */
  body: unknown;
  /** 常に取得できる生テキスト */
  bodyText: string;
  durationMs: number;
}

/** ヘッダーだけ読み込み、ボディはストリームのまま返すレスポンス(SSE 用) */
export interface RawHttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyStream: Dispatcher.ResponseData["body"];
  durationMs: number;
}

export const DEFAULT_TIMEOUT_MS = 30000;

/** body を送信可能な文字列に変換し、必要なら Content-Type を補う */
function prepareBody(
  body: unknown,
  headers: Record<string, string>,
): { requestBody: string | undefined; headers: Record<string, string> } {
  if (body === undefined) {
    return { requestBody: undefined, headers };
  }
  if (typeof body === "string") {
    return { requestBody: body, headers };
  }
  const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
  const nextHeaders = hasContentType ? headers : { ...headers, "Content-Type": "application/json" };
  return { requestBody: JSON.stringify(body), headers: nextHeaders };
}

function normalizeHeaders(headers: Dispatcher.ResponseData["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return result;
}

function toRuntimeError(
  error: unknown,
  aborted: boolean,
  timeoutMs: number,
  method: string,
  url: string,
): RuntimeError {
  if (aborted) {
    return new RuntimeError(`request timed out after ${timeoutMs}ms: ${method} ${url}`);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new RuntimeError(`request failed: ${method} ${url}: ${detail}`);
}

/**
 * content-type ヘッダーが JSON を示す場合のみ bodyText を JSON.parse し、それ以外・パース失敗時は
 * bodyText をそのまま返す(sendRequest・cassette.ts の cassetteEntryToHttpResponse で共有する判定)。
 * contentType は undici の生ヘッダー値(string | string[] | undefined)をそのまま受け取る。
 * 重複 Content-Type ヘッダーで配列になった場合は JSON とみなさない(HEAD の挙動を維持)。
 */
export function parseJsonBody(
  contentType: string | string[] | undefined,
  bodyText: string,
): unknown {
  const isJson = typeof contentType === "string" && contentType.includes("application/json");
  if (!isJson || bodyText.length === 0) return bodyText;
  try {
    return JSON.parse(bodyText);
  } catch {
    // JSON として壊れている場合はテキストのまま扱う
    return bodyText;
  }
}

/**
 * sendRequest / sendRawRequest 共通の下準備(timeoutMs 解決・body 準備・AbortController・タイマー起動・
 * リクエスト送信)を行う。接続不能時は timer を止めたうえで RuntimeError に変換して投げる。
 * タイマーの停止タイミング(ボディ読了後 or ヘッダー受信直後)は呼び出し元ごとに異なるため、
 * 成功時のタイマー停止はここでは行わず、返した timer を呼び出し元が管理する。
 */
async function performRequest(options: HttpRequestOptions): Promise<{
  response: Dispatcher.ResponseData;
  startedAt: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
}> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { requestBody, headers } = prepareBody(options.body, options.headers ?? {});

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = performance.now();
  try {
    // undici の RequestOptions.body は undefined を受け付けないため、
    // body が無い場合はキー自体を省略する(exactOptionalPropertyTypes 対応)
    const response = await request(options.url, {
      method: options.method as Dispatcher.HttpMethod,
      headers,
      signal: controller.signal,
      ...(requestBody !== undefined ? { body: requestBody } : {}),
    });
    return { response, startedAt, controller, timer, timeoutMs };
  } catch (error) {
    clearTimeout(timer);
    throw toRuntimeError(error, controller.signal.aborted, timeoutMs, options.method, options.url);
  }
}

/**
 * リクエストを送信し、ボディまで読み切って返す。
 * 接続不能・タイムアウトは RuntimeError にして投げる。
 */
export async function sendRequest(options: HttpRequestOptions): Promise<HttpResponse> {
  const { response, startedAt, controller, timer, timeoutMs } = await performRequest(options);

  try {
    const bodyText = await response.body.text();
    const durationMs = performance.now() - startedAt;
    const headers = normalizeHeaders(response.headers);
    // JSON 判定は正規化前の生ヘッダー値で行う(重複 Content-Type ヘッダーは配列になり JSON とみなさない)
    const body = parseJsonBody(response.headers["content-type"], bodyText);

    return {
      status: response.statusCode,
      headers,
      body,
      bodyText,
      durationMs,
    };
  } catch (error) {
    throw toRuntimeError(error, controller.signal.aborted, timeoutMs, options.method, options.url);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * リクエストを送信し、ヘッダー受信時点で返す(ボディはストリームのまま)。
 * SSE 受信のために sse.ts から使う。
 */
export async function sendRawRequest(options: HttpRequestOptions): Promise<RawHttpResponse> {
  const { response, startedAt, controller, timer, timeoutMs } = await performRequest(options);

  try {
    const durationMs = performance.now() - startedAt;
    clearTimeout(timer);

    return {
      status: response.statusCode,
      headers: normalizeHeaders(response.headers),
      bodyStream: response.body,
      durationMs,
    };
  } catch (error) {
    clearTimeout(timer);
    throw toRuntimeError(error, controller.signal.aborted, timeoutMs, options.method, options.url);
  }
}
