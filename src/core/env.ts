import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { KlausError, ParseError } from "./errors.js";
import { loadEnvironmentFile } from "./loader.js";
import type { Environment } from "./schema.js";

/**
 * 環境が保護対象($protected: true)かどうかを判定する。
 */
export function isProtectedEnvironment(environment: Environment): boolean {
  return environment.$protected === true;
}

/**
 * テンプレート変数展開用に、予約キー $protected を除いた変数マップを返す。
 * {{$protected}} のような形でテンプレートから参照できてしまわないよう、
 * runner.ts で TemplateContext を組み立てる直前に必ずこれを通す。
 */
export function toTemplateVariables(environment: Environment): Record<string, string> {
  const { $protected: _protected, ...variables } = environment;
  return variables;
}

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
 * 上方探索で cwd(startDir)より上の祖先ディレクトリに見つかった設定系ファイル
 * (environments/<name>.yaml、klaus.config.yaml 等)を信頼してよいかを検証する。
 * git の safe.directory と同じ考え方で、startDir 自身は利用者が選んだ作業ディレクトリなので
 * 対象外とし、それより上の祖先だけを検査する(共有ホストで攻撃者が仕込んだファイルを、
 * リポジトリ外で作業しているだけで黙って読み込んでしまうことを防ぐため)。信頼できないと
 * 判断した場合は ParseError で fail closed に拒否する。ファイルシステムへの追加アクセスを
 * 避けるため、existsSync で候補の存在が確認できた場合にのみ呼び出すこと。
 * dir にはファイルの直接の親ディレクトリ(environments/ 等の探索対象ディレクトリ自身、
 * あるいは klaus.config.yaml のようにディレクトリ直下に置く場合はそのディレクトリ)を渡す。
 * src/cli/config.ts(klaus.config.yaml の上方探索)からも再利用するため export している
 * (env 側の呼び出し・挙動・テストは不変)。
 */
export function assertTrustedAncestorSource(dir: string, candidatePath: string): void {
  // Windows には process.getuid が存在せず、パーミッションビットの意味論も ACL モデルとは
  // 異なるため、POSIX 前提の mode 判定をそのまま適用すると誤判定になる。ここでは検査自体を
  // スキップし、従来どおり採用する。
  if (process.platform === "win32") {
    return;
  }

  for (const target of [dir, candidatePath]) {
    const stat = statSync(target);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new ParseError(
        "refusing to load a file from an ancestor directory owned by another user " +
          "(create the file inside your project directory instead)",
        candidatePath,
      );
    }
    // other-writable(誰でも書き換え可能)なら拒否する。
    // group-writable(0o020)はここでは拒否しない。umask 002 かつユーザーごとの
    // プライベートグループを使う環境(RHEL 系など)では通常のファイルが既定で group-writable に
    // なり、拒否すると普通の利用者を誤って弾いてしまうため。この判断により「自分が所有し、かつ
    // group-writable で、そのグループに他ユーザーが属している」場合だけは通過する余地が残るが、
    // 他ユーザー所有のディレクトリ・ファイルは mode に関わらず直前の uid チェックで拒否される
    // ので、攻撃者がファイルを置き換える経路(所有者が攻撃者になる)は塞がっている。
    if ((stat.mode & 0o002) !== 0) {
      throw new ParseError(
        "refusing to load a file from an ancestor directory that is writable by other users " +
          "(create the file inside your project directory instead)",
        candidatePath,
      );
    }
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
 * - cwd より上の祖先ディレクトリで候補が見つかった場合は、そのディレクトリと候補ファイルの
 *   所有者・パーミッションを検査する(assertTrustedAncestorSource)。信頼できない
 *   祖先だった場合は、探索を継続せずその場で ParseError を投げて fail closed に拒否する
 *   (黙って別の候補を探すと、利用者にとって最終的に何が読まれたのか分からなくなるため)。
 *   cwd 自身の environments/ はこの検査の対象外(利用者自身が選んだ作業ディレクトリのため)。
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
      if (dir !== startDir) {
        assertTrustedAncestorSource(envDir, candidatePath);
      }
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
 * - 予約キー $protected は削除対象から除外する(呼び出し元(UI 編集エンドポイント)が扱う
 *   values には含まれない設計のため、既存ファイルに $protected: true があっても
 *   黙って保護が剥がれることのないよう、ここでも保持する)。
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
    if (!(key in values) && key !== "$protected") {
      doc.delete(key);
    }
  }
  for (const [key, value] of Object.entries(values)) {
    doc.set(key, value);
  }

  await writeFile(path, doc.toString(), "utf-8");
}
