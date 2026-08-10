/**
 * リクエストボディを JSON としてパースする共通ヘルパー。
 * environments/request/runs の各ハンドラで同一の try/catch が重複していたため、ここへ集約する。
 */
import type { Context } from "hono";

/**
 * c.req.json() を試み、JSON として不正な場合は undefined を返す。
 * エラーレスポンス(400 "invalid JSON body")の組み立ては呼び出し側で行う(status/body はハンドラごとに揃える)。
 */
export async function parseJsonBody<T>(c: Context): Promise<T | undefined> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return undefined;
  }
}
