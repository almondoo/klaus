/**
 * POST /api/history/promote の出力先の検証と、新規ファイルの安全な書き込み。
 * 書き込み規則は src/cli/promote.ts(klaus promote)と同じ(cwd 内に限定・シンボリックリンクの拒否・
 * O_NOFOLLOW で開く)だが、UI には --force が無いので上書きは一切せず(O_EXCL)、既存ファイルは 409 にする。
 * CLI 側のコードは別担当のため共有化せず、同じ core のヘルパーを使ってここに重複実装している。
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { discoverFlowCandidates, EXCLUDED_DISCOVERY_DIRS } from "../core/discovery.js";
import {
  findUnsafeSymlinkInWritePath,
  isPathWithinDir,
  isRealPathWithinDir,
  toDisplayPath,
} from "../core/index.js";
import { hasControlCharacter } from "./validation.js";

const MAX_OUT_LENGTH = 256;
const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);
/** 設定ファイルと同名のフローを作ると設定の読み込みが壊れるため、出力先にできないファイル名(比較は foldName 後) */
const RESERVED_FILE_NAMES = new Set(["klaus.config.yaml", "klaus.config.yml"]);
/** 既定の保存先ディレクトリ(配下のサブディレクトリも可)。フローがまだ無いプロジェクトでも保存できるようにする */
const DEFAULT_OUTPUT_DIRS = ["api", "flows"];

/** パス要素の比較用の正規化: Unicode NFC にして小文字化する(大文字小文字・合成形の違いを同一視する FS への対策) */
function foldName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** フロー探索の対象外ディレクトリ(foldName 済み) */
const EXCLUDED_DIRS_FOLDED = new Set([...EXCLUDED_DISCOVERY_DIRS].map(foldName));

/** 隠しディレクトリ・フロー探索の対象外ディレクトリに当たる要素があるか(要素は foldName で比較する) */
function hasForbiddenSegment(segments: readonly string[], includeLast: boolean): boolean {
  const checked = includeLast ? segments : segments.slice(0, -1);
  return (
    segments.some((segment) => segment.startsWith(".")) ||
    checked.some((segment) => EXCLUDED_DIRS_FOLDED.has(foldName(segment)))
  );
}

export type OutputPathResult =
  | { ok: true; target: string; file: string }
  | { ok: false; status: 403; message: string };

/**
 * 実在する最も深い祖先ディレクトリの実パスを、cwd の実パスからの相対要素にして返す(cwd 外なら undefined)。
 * 大文字小文字を区別しないファイルシステムで、`Node_Modules` のように別表記で指した既存ディレクトリの
 * 実際の名前(node_modules)を取り出して再検査するために使う。
 */
async function realAncestorSegments(cwd: string, target: string): Promise<string[] | undefined> {
  let dir = dirname(target);
  for (;;) {
    try {
      const real = await realpath(dir);
      const realCwd = await realpath(cwd);
      if (!isPathWithinDir(realCwd, real)) return undefined;
      return toDisplayPath(realCwd, real)
        .split("/")
        .filter((segment) => segment !== "");
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}

/**
 * 出力先(cwd 相対)を検証し、絶対パスと表示用パスを返す。拒否はすべて 403(path / name rules)。
 * 拒否リストではなく許可リストを土台にする: UI で作るフローは、作成後に一覧(GET /api/flows)へ出る場所にだけ置ける。
 * - cwd の外(絶対パス・.. ・リンク経由)は不可。バックスラッシュを含むパスは(POSIX では別の意味のない文字だが
 *   Windows 由来の区切りと紛らわしいため)一律に拒否する
 * - 拡張子は .yaml / .yml のみ。設定ファイル名(klaus.config.yaml / .yml)は不可
 * - 置き場所は、既に探索されたフローを含むディレクトリ(ちょうどそのディレクトリ)か、api/ / flows/ とその配下に限る。
 *   environments/ のようなフロー探索の対象外ディレクトリは、許可リストに入らないため構造上作れない
 * - 多層防御として、隠し要素(. で始まる)と探索対象外ディレクトリ名は、大文字小文字・Unicode 正規化を揃えて
 *   (foldName)拒否し、実在する最も深い祖先の実パスの要素にも同じ検査をする
 * - 途中・最終要素のシンボリックリンクの扱いは findUnsafeSymlinkInWritePath に従う
 */
export async function resolvePromoteOutput(
  cwd: string,
  requested: string,
): Promise<OutputPathResult> {
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
  if (requested.includes("\\")) return forbidden("backslashes are not allowed in the output path");
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
  if (RESERVED_FILE_NAMES.has(foldName(basename(target)))) {
    return forbidden(`"${file}" is reserved for the klaus configuration`);
  }
  const skipped = (): OutputPathResult =>
    forbidden(
      `output path "${file}" is in a directory that flow discovery skips or a hidden path; choose another location`,
    );
  if (hasForbiddenSegment(segments, false)) return skipped();
  const realSegments = await realAncestorSegments(resolvedCwd, target);
  if (realSegments === undefined) return forbidden("path traversal detected");
  if (hasForbiddenSegment([...realSegments, "x"], false)) return skipped();

  // 許可リスト: 探索済みのフローを含むディレクトリ(ちょうどその場所)と、api/ / flows/ 配下
  const directory = segments.slice(0, -1).map((segment) => segment.normalize("NFC"));
  const existing = new Set<string>();
  for (const flowPath of await discoverFlowCandidates(resolvedCwd)) {
    existing.add(
      toDisplayPath(resolvedCwd, dirname(flowPath))
        .split("/")
        .filter((segment) => segment !== "")
        .map((segment) => segment.normalize("NFC"))
        .join("/"),
    );
  }
  const underDefault = directory.length > 0 && DEFAULT_OUTPUT_DIRS.includes(directory[0] as string);
  if (!underDefault && !existing.has(directory.join("/"))) {
    return forbidden(
      `"${file}" is not in a location where flows are kept; use api/, flows/, or a directory that already contains flow files`,
    );
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
