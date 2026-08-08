import { join, resolve, sep } from "node:path";
import { ParseError } from "./errors.js";
import { loadEnvironmentFile } from "./loader.js";
import type { Environment } from "./schema.js";

/**
 * cwd 基準で environments/<name>.yaml を解決する。
 * envName に `..` やセパレータ・絶対パスが含まれ、解決結果が environments/ の外を
 * 指す場合は ParseError を投げる(path traversal 防止。UI サーバー経由では env が
 * リクエストボディ由来の untrusted 入力になるため必須)。
 */
export function resolveEnvironmentPath(cwd: string, envName: string): string {
  const envDir = join(cwd, "environments");
  const resolvedPath = resolve(envDir, `${envName}.yaml`);
  const boundary = envDir.endsWith(sep) ? envDir : envDir + sep;
  if (!resolvedPath.startsWith(boundary)) {
    throw new ParseError(`環境名が不正です(パスの外側を指しています): ${envName}`);
  }
  return resolvedPath;
}

/**
 * 環境ファイルを読み込む。
 * - envNameOverride が指定されればそれを優先し、未指定ならフロー定義の env を使う
 * - どちらも未指定なら空の環境(変数なし)を返す
 */
export async function loadEnvironment(
  cwd: string,
  flowEnvName: string | undefined,
  envNameOverride?: string,
): Promise<Environment> {
  const envName = envNameOverride ?? flowEnvName;
  if (!envName) {
    return {};
  }
  const path = resolveEnvironmentPath(cwd, envName);
  return loadEnvironmentFile(path);
}
