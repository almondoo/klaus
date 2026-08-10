/**
 * GET /api/environments 系のロジック。
 * - listEnvironments: environments/*.yaml の名前一覧を返す
 * - handleGetEnvironmentDetail / handlePutEnvironment: 1環境の内容取得・更新
 */
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "hono";
import { toTemplateVariables } from "../../core/env.js";
import {
  captureValues,
  EnvironmentNotFoundError,
  loadEnvironmentFile,
  RuntimeError,
  resolveEnvironmentPath,
  saveEnvironment,
} from "../../core/index.js";
import { parseJsonBody } from "../json-body.js";
import type {
  EnvironmentCaptureRequestBody,
  EnvironmentDetail,
  EnvironmentListEntry,
  EnvironmentUpdateRequestBody,
} from "../types.js";

const YAML_EXT = ".yaml";

// env 名は environments/<name>.yaml に展開されるため、パス区切り・親参照を含む値は拒否する
// (URL パラメータ由来の untrusted 入力。runs.ts / request.ts の env 検証と同一パターンのため export して共有する)
export const ENV_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/** env 名が ENV_NAME_PATTERN に一致しない場合、拒否レスポンス(403)を返す(一致すれば null) */
function invalidEnvNameResponse(c: Context, name: string): Response | null {
  if (ENV_NAME_PATTERN.test(name)) return null;
  return c.text("Forbidden: invalid environment name", 403);
}

/**
 * environments/<name>.yaml のパスを解決する。ファイルが存在しない場合は 404 レスポンスを返す
 * (存在すれば解決済みパスを返す)。
 */
function resolveExistingEnvironmentPath(c: Context, cwd: string, name: string): string | Response {
  const path = resolveEnvironmentPath(cwd, name);
  if (!existsSync(path)) {
    return c.json({ error: `environment not found: ${name}` }, 404);
  }
  return path;
}

/** environments/*.yaml の名前一覧を返す(ディレクトリが無ければ空配列) */
export async function listEnvironments(cwd: string): Promise<EnvironmentListEntry[]> {
  const dir = join(cwd, "environments");
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(YAML_EXT))
    .map((entry) => ({ name: entry.name.slice(0, -YAML_EXT.length) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** GET /api/environments/:name: 環境ファイル1件の内容を返す */
export async function handleGetEnvironmentDetail(
  c: Context,
  cwd: string,
  name: string,
): Promise<Response> {
  const invalidName = invalidEnvNameResponse(c, name);
  if (invalidName) return invalidName;

  const path = resolveExistingEnvironmentPath(c, cwd, name);
  if (path instanceof Response) return path;

  const environment = await loadEnvironmentFile(path);
  // $protected は予約キー(boolean)であり、UI の環境エディタは全行を編集行として往復させるため、
  // そのまま返すと無関係なキーの編集でも保存 PUT が values の型検証(string map)で 400 になる。
  // ここで除外し、UI からは常に不可視・不変(ファイル直接編集専用)にする。
  const values = toTemplateVariables(environment);
  const detail: EnvironmentDetail = { name, values };
  return c.json(detail);
}

/** PUT /api/environments/:name: 環境ファイル1件の内容を更新する */
export async function handlePutEnvironment(
  c: Context,
  cwd: string,
  name: string,
): Promise<Response> {
  const invalidName = invalidEnvNameResponse(c, name);
  if (invalidName) return invalidName;

  const body = await parseJsonBody<EnvironmentUpdateRequestBody>(c);
  if (body === undefined) {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (
    !body ||
    typeof body.values !== "object" ||
    body.values === null ||
    Array.isArray(body.values)
  ) {
    return c.json({ error: "values is required" }, 400);
  }
  for (const value of Object.values(body.values)) {
    if (typeof value !== "string") {
      return c.json({ error: "values must be a map of string to string" }, 400);
    }
  }
  // $protected は予約キー。GET では values から除外して返しているため、クライアントが
  // それを含めて送ってくるのは異常系(壊れたクライアント/意図的な改ざん)のみ。
  // API 経由での編集は許可せず、ファイル直接編集のみを正としてここで拒否する。
  if (Object.hasOwn(body.values, "$protected")) {
    return c.json({ error: "$protected is a reserved key and cannot be edited via this API" }, 400);
  }

  try {
    await saveEnvironment(cwd, name, body.values);
  } catch (error) {
    if (error instanceof EnvironmentNotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    throw error;
  }

  const detail: EnvironmentDetail = { name, values: body.values };
  return c.json(detail);
}

/**
 * 抽出値(JSONPath の評価結果)を environmentSchema(Record<string,string>)へ保存できる
 * 文字列に変換する。string/number/boolean はプリミティブとして文字列化するが、
 * object・array・null は情報が失われる/意図しない文字列化("[object Object]" 等)になるため拒否する。
 * (captureValues は undefined を既に RuntimeError として弾いているのでここには来ない)
 */
function stringifyCapturedValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/**
 * POST /api/environments/:name/capture: 単発リクエストのレスポンスボディから JSONPath で値を
 * 抽出し、指定 env の1キーへアトミックに保存する(抽出→保存を1リクエストで完結させ、
 * クライアント側での GET→PUT read-modify-write レースを避けるための事後操作エンドポイント)。
 * 該当キー以外の既存値は変更しない。
 */
export async function handlePostEnvironmentCapture(
  c: Context,
  cwd: string,
  name: string,
): Promise<Response> {
  const invalidName = invalidEnvNameResponse(c, name);
  if (invalidName) return invalidName;

  const body = await parseJsonBody<EnvironmentCaptureRequestBody>(c);
  if (body === undefined) {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body.key !== "string" || body.key.trim() === "") {
    return c.json({ error: "key is required" }, 400);
  }
  if (typeof body.path !== "string") {
    return c.json({ error: "path is required" }, 400);
  }

  let captured: Record<string, unknown>;
  try {
    captured = captureValues({ [body.key]: body.path }, body.json, "(capture)");
  } catch (error) {
    if (error instanceof RuntimeError) {
      return c.json({ error: error.message }, 400);
    }
    throw error;
  }

  const stringValue = stringifyCapturedValue(captured[body.key]);
  if (stringValue === undefined) {
    return c.json(
      {
        error: `cannot save the extracted value as an environment variable (objects, arrays, and null are not supported): key="${body.key}"`,
      },
      400,
    );
  }

  const path = resolveExistingEnvironmentPath(c, cwd, name);
  if (path instanceof Response) return path;
  const existing = await loadEnvironmentFile(path);
  const values: Record<string, string> = { ...existing, [body.key]: stringValue };

  try {
    await saveEnvironment(cwd, name, values);
  } catch (error) {
    if (error instanceof EnvironmentNotFoundError) {
      return c.json({ error: error.message }, 404);
    }
    throw error;
  }

  const detail: EnvironmentDetail = { name, values };
  return c.json(detail);
}
