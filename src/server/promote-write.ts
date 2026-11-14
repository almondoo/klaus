/**
 * POST /api/history/promote の出力先の検証と、新規ファイルの安全な書き込み。
 * 書き込み規則は src/cli/promote.ts(klaus promote)と同じ(cwd 内に限定・シンボリックリンクの拒否・
 * O_NOFOLLOW で開く)だが、UI には --force が無いので上書きは一切せず(O_EXCL)、既存ファイルは 409 にする。
 * CLI 側のコードは別担当のため共有化せず、同じ core のヘルパーを使ってここに重複実装している。
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { EXCLUDED_DISCOVERY_DIRS } from "../core/discovery.js";
import {
  findUnsafeSymlinkInWritePath,
  isPathWithinDir,
  isRealPathWithinDir,
  toDisplayPath,
} from "../core/index.js";
import { hasControlCharacter } from "./validation.js";

const MAX_OUT_LENGTH = 256;
const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);
/** 設定ファイルと同名のフローを作ると設定の読み込みが壊れるため、出力先にできないファイル名 */
const RESERVED_FILE_NAMES = new Set(["klaus.config.yaml", "klaus.config.yml"]);

export type OutputPathResult =
  | { ok: true; target: string; file: string }
  | { ok: false; status: 403; message: string };

/**
 * 出力先(cwd 相対)を検証し、絶対パスと表示用パスを返す。拒否はすべて 403(path / name rules)。
 * - cwd の外(絶対パス・.. ・リンク経由)は不可
 * - 拡張子は .yaml / .yml のみ
 * - 生成したフローが一覧に出るよう、フロー探索の対象外のディレクトリ(node_modules / .git / dist / .klaus /
 *   ui / environments / tmp)や、ドットで始まる要素の配下は不可。設定ファイル名も不可
 * - 途中・最終要素のシンボリックリンクの扱いは findUnsafeSymlinkInWritePath に従う
 */
export function resolvePromoteOutput(cwd: string, requested: string): OutputPathResult {
  const forbidden = (message: string): OutputPathResult => ({
    ok: false,
    status: 403,
    message: `Forbidden: ${message}`,
  });
  if (
    requested.length === 0 ||
    requested.length > MAX_OUT_LENGTH ||
    hasControlCharacter(requested)
  ) {
    return forbidden("invalid output path");
  }
  const resolvedCwd = resolve(cwd);
  const target = resolve(resolvedCwd, requested);
  if (
    target === resolvedCwd ||
    !isPathWithinDir(resolvedCwd, target) ||
    !isRealPathWithinDir(resolvedCwd, target)
  ) {
    return forbidden("path traversal detected");
  }
  const file = toDisplayPath(resolvedCwd, target);
  if (!YAML_EXTENSIONS.has(extname(target).toLowerCase())) {
    return forbidden(`output file must end with .yaml or .yml: "${file}"`);
  }
  const segments = file.split("/");
  const directories = segments.slice(0, -1);
  if (
    segments.some((segment) => segment.startsWith(".")) ||
    directories.some((segment) => EXCLUDED_DISCOVERY_DIRS.has(segment))
  ) {
    return forbidden(
      `output path "${file}" is in a directory that flow discovery skips or a hidden path; choose another location`,
    );
  }
  if (RESERVED_FILE_NAMES.has(basename(target).toLowerCase())) {
    return forbidden(`"${file}" is reserved for the klaus configuration`);
  }
  const unsafe = findUnsafeSymlinkInWritePath(resolvedCwd, target);
  if (unsafe) return forbidden(`refusing to write the output file: ${unsafe}`);
  return { ok: true, target, file };
}

/** 出力先に既に何か(ファイル・ディレクトリ・リンク)があるか */
export async function outputExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}

export type WriteResult = { ok: true } | { ok: false; status: 403 | 409; message: string };

/**
 * 新規ファイルとして書き込む。既存のものがあれば 409(上書きしない)。
 * 親ディレクトリは作成するが、作成後に実体が cwd 内であることを再確認する(検査と作成の間の差し替えを狭める)。
 */
export async function writeNewFile(
  cwd: string,
  target: string,
  file: string,
  content: string,
): Promise<WriteResult> {
  const resolvedCwd = resolve(cwd);
  try {
    await mkdir(dirname(target), { recursive: true });
    const realParent = await realpath(dirname(target));
    const realCwd = await realpath(resolvedCwd);
    if (!isPathWithinDir(realCwd, realParent)) {
      return { ok: false, status: 403, message: "Forbidden: path traversal detected" };
    }
    // O_EXCL: 既存(ファイル・ディレクトリ・リンク)は開かずに失敗する。O_NOFOLLOW: 最終要素がリンクなら辿らない
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o644,
    );
    try {
      await handle.writeFile(content, "utf-8");
    } finally {
      await handle.close();
    }
    return { ok: true };
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      return {
        ok: false,
        status: 409,
        message: `"${file}" already exists; existing files are never overwritten from the UI (choose another name or path)`,
      };
    }
    if (isErrno(error, "ELOOP")) {
      return {
        ok: false,
        status: 403,
        message: `Forbidden: refusing to write the output file: "${file}" is a symbolic link`,
      };
    }
    if (isErrno(error, "ENOTDIR") || isErrno(error, "ENOENT") || isErrno(error, "EISDIR")) {
      return {
        ok: false,
        status: 409,
        message: `cannot create "${file}": a parent path is not a usable directory`,
      };
    }
    throw error;
  }
}
