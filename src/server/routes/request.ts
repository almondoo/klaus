/**
 * POST /api/request が使うロジック。
 * フロー定義ファイルを介さず、単一のリクエスト定義を実行する(UI の単発実行機能向け)。
 * 実行・履歴書き込み・シークレットマスクのロジック自体は core (executeSingleRequest) にしかない
 * (ここでは再実装しない)。runs.ts と異なり同期 JSON レスポンスで返す(SSE は使わない)。
 */
import type { Context } from "hono";
import { executeSingleRequest, formatZodError } from "../../core/index.js";
import { requestSchema } from "../../core/schema.js";
import { parseJsonBody } from "../json-body.js";
import type { SingleRequestRequestBody, SingleRequestResultPayload } from "../types.js";
import { ENV_NAME_PATTERN } from "./environments.js";

/** POST /api/request: 単一のリクエスト定義を実行し、同期 JSON で { result } を返す */
export async function handleSingleRequest(c: Context, cwd: string): Promise<Response> {
  const body = await parseJsonBody<SingleRequestRequestBody>(c);
  if (body === undefined) {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "request is required" }, 400);
  }

  // env は environments/<name>.yaml に展開されるため、パス区切り・親参照を含む値を拒否する
  // (env はリクエストボディ由来の untrusted 入力。runs.ts の検証と同じ方針)
  if (body.env !== undefined && !ENV_NAME_PATTERN.test(body.env)) {
    return c.text("Forbidden: invalid env name", 403);
  }

  const parsed = requestSchema.safeParse(body.request);
  if (!parsed.success) {
    return c.json({ error: formatZodError(parsed.error) }, 400);
  }

  const { result } = await executeSingleRequest({
    request: body.request,
    cwd,
    envName: body.env,
    history: true,
  });

  const payload: SingleRequestResultPayload = { result };
  return c.json(payload);
}
