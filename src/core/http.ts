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
 * リクエストを送信し、ボディまで読み切って返す。
 * 接続不能・タイムアウトは RuntimeError にして投げる。
 */
export async function sendRequest(options: HttpRequestOptions): Promise<HttpResponse> {
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

    const bodyText = await response.body.text();
    const durationMs = performance.now() - startedAt;

    const contentType = response.headers["content-type"];
    const isJson = typeof contentType === "string" && contentType.includes("application/json");
    let parsedBody: unknown = bodyText;
    if (isJson && bodyText.length > 0) {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        // JSON として壊れている場合はテキストのまま扱う
        parsedBody = bodyText;
      }
    }

    return {
      status: response.statusCode,
      headers: normalizeHeaders(response.headers),
      body: parsedBody,
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
