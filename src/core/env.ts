import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { KlausError, ParseError } from "./errors.js";
import { loadEnvironmentFile } from "./loader.js";
import type { Environment } from "./schema.js";

/**
 * envDir/`${envName}.yaml` の解決結果が envDir の外を指していないか検証する。
 * envName に `..` やセパレータ・絶対パスが含まれる場合に検知する(path traversal 防止。
 * UI サーバー経由では env がリクエストボディ由来の untrusted 入力になるため必須)。
 * ファイルシステムへアクセスする前に必ず呼び出すこと。
 */
function assertWithinEnvironmentsDir(envDir: string, resolvedPath: string, envName: string): void {
  const boundary = envDir.endsWith(sep) ? envDir : envDir + sep;
  if (!resolvedPath.startsWith(boundary)) {
    throw new ParseError(
      `invalid environment name (resolves outside the environments dir): ${envName}`,
    );
  }
}

/**
 * cwd から上方探索で environments/<name>.yaml を解決する。
 * - cwd から順に親ディレクトリへ辿り、各ディレクトリ直下の environments/<name>.yaml の
 *   存在を確認する。見つかった時点でそのパスを返す。
 * - 探索の上限(境界)は「`.git` エントリを含む最初の祖先ディレクトリ(そのディレクトリ自身は
 *   含めて調べたうえで打ち切る)」または「ファイルシステムのルート」のいずれか先に到達した方。
 *   すなわちリポジトリルートを跨いで探索することはない。
 * - 各候補ディレクトリについて、ファイルシステムへアクセスする前に必ず path traversal の
 *   境界チェックを行う。envName が不正な場合はその時点で ParseError を投げ、以降の探索は
 *   一切行わない(untrusted な envName でファイルシステムを探査させないため)。
 * - どの祖先ディレクトリにもファイルが見つからなかった場合は、cwd 基準のパス(従来の
 *   挙動と同じ join(cwd, "environments", `${envName}.yaml")` 相当)をそのまま返す。
 *   これにより「ファイルが見つからない」場合のエラーは loadEnvironment 側の
 *   従来どおりの挙動になる。
 */
export function resolveEnvironmentPath(cwd: string, envName: string): string {
  const startDir = resolve(cwd);
  let dir = startDir;
  let cwdBasedPath = "";

  while (true) {
    const envDir = join(dir, "environments");
    const candidatePath = resolve(envDir, `${envName}.yaml`);
    assertWithinEnvironmentsDir(envDir, candidatePath, envName);
    if (dir === startDir) {
      cwdBasedPath = candidatePath;
    }

    if (existsSync(candidatePath)) {
      return candidatePath;
    }
    if (existsSync(join(dir, ".git"))) {
      break;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return cwdBasedPath;
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

/**
 * 指定した環境ファイルが存在しない場合に投げるエラー。
 * UI サーバー側で 404 に変換できるよう、ParseError(パース失敗)とは別の種別として区別する。
 * 新規 env ファイルの作成はスコープ外のため、saveEnvironment は既存ファイルの更新のみ行う。
 */
export class EnvironmentNotFoundError extends KlausError {
  readonly envName: string;

  constructor(envName: string) {
    super(`environment not found: ${envName}`);
    this.name = "EnvironmentNotFoundError";
    this.envName = envName;
  }
}

/**
 * environments/<envName>.yaml へ values を書き戻す。
 * - yaml パッケージの Document API(parseDocument)でキー単位に set / delete することで、
 *   既存のコメント・書式を保持する(全置換の stringify は使わない)。
 * - values に無い既存キーは削除し、values にあるキーは追加・更新する。
 * - 対象ファイルが存在しない場合は EnvironmentNotFoundError を投げる(新規作成はスコープ外)。
 */
export async function saveEnvironment(
  cwd: string,
  envName: string,
  values: Record<string, string>,
): Promise<void> {
  const path = resolveEnvironmentPath(cwd, envName);
  if (!existsSync(path)) {
    throw new EnvironmentNotFoundError(envName);
  }

  const content = await readFile(path, "utf-8");
  const doc = parseDocument(content);

  const existing = (doc.toJSON() as Record<string, unknown> | null) ?? {};
  for (const key of Object.keys(existing)) {
    if (!(key in values)) {
      doc.delete(key);
    }
  }
  for (const [key, value] of Object.entries(values)) {
    doc.set(key, value);
  }

  await writeFile(path, doc.toString(), "utf-8");
}
