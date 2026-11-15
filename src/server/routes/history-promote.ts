/**
 * POST /api/history/promote が使うロジック。
 * 履歴の run から「新規の」フロー YAML を生成する(dryRun ならプレビューのみ、そうでなければ新規ファイルとして書く)。
 * 生成ロジック自体は core の promoteRuns / renderPromotedYaml にしかない。既存フローの編集や上書きは一切行わない
 * (--force も --allow-template-literals も UI には無い)。
 */
import type { Context } from "hono";
import type { PromoteAssertMode } from "../../core/index.js";
import { parseJsonBody } from "../json-body.js";
import { promoteHistoryToFile } from "../promote-write.js";
import type { PromoteRequestBody } from "../types.js";
import { hasControlCharacter, RUN_ID_PATTERN } from "../validation.js";

/** 一度に連結できる run の最大数 */
export const MAX_PROMOTE_RUNS = 50;
const MAX_NAME_LENGTH = 128;
const MAX_FLOW_LENGTH = 256;
const MAX_BASE_URL_VAR_LENGTH = 64;
const ASSERT_MODES: readonly PromoteAssertMode[] = ["status", "schema", "values", "all"];
const ALLOWED_KEYS = new Set([
  "runIds",
  "flow",
  "assert",
  "baseUrlVar",
  "chain",
  "name",
  "out",
  "dryRun",
]);
const TEMPLATE_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface ValidBody {
  runIds: string[];
  flow?: string;
  assert: PromoteAssertMode;
  baseUrlVar?: string;
  chain: boolean;
  name?: string;
  out?: string;
  dryRun: boolean;
}

/** 本文を検証する。不正なら 400 用のメッセージを返す(未知のキー — force 等 — も拒否する) */
function validateBody(
  body: unknown,
): { ok: true; value: ValidBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "request body must be a JSON object" };
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) return { ok: false, error: `unknown field "${key}"` };
  }

  const { runIds } = raw;
  if (!Array.isArray(runIds) || runIds.length === 0) {
    return { ok: false, error: "runIds must be a non-empty array" };
  }
  if (runIds.length > MAX_PROMOTE_RUNS) {
    return { ok: false, error: `runIds can contain at most ${MAX_PROMOTE_RUNS} entries` };
  }
  for (const runId of runIds) {
    if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
      return { ok: false, error: "runIds must contain valid run IDs" };
    }
  }

  const optionalString = (key: string, max: number): string | undefined | null => {
    const value = raw[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length === 0 || value.length > max) return null;
    if (hasControlCharacter(value)) return null;
    return value;
  };
  const flow = optionalString("flow", MAX_FLOW_LENGTH);
  if (flow === null) return { ok: false, error: "flow is invalid" };
  const name = optionalString("name", MAX_NAME_LENGTH);
  if (name === null) return { ok: false, error: "name is invalid" };
  const baseUrlVar = optionalString("baseUrlVar", MAX_BASE_URL_VAR_LENGTH);
  if (
    baseUrlVar === null ||
    (baseUrlVar !== undefined && !TEMPLATE_VARIABLE_NAME.test(baseUrlVar))
  ) {
    return {
      ok: false,
      error: "baseUrlVar is invalid (expected letters, digits, and underscores)",
    };
  }
  // out の中身(cwd 外・予約名など)の検証は 403 の対象なので、ここでは型だけ確認する
  const out = raw.out;
  if (out !== undefined && typeof out !== "string") return { ok: false, error: "out is invalid" };

  const assert = raw.assert === undefined ? "schema" : raw.assert;
  if (typeof assert !== "string" || !ASSERT_MODES.includes(assert as PromoteAssertMode)) {
    return { ok: false, error: `assert must be one of ${ASSERT_MODES.join(", ")}` };
  }
  for (const key of ["chain", "dryRun"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
      return { ok: false, error: `${key} must be a boolean` };
    }
  }

  return {
    ok: true,
    value: {
      runIds: runIds as string[],
      ...(flow !== undefined ? { flow } : {}),
      assert: assert as PromoteAssertMode,
      ...(baseUrlVar !== undefined ? { baseUrlVar } : {}),
      chain: raw.chain !== false,
      ...(name !== undefined ? { name } : {}),
      ...(out !== undefined ? { out: out as string } : {}),
      dryRun: raw.dryRun === true,
    },
  };
}

/** POST /api/history/promote: 履歴からフローを生成する(dryRun: プレビュー / それ以外: 新規ファイルとして保存) */
export async function handleHistoryPromote(c: Context, cwd: string): Promise<Response> {
  const parsed = await parseJsonBody<PromoteRequestBody>(c);
  if (parsed === undefined) return c.json({ error: "invalid JSON body" }, 400);
  const validated = validateBody(parsed);
  if (!validated.ok) return c.json({ error: validated.error }, 400);
  const body = validated.value;

  // 生成・検証・書き込みは klaus mcp と共有する promoteHistoryToFile が行い、ここでは結果を HTTP の応答に写すだけにする
  const outcome = await promoteHistoryToFile(cwd, body);
  if (outcome.ok) return c.json(outcome.payload);
  switch (outcome.kind) {
    case "not-found":
      return c.json({ error: outcome.message }, 404);
    case "usage":
      return c.json({ error: outcome.message, kind: "usage" }, 400);
    case "content":
      return c.json(
        {
          error: outcome.message,
          kind: "content",
          ...(outcome.code !== undefined ? { code: outcome.code } : {}),
        },
        422,
      );
    case "forbidden":
      return c.text(outcome.message, 403);
    default:
      return c.json({ error: outcome.message }, 409);
  }
}
