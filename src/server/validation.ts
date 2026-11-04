/**
 * server の各ルートで共有する入力検証と、その拒否レスポンスのヘルパー。
 * 拒否メッセージ・ステータスコードは既存の API 契約どおりに固定する(呼び出し元ごとに文言が異なるものは別関数にする)。
 */
import { resolve } from "node:path";
import type { Context } from "hono";
import { RESERVED_ENV_KEY } from "../core/env.js";
import { isPathWithinDir, isRealPathWithinDir } from "../core/index.js";

// env 名は environments/<name>.yaml に展開されるため、パス区切り・親参照を含む値は拒否する
// (URL パラメータ・リクエストボディ由来の untrusted 入力。environments.ts / runs.ts / request.ts で共有する)
export const ENV_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * 与えられた相対パスを cwd 基準で正規化解決する。
 * 解決結果が cwd の外を指す場合(path traversal・絶対パス注入)は null を返す。
 */
export function resolveWithinCwd(cwd: string, relPath: string): string | null {
  const resolvedPath = resolve(cwd, relPath);
  // 境界判定は core/path-guard.ts の isPathWithinDir に委譲する(env.ts・loader.ts と同じロジックを共有する)。
  // 加えて isRealPathWithinDir でシンボリックリンク解決後の実パスも検証し、cwd 配下に仕込まれた
  // シンボリックリンク経由で境界外を読み出す攻撃を防ぐ
  if (!isPathWithinDir(cwd, resolvedPath) || !isRealPathWithinDir(cwd, resolvedPath)) return null;
  return resolvedPath;
}

/** パスが cwd 外へ解決された場合の拒否レスポンス(403) */
export function pathTraversalResponse(c: Context): Response {
  return c.text("Forbidden: path traversal detected", 403);
}

/** URL パラメータの env 名(environments/:name)が ENV_NAME_PATTERN に一致しない場合、拒否レスポンス(403)を返す(一致すれば null) */
export function invalidEnvironmentNameResponse(c: Context, name: string): Response | null {
  if (ENV_NAME_PATTERN.test(name)) return null;
  return c.text("Forbidden: invalid environment name", 403);
}

/** リクエストボディの任意項目 env が指定され、かつ ENV_NAME_PATTERN に一致しない場合、拒否レスポンス(403)を返す(それ以外は null) */
export function invalidOptionalEnvResponse(c: Context, env: string | undefined): Response | null {
  if (env === undefined || ENV_NAME_PATTERN.test(env)) return null;
  return c.text("Forbidden: invalid env name", 403);
}

/** 予約キー($protected)を API 経由で編集しようとした場合の拒否レスポンス(400) */
export function reservedEnvKeyResponse(c: Context): Response {
  return c.json(
    { error: `${RESERVED_ENV_KEY} is a reserved key and cannot be edited via this API` },
    400,
  );
}
