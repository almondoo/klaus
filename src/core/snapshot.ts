/**
 * スナップショット(API のレスポンスを基準として保存し、以降の実行で比較する)アサーションの実装。
 *
 * - 保存先: フローファイルの隣の `__snapshots__/<フローファイル名>.snap.json`。キー順ソート・整形済みの JSON で、
 *   git の差分で読めるようにする。値は `{ status?, headers?, body? }`(マスク済み・ignore 適用済み)
 * - 秘密値は履歴と同じマスクを通した後の値を保存・比較する(コミット対象のファイルに平文を残さない)
 * - 書き込みは実行の終了時(SnapshotStore#finalize)にまとめて行う。並列実行(--jobs)でも同じファイルへの
 *   競合書き込みが起きず、実行が途中で落ちたときに中途半端な基準が残らない
 * - 書き込み先は cwd 配下の `__snapshots__` ディレクトリに限り、シンボリックリンクは辿らない
 *
 * core の依存方向を保つため、CLI・server のどちらにも依存しない。
 */
import { constants, lstatSync } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { maskCookieHeaders } from "./cookie-jar.js";
import { GuardRefusalError, ParseError } from "./errors.js";
import type { HistoryEntry } from "./history.js";
import { expandSecretVariants, maskDeep, maskString } from "./history.js";
import { readAllHistoryEntries } from "./history-query.js";
import {
  diffJson,
  exceedsDepth,
  type JsonPathPattern,
  MAX_JSON_BODY_DEPTH,
  parseJsonPathPattern,
  replaceIgnoredPaths,
} from "./json-diff.js";
import {
  findUnsafeSymlinkInWritePath,
  isPathWithinDir,
  isRealPathWithinDir,
} from "./path-guard.js";
import { selectRunEntries } from "./run-diff.js";
import type { Flow, SnapshotAssertionDef } from "./schema.js";
import type {
  AssertionResult,
  FlowResult,
  SnapshotAssertionDetail,
  SnapshotDifference,
  SnapshotEntry,
  SnapshotRunSummary,
  SnapshotState,
} from "./types.js";

/** スナップショットを置くディレクトリ名 */
export const SNAPSHOT_DIR = "__snapshots__";
/** スナップショットファイルの拡張子(フローファイル名の後ろに付く) */
export const SNAPSHOT_SUFFIX = ".snap.json";
/** ignore に一致した値の代わりに保存・比較に使う固定値 */
export const SNAPSHOT_PLACEHOLDER = "[ignored]";
/** include 未指定時の比較対象 */
export const DEFAULT_SNAPSHOT_INCLUDE = ["status", "body"] as const;
/** headers 未指定時に保存・比較するヘッダー(揮発しにくいもの) */
export const DEFAULT_SNAPSHOT_HEADERS = ["content-type"] as const;
/** 結果に載せる差分の最大件数(総数は differenceCount に残す) */
export const MAX_SNAPSHOT_DIFFERENCES = 20;
/** メッセージに並べる差分の最大件数 */
const MAX_INLINE_DIFFERENCES = 3;
/** 1 エントリの JSON 表現の最大バイト数(超える応答は基準にしない) */
export const MAX_SNAPSHOT_ENTRY_BYTES = 1024 * 1024;
/** スナップショットファイル全体の最大バイト数(読み込み時の上限) */
export const MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;
/** 保存・比較する body の最大の入れ子の深さ(構造化して扱う JSON 全体の上限と共通) */
const MAX_SNAPSHOT_DEPTH = MAX_JSON_BODY_DEPTH;
/** 古いエントリの警告に並べるキーの最大件数 */
const MAX_OBSOLETE_KEYS_IN_WARNING = 10;

/** 正規化済みの snapshot アサーション設定 */
export interface SnapshotSpec {
  ignore: JsonPathPattern[];
  include: ReadonlySet<"status" | "headers" | "body">;
  /** 小文字化・重複除去済みのヘッダー名(include に headers があるときだけ使う) */
  headers: string[];
  name?: string;
}

/** snapshot アサーション(true またはオブジェクト)を正規化する。ignore の構文はスキーマ検証済みの前提 */
export function normalizeSnapshotSpec(def: SnapshotAssertionDef): SnapshotSpec {
  const options = def === true ? {} : def;
  const ignore = (options.ignore ?? []).flatMap((source) => {
    const pattern = parseJsonPathPattern(source);
    return pattern ? [pattern] : [];
  });
  const headers = [
    ...new Set((options.headers ?? DEFAULT_SNAPSHOT_HEADERS).map((name) => name.toLowerCase())),
  ];
  return {
    ignore,
    include: new Set(options.include ?? DEFAULT_SNAPSHOT_INCLUDE),
    headers,
    ...(options.name !== undefined ? { name: options.name } : {}),
  };
}

/**
 * スナップショットのキー。ステップ名に、--data 実行なら ` #<反復番号>`、name があれば ` :: <name>` を付ける
 * (例: `login`、`login #2`、`login #2 :: v2`)。
 */
export function buildSnapshotKey(
  stepName: string,
  iteration: number | undefined,
  name: string | undefined,
): string {
  return `${stepName}${iteration !== undefined ? ` #${iteration}` : ""}${name !== undefined ? ` :: ${name}` : ""}`;
}

/**
 * フローの snapshot のキーが、曖昧でなく一意かを検査する。問題があればメッセージを返す(無ければ undefined)。
 * キーは `<ステップ名>[ #<反復番号>][ :: <name>]` なので、ステップ名が ` :: ` を含む、または ` #<数字>` で終わると、
 * 別のステップ・反復・name と同じキーになり得る。そうしたステップ名と、同じキーになる複数のステップを定義エラーにする。
 */
export function findSnapshotKeyProblem(
  flow: Pick<Flow, "steps">,
): { stepIndex: number; message: string } | undefined {
  const seen = new Map<string, number>();
  for (const [index, step] of flow.steps.entries()) {
    const def = step.assert?.snapshot;
    if (def === undefined) continue;
    if (step.name.includes(" :: ") || /\s#\d+$/.test(step.name)) {
      return {
        stepIndex: index,
        message: `step "${step.name}" has assert.snapshot, so its name must not contain " :: " or end with " #<number>" (they are used to build the snapshot key)`,
      };
    }
    const key = buildSnapshotKey(step.name, undefined, normalizeSnapshotSpec(def).name);
    const first = seen.get(key);
    if (first !== undefined) {
      return {
        stepIndex: index,
        message: `steps ${first + 1} and ${index + 1} would use the same snapshot key "${key}"; give one of them a different step name or snapshot name`,
      };
    }
    seen.set(key, index);
  }
  return undefined;
}

/** フローファイルに対応するスナップショットファイルの絶対パス */
export function snapshotFilePath(cwd: string, flowFilePath: string): string {
  const flowPath = resolve(cwd, flowFilePath);
  return join(dirname(flowPath), SNAPSHOT_DIR, `${basename(flowPath)}${SNAPSHOT_SUFFIX}`);
}

/** 絶対パスを cwd 相対の POSIX 形式にする(表示・履歴用) */
function toRelative(cwd: string, absPath: string): string {
  return relative(resolve(cwd), absPath).split(sep).join("/");
}

/** 比較・保存に使う応答の最小限の形 */
export interface SnapshotResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** 基準にできない応答(深すぎる・大きすぎる)を表す。evaluate がアサーション失敗に変換する */
class SnapshotLimitError extends Error {}

/** オブジェクトのキーを再帰的にソートした複製を返す(`__proto__` という名前のキーでもプロトタイプを書き換えない) */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(result, key, {
        value: sortKeysDeep((value as Record<string, unknown>)[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  return value;
}

/**
 * 応答から、保存する(比較される側の)エントリを作る。秘密値は履歴と同じ規則でマスクし、
 * ignore に一致した値は固定値に置き換える。--no-mask は stdout の出力だけの設定で、ここには影響しない。
 */
export function buildSnapshotCandidate(
  spec: SnapshotSpec,
  response: SnapshotResponse,
  secrets: readonly string[],
): SnapshotEntry {
  if (spec.include.has("body") && exceedsDepth(response.body, MAX_SNAPSHOT_DEPTH)) {
    throw new SnapshotLimitError(
      `the response body is nested deeper than ${MAX_SNAPSHOT_DEPTH} levels and cannot be snapshotted`,
    );
  }
  const variants = expandSecretVariants(secrets);
  const entry: SnapshotEntry = {};
  if (spec.include.has("status")) entry.status = response.status;
  if (spec.include.has("headers")) {
    const lower = new Map(
      Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const headers: Record<string, string> = {};
    for (const name of [...spec.headers].sort()) {
      const value = lower.get(name);
      // Cookie / Set-Cookie の値は、秘密値の登録に関わらず位置で *** にしてから(基準・候補とも)保存する
      if (value !== undefined) {
        headers[name] = maskString(maskCookieHeaders({ [name]: value })[name] ?? value, variants);
      }
    }
    entry.headers = headers;
  }
  if (spec.include.has("body")) {
    const masked = maskDeep(response.body ?? "", variants);
    entry.body = replaceIgnoredPaths(masked, spec.ignore, SNAPSHOT_PLACEHOLDER);
  }
  // JSON.stringify の長さ(UTF-16 単位)で概算する。厳密なバイト数は不要で、巨大な応答を弾けばよい
  if (JSON.stringify(entry).length > MAX_SNAPSHOT_ENTRY_BYTES) {
    throw new SnapshotLimitError(
      `the response is larger than ${MAX_SNAPSHOT_ENTRY_BYTES / 1024} KiB and cannot be snapshotted (use include / ignore to narrow it)`,
    );
  }
  return entry;
}

/** include に含まれる部分だけを取り出し、body には現在の ignore を適用する(基準側の比較用ビュー) */
function viewOf(entry: SnapshotEntry, spec: SnapshotSpec): Record<string, unknown> {
  const view: Record<string, unknown> = {};
  if (spec.include.has("status") && entry.status !== undefined) view.status = entry.status;
  if (spec.include.has("headers") && entry.headers !== undefined) view.headers = entry.headers;
  if (spec.include.has("body") && "body" in entry) {
    view.body = replaceIgnoredPaths(entry.body, spec.ignore, SNAPSHOT_PLACEHOLDER);
  }
  return view;
}

/**
 * 基準と今回の応答の構造差分(キー順は無視。配列は順序依存)。差が無ければ空配列。
 * 基準を作ったときと ignore の設定が変わっていても、基準側の body に現在の ignore を適用して比べる。
 */
export function compareSnapshot(
  baseline: SnapshotEntry,
  candidate: SnapshotEntry,
  spec: SnapshotSpec,
): SnapshotDifference[] {
  return diffJson(viewOf(baseline, spec), viewOf(candidate, spec));
}

/** 値を 1 行・短い文字列にする(メッセージ用) */
function shortValue(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** 差分 1 件を 1 行の説明にする */
export function describeSnapshotDifference(difference: SnapshotDifference): string {
  switch (difference.kind) {
    case "added":
      return `${difference.path} added ${shortValue(difference.after)}`;
    case "removed":
      return `${difference.path} removed (was ${shortValue(difference.before)})`;
    case "too-deep":
      return `${difference.path} differs (too deeply nested to show)`;
    default:
      return `${difference.path} ${shortValue(difference.before)} -> ${shortValue(difference.after)}`;
  }
}

/** mismatch のメッセージ(1 行。先頭の数件の差分だけを含め、全件は differences に載せる) */
function mismatchMessage(key: string, differences: SnapshotDifference[]): string {
  const inline = differences.slice(0, MAX_INLINE_DIFFERENCES).map(describeSnapshotDifference);
  const rest = differences.length - inline.length;
  return `snapshot "${key}" differs from the baseline (${differences.length} difference${differences.length === 1 ? "" : "s"}): ${inline.join("; ")}${rest > 0 ? `; (+${rest} more)` : ""}`;
}

/** スナップショットファイルの読み込み結果。baseline が undefined ならファイルが無い */
interface LoadedSnapshotFile {
  baseline: Map<string, SnapshotEntry> | undefined;
  /** ファイルがあるが読めない・壊れているときの短い理由(内容は含めない) */
  loadError?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 1 エントリの形(status は数値、headers は文字列の値のオブジェクト)を検証する */
function toSnapshotEntry(value: unknown): SnapshotEntry | undefined {
  if (!isPlainObject(value)) return undefined;
  const entry: SnapshotEntry = {};
  if ("status" in value) {
    if (typeof value.status !== "number") return undefined;
    entry.status = value.status;
  }
  if ("headers" in value) {
    const headers = value.headers;
    if (!isPlainObject(headers)) return undefined;
    const result: Record<string, string> = {};
    for (const [name, headerValue] of Object.entries(headers)) {
      if (typeof headerValue !== "string") return undefined;
      Object.defineProperty(result, name, {
        value: headerValue,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    entry.headers = result;
  }
  if ("body" in value) {
    // 深すぎる本文は(整形・比較の再帰で落ちないよう)基準として受け付けない
    if (exceedsDepth(value.body, MAX_SNAPSHOT_DEPTH)) return undefined;
    entry.body = value.body;
  }
  return entry;
}

/** O_NOFOLLOW でファイルを開いて全体を読む(最終要素がシンボリックリンクなら失敗する) */
async function readFileNoFollow(
  path: string,
  maxBytes: number,
): Promise<string | "too-large" | "not-regular"> {
  // 名前付きパイプ・デバイスを blocking で開くと実行が止まるため、先に lstat し、O_NONBLOCK で開いて fstat でも確かめる
  const before = await lstat(path);
  if (!before.isFile()) return "not-regular";
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) return "not-regular";
    const { size } = info;
    if (size > maxBytes) return "too-large";
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

/**
 * スナップショットファイルを読む。内容(壊れた JSON の断片など)は理由に含めない:
 * 参照先が意図しないファイルでも、その内容を出力に載せないため。
 */
async function loadSnapshotFile(absPath: string): Promise<LoadedSnapshotFile> {
  let text: string | "too-large" | "not-regular";
  try {
    text = await readFileNoFollow(absPath, MAX_SNAPSHOT_FILE_BYTES);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { baseline: undefined };
    return { baseline: undefined, loadError: "the file cannot be read" };
  }
  if (text === "not-regular") {
    return { baseline: undefined, loadError: "the path is not a regular file" };
  }
  if (text === "too-large") {
    return {
      baseline: undefined,
      loadError: `the file is larger than ${MAX_SNAPSHOT_FILE_BYTES / 1024 / 1024} MiB`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { baseline: undefined, loadError: "the file is not valid JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { baseline: undefined, loadError: "the top level must be a JSON object" };
  }
  const baseline = new Map<string, SnapshotEntry>();
  for (const [key, value] of Object.entries(parsed)) {
    const entry = toSnapshotEntry(value);
    if (!entry) {
      return {
        baseline: undefined,
        loadError: `entry ${JSON.stringify(key.length > 80 ? `${key.slice(0, 77)}...` : key)} is not a snapshot (expected { status?, headers?, body? })`,
      };
    }
    baseline.set(key, entry);
  }
  return { baseline };
}

/** スナップショットファイルの文字列表現(キー順ソート・2 スペース整形・末尾改行) */
export function serializeSnapshotFile(entries: ReadonlyMap<string, SnapshotEntry>): string {
  if (entries.size === 0) return "{}\n";
  const lines = [...entries.keys()].sort().map((key) => {
    const body = JSON.stringify(sortKeysDeep(entries.get(key)), null, 2).replace(/\n/g, "\n  ");
    return `  ${JSON.stringify(key)}: ${body}`;
  });
  return `{\n${lines.join(",\n")}\n}\n`;
}

/**
 * スナップショットファイルとして読み書きしてよいパスか。拒否する理由を返す(問題なければ undefined)。
 * - `<…>/__snapshots__/<名前>.snap.json` の形に限る
 * - cwd 配下に解決され、最終要素のシンボリックリンクと、cwd 外・宙づりを指す途中のリンクを含まない
 */
export function findUnsafeSnapshotPath(cwd: string, absPath: string): string | undefined {
  const root = resolve(cwd);
  if (
    basename(dirname(absPath)) !== SNAPSHOT_DIR ||
    !basename(absPath).endsWith(SNAPSHOT_SUFFIX) ||
    basename(absPath) === SNAPSHOT_SUFFIX
  ) {
    return `"${toRelative(root, absPath)}" is not a snapshot file path (<dir>/${SNAPSHOT_DIR}/<name>${SNAPSHOT_SUFFIX})`;
  }
  if (!isPathWithinDir(root, absPath) || !isRealPathWithinDir(root, absPath)) {
    return `snapshot path resolves outside the current directory: "${isPathWithinDir(root, absPath) ? toRelative(root, absPath) : "(outside the current directory)"}"`;
  }
  const display = toRelative(root, absPath);
  // .git などの隠しディレクトリの下には置かない(フックなどを書き換える足場にしないため)
  if (
    display
      .split("/")
      .slice(0, -1)
      .some((segment) => segment.startsWith("."))
  ) {
    return `refusing to use a snapshot file under a hidden directory: "${display}"`;
  }
  // __snapshots__ ディレクトリと基準ファイル自体は、行き先が cwd 内であってもシンボリックリンクを辿らない
  for (const part of [dirname(absPath), absPath]) {
    try {
      if (lstatSync(part).isSymbolicLink()) {
        return `refusing to use the snapshot file: "${toRelative(root, part)}" is a symbolic link`;
      }
    } catch {
      // まだ存在しない要素は、後で通常のディレクトリ・ファイルとして作る
    }
  }
  const unsafe = findUnsafeSymlinkInWritePath(root, absPath);
  if (unsafe) return `refusing to use the snapshot file: ${unsafe}`;
  return undefined;
}

/**
 * スナップショットファイルを書く(または entries が空なら削除する)。
 * 検査済みのパスに対しても、一時ファイルを O_EXCL | O_NOFOLLOW で作ってから rename で置き換える
 * (書き込みの途中で落ちても元のファイルを壊さず、リンクの差し替えにも辿られない)。
 */
async function writeSnapshotFile(
  cwd: string,
  absPath: string,
  entries: ReadonlyMap<string, SnapshotEntry>,
): Promise<void> {
  const root = resolve(cwd);
  const unsafe = findUnsafeSnapshotPath(root, absPath);
  if (unsafe) throw new GuardRefusalError(unsafe, "guard.path");
  if (entries.size === 0) {
    try {
      await unlink(absPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }
  await mkdir(dirname(absPath), { recursive: true });
  // mkdir 後に親ディレクトリの実体が cwd 内であることを再確認する(検査と作成の間の差し替えを狭める)
  const realParent = await realpath(dirname(absPath));
  const realRoot = await realpath(root);
  if (!isPathWithinDir(realRoot, realParent)) {
    throw new GuardRefusalError(
      `snapshot path resolves outside the current directory: "${toRelative(root, absPath)}"`,
      "guard.path",
    );
  }
  const temp = `${absPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o644,
  );
  try {
    try {
      await handle.writeFile(serializeSnapshotFile(entries), "utf-8");
    } finally {
      await handle.close();
    }
    await rename(temp, absPath);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** これより古いロックファイルを、クラッシュで残ったものとして奪う時間(ms) */
export const LOCK_STALE_MS = 30_000;
/**
 * ロックを待つ最長時間(ms)。stale の閾値より長くして、クラッシュで残ったロックは必ず待ち切って奪えるようにする
 * (これが閾値以下だと、残ったロックに当たった実行が奪う前にタイムアウトしてしまう)
 */
export const LOCK_TIMEOUT_MS = LOCK_STALE_MS + 5_000;

/** withFileLock の待ち時間の設定(テストで短い値を渡すために公開する) */
export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  /** タイムアウトのメッセージに載せるロックファイルのパス(未指定なら lockPath) */
  displayPath?: string;
}

/**
 * ロックファイル(`<スナップショット>.lock`。O_EXCL で作る)を取って fn を実行する。
 * 別の実行(UI サーバーの同時実行など)が同じファイルを書き換えている間は待つ。
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o644,
      );
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await lstat(lockPath);
        if (Date.now() - info.mtimeMs > staleMs) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `timed out waiting for another run to finish writing the snapshot file (lock file: "${options.displayPath ?? lockPath}"); if no other run is writing, remove the lock file and run again`,
        );
      }
      await new Promise((done) => setTimeout(done, 15 + Math.random() * 30));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

/**
 * スナップショットファイルを、ロックの下で「読み直して → mutate で書き換えて → 書く」。
 * 別の実行が先に書いたキーを失わないよう、書く直前のファイルの内容に対して変更を適用する。
 * mutate が undefined を返したら何も書かない。
 */
async function updateSnapshotFile(
  cwd: string,
  absPath: string,
  mutate: (current: LoadedSnapshotFile) => Map<string, SnapshotEntry> | undefined,
): Promise<void> {
  const root = resolve(cwd);
  const unsafe = findUnsafeSnapshotPath(root, absPath);
  if (unsafe) throw new GuardRefusalError(unsafe, "guard.path");
  await mkdir(dirname(absPath), { recursive: true });
  const realParent = await realpath(dirname(absPath));
  if (!isPathWithinDir(await realpath(root), realParent)) {
    throw new GuardRefusalError(
      `snapshot path resolves outside the current directory: "${toRelative(root, absPath)}"`,
      "guard.path",
    );
  }
  await withFileLock(
    `${absPath}.lock`,
    async () => {
      const next = mutate(await loadSnapshotFile(absPath));
      if (next !== undefined) await writeSnapshotFile(root, absPath, next);
    },
    { displayPath: `${toRelative(root, absPath)}.lock` },
  );
}

/** SnapshotStore のオプション */
export interface SnapshotStoreOptions {
  cwd: string;
  /** --update-snapshots: 不一致・未記録の基準を書き換え、古いエントリを取り除く */
  update: boolean;
  /** CI: 基準が無いときに書き込まず失敗にする(update が優先する) */
  ci: boolean;
  /** --replay: 基準を一切書かない(比較だけを行う。update も無視する) */
  readOnly: boolean;
}

/** ファイルごとの実行中の状態 */
interface SnapshotFileState {
  absPath: string;
  display: string;
  /** 読み書きを拒否する理由(cwd 外・リンクなど)。設定されていれば evaluate は GuardRefusalError を投げる */
  unsafe?: string;
  baseline: Map<string, SnapshotEntry> | undefined;
  /** 壊れたファイルを --update-snapshots で作り直すときの元の理由(警告に使う) */
  loadError?: string;
  /** 実行終了時に書き込むエントリ(written / updated) */
  pending: Map<string, SnapshotEntry>;
  /** この実行で評価されたキー */
  seen: Set<string>;
  /** フローの実行 1 回ごとの「全ステップを評価できたか」 */
  runs: boolean[];
}

/** SnapshotStore#evaluate の入力 */
export interface SnapshotEvaluateInput {
  flowFilePath: string;
  key: string;
  spec: SnapshotSpec;
  response: SnapshotResponse;
  secrets: readonly string[];
  /** 保護環境($protected)に対する実行か。暗黙の新規書き込みを拒否する */
  protectedEnv: boolean;
  /** 同じステップの他のアサーションがすべて成功したか(失敗した応答を暗黙に基準にしないため) */
  otherAssertionsOk: boolean;
}

/** SnapshotStore#finalize の結果 */
export interface SnapshotFinalizeResult {
  /** 書き込んだ(または古いエントリを取り除いた)ファイル(cwd 相対) */
  files: string[];
  obsoleteEntries: { file: string; keys: string[] }[];
  warnings: string[];
}

function snapshotResult(
  ok: boolean,
  detail: SnapshotAssertionDetail,
  message: string,
): AssertionResult {
  return { ok, kind: "snapshot", message, snapshot: detail };
}

/**
 * 1 回の実行(runLoadedFlows または単独の executeFlow)の間、スナップショットの読み込み・判定・書き込みを
 * 受け持つ。判定は同期的(preload 済みのファイル状態に対して行う)で、書き込みは finalize で一度だけ行う。
 */
export class SnapshotStore {
  private readonly files = new Map<string, SnapshotFileState>();

  constructor(private readonly options: SnapshotStoreOptions) {}

  /**
   * フローに対応するスナップショットファイルを実行前に読み込む。
   * snapshot を使うフローのファイルが壊れていれば ParseError(--update-snapshots のときは作り直すため警告だけ)。
   * snapshot を使わないフローの既存ファイルも(古いエントリの検出のために)読むが、壊れていても無視する。
   */
  async preload(
    entries: ReadonlyArray<{ filePath: string; usesSnapshot: boolean }>,
  ): Promise<string[]> {
    const warnings: string[] = [];
    for (const { filePath, usesSnapshot } of entries) {
      const absPath = snapshotFilePath(this.options.cwd, filePath);
      let state = this.files.get(absPath);
      if (!state) {
        const display = toRelative(this.options.cwd, absPath);
        const unsafe = findUnsafeSnapshotPath(this.options.cwd, absPath);
        const loaded: LoadedSnapshotFile =
          unsafe !== undefined ? { baseline: undefined } : await loadSnapshotFile(absPath);
        state = {
          absPath,
          display,
          ...(unsafe !== undefined ? { unsafe } : {}),
          baseline: loaded.baseline,
          ...(loaded.loadError !== undefined ? { loadError: loaded.loadError } : {}),
          pending: new Map(),
          seen: new Set(),
          runs: [],
        };
        this.files.set(absPath, state);
      }
      if (usesSnapshot && state.loadError !== undefined) {
        if (!this.options.update || this.options.readOnly) {
          throw new ParseError(
            `snapshot file "${state.display}" is corrupt: ${state.loadError}. Fix it, delete it, or run with --update-snapshots to recreate it`,
          );
        }
        warnings.push(
          `snapshot file "${state.display}" is corrupt (${state.loadError}); recreating it because --update-snapshots was given`,
        );
      }
    }
    return warnings;
  }

  private stateFor(flowFilePath: string): SnapshotFileState {
    const state = this.files.get(snapshotFilePath(this.options.cwd, flowFilePath));
    if (!state) throw new Error(`snapshot file for "${flowFilePath}" was not preloaded`);
    return state;
  }

  /** 1 ステップの応答をスナップショットと比べ、必要なら(実行終了時に)書き込む内容を記録して、結果を返す */
  evaluate(input: SnapshotEvaluateInput): AssertionResult {
    const state = this.stateFor(input.flowFilePath);
    if (state.unsafe !== undefined) throw new GuardRefusalError(state.unsafe, "guard.path");
    const { key } = input;
    state.seen.add(key);
    const detail = (
      snapshotState: SnapshotState,
      extra: Partial<SnapshotAssertionDetail> = {},
    ): SnapshotAssertionDetail => ({
      key,
      file: state.display,
      state: snapshotState,
      ...extra,
    });

    let candidate: SnapshotEntry;
    try {
      candidate = buildSnapshotCandidate(input.spec, input.response, input.secrets);
    } catch (error) {
      if (!(error instanceof SnapshotLimitError)) throw error;
      return snapshotResult(false, detail("mismatch"), `snapshot "${key}": ${error.message}`);
    }

    // --update-snapshots でも、同じステップの他のアサーションが失敗した応答は基準にしない
    const canWrite = this.options.update && !this.options.readOnly && input.otherAssertionsOk;
    const baseline = state.baseline?.get(key);
    if (baseline !== undefined) {
      const differences = compareSnapshot(baseline, candidate, input.spec);
      if (differences.length === 0) {
        return snapshotResult(true, detail("matched"), `snapshot "${key}" matches the baseline`);
      }
      if (canWrite) {
        state.pending.set(key, candidate);
        return snapshotResult(
          true,
          detail("updated"),
          `snapshot "${key}" updated (${differences.length} difference${differences.length === 1 ? "" : "s"} from the old baseline)`,
        );
      }
      return snapshotResult(
        false,
        detail("mismatch", {
          differences: differences.slice(0, MAX_SNAPSHOT_DIFFERENCES),
          differenceCount: differences.length,
          candidate,
        }),
        input.otherAssertionsOk
          ? mismatchMessage(key, differences)
          : `${mismatchMessage(key, differences)} (not updated because the step's other assertions failed)`,
      );
    }

    // 基準が無い
    if (canWrite) {
      state.pending.set(key, candidate);
      return snapshotResult(true, detail("written"), `snapshot "${key}" written (new baseline)`);
    }
    const missing = (ok: boolean, message: string): AssertionResult =>
      snapshotResult(ok, detail("missing", { candidate }), message);
    if (this.options.readOnly) {
      return missing(
        false,
        `snapshot "${key}" has no baseline, and snapshots are never written in --replay mode`,
      );
    }
    if (this.options.ci) {
      return missing(
        false,
        `snapshot "${key}" has no baseline, and a baseline is not recorded in CI (run it locally and commit "${state.display}", or pass --update-snapshots)`,
      );
    }
    if (input.protectedEnv) {
      return missing(
        false,
        `snapshot "${key}" has no baseline, and a baseline is not recorded implicitly from a protected environment (pass --update-snapshots to record it explicitly)`,
      );
    }
    if (!input.otherAssertionsOk) {
      // このステップは他のアサーションで失敗している。失敗した応答を基準として暗黙に残さない
      return missing(
        true,
        `snapshot "${key}" has no baseline and was not written because the step's other assertions failed`,
      );
    }
    state.pending.set(key, candidate);
    return snapshotResult(true, detail("written"), `snapshot "${key}" written (new baseline)`);
  }

  /**
   * フローの実行 1 回が終わったことを記録する。complete は「スキップされたステップがなく、snapshot を持つ
   * すべてのステップが評価された」とき true。古いエントリの判定は、そのファイルの全実行が complete のときだけ行う。
   */
  recordFlowRun(flowFilePath: string, complete: boolean): void {
    this.stateFor(flowFilePath).runs.push(complete);
  }

  /** 書き込みを行い、古いエントリを集計する。--update-snapshots なら古いエントリを取り除く */
  async finalize(): Promise<SnapshotFinalizeResult> {
    const files: string[] = [];
    const obsoleteEntries: { file: string; keys: string[] }[] = [];
    const warnings: string[] = [];
    const canWrite = this.options.update && !this.options.readOnly;

    for (const state of this.files.values()) {
      const baseline = state.baseline;
      const reliable = state.runs.length > 0 && state.runs.every((complete) => complete);
      const obsolete =
        reliable && baseline !== undefined
          ? [...baseline.keys()].filter((key) => !state.seen.has(key)).sort()
          : [];
      if (obsolete.length > 0) {
        obsoleteEntries.push({ file: state.display, keys: obsolete });
        const listed = obsolete
          .slice(0, MAX_OBSOLETE_KEYS_IN_WARNING)
          .map((key) => JSON.stringify(key));
        const more =
          obsolete.length > listed.length ? `, and ${obsolete.length - listed.length} more` : "";
        warnings.push(
          `snapshot file "${state.display}" has ${obsolete.length} obsolete entr${obsolete.length === 1 ? "y" : "ies"} (${listed.join(", ")}${more}); ${canWrite ? "removing them" : "run with --update-snapshots to remove them"}`,
        );
      }
      const removing = canWrite ? obsolete : [];
      if (state.pending.size === 0 && removing.length === 0) continue;

      await updateSnapshotFile(this.options.cwd, state.absPath, (current) => {
        // 実行中に別の実行が壊した場合は、上書きしない(最初から壊れていたものは --update-snapshots が作り直す)
        if (current.loadError !== undefined && state.loadError === undefined) {
          throw new ParseError(
            `snapshot file "${state.display}" is corrupt: ${current.loadError}. Fix it, delete it, or run with --update-snapshots to recreate it`,
          );
        }
        // 書く直前の内容に、この実行の変更だけを重ねる(別の実行が書いたキーを失わない)
        const next = new Map(current.baseline ?? []);
        for (const key of removing) next.delete(key);
        for (const [key, entry] of state.pending) next.set(key, entry);
        return next;
      });
      files.push(state.display);
    }
    return { files: files.sort(), obsoleteEntries, warnings };
  }
}

/**
 * 実行結果から snapshot アサーションの集計を作る。snapshot アサーションも古いエントリも無ければ undefined。
 */
export function summarizeSnapshots(
  flows: readonly FlowResult[],
  finalized: SnapshotFinalizeResult,
): SnapshotRunSummary | undefined {
  const summary: SnapshotRunSummary = {
    matched: 0,
    written: 0,
    updated: 0,
    mismatched: 0,
    missing: 0,
    obsolete: finalized.obsoleteEntries.reduce((total, entry) => total + entry.keys.length, 0),
    files: finalized.files,
    obsoleteEntries: finalized.obsoleteEntries,
  };
  let any = false;
  for (const flow of flows) {
    for (const step of flow.steps) {
      for (const assertion of step.assertions) {
        const snapshotState = assertion.snapshot?.state;
        if (snapshotState === undefined) continue;
        any = true;
        if (snapshotState === "mismatch") summary.mismatched += 1;
        else summary[snapshotState] += 1;
      }
    }
  }
  return any || summary.obsolete > 0 || summary.files.length > 0 ? summary : undefined;
}

/** 履歴から読み出した、承認待ちのスナップショット(不一致、または基準が無く書かれなかったもの) */
export interface SnapshotMismatch {
  runId: string;
  flow: string;
  step: string;
  /** --data 実行の反復番号(1 始まり) */
  iteration?: number;
  /** フロー定義ファイルの cwd 相対パス(履歴の file) */
  flowFile?: string;
  /** スナップショットファイル(cwd 相対) */
  snapshotFile: string;
  key: string;
  state: "mismatch" | "missing";
  message: string;
  differences: SnapshotDifference[];
  differenceCount: number;
  /** 同じステップの snapshot 以外のアサーション(OpenAPI を含む)が失敗していた。true の承認は acceptSnapshot が拒否する */
  otherAssertionsFailed: boolean;
}

/** ステップの snapshot 以外のアサーションに、失敗したものがあるか */
function hasFailedOtherAssertion(entry: HistoryEntry): boolean {
  return entry.assertions.some((assertion) => !assertion.ok && assertion.snapshot === undefined);
}

/** 承認の対象になる snapshot の詳細か(候補を持つ mismatch / missing) */
function isPendingDetail(
  detail: SnapshotAssertionDetail | undefined,
): detail is SnapshotAssertionDetail {
  return (
    detail !== undefined &&
    (detail.state === "mismatch" || detail.state === "missing") &&
    detail.candidate !== undefined
  );
}

/**
 * 記録済みの run の、承認待ちのスナップショット(不一致、または基準が無く書かれなかったもの)を列挙する。
 * 履歴を読むだけで何も書かない。run が履歴に無ければ空配列。実行順(追記順)で返す。
 * 上限超過(応答が大きすぎる等)で候補を作れなかった不一致は、承認できないため含めない。
 */
export async function listSnapshotMismatches(
  cwd: string,
  runId: string,
): Promise<SnapshotMismatch[]> {
  const history = await readAllHistoryEntries(cwd);
  return collectMismatches(selectRunEntries(history, runId), runId);
}

function collectMismatches(entries: readonly HistoryEntry[], runId: string): SnapshotMismatch[] {
  const result: SnapshotMismatch[] = [];
  for (const entry of entries) {
    for (const assertion of entry.assertions) {
      const detail = assertion.snapshot;
      if (!isPendingDetail(detail)) continue;
      result.push({
        runId,
        flow: entry.flow,
        step: entry.step,
        ...(entry.iteration !== undefined ? { iteration: entry.iteration } : {}),
        ...(entry.file !== undefined ? { flowFile: entry.file } : {}),
        snapshotFile: detail.file,
        key: detail.key,
        state: detail.state as "mismatch" | "missing",
        message: assertion.message,
        differences: detail.differences ?? [],
        differenceCount: detail.differenceCount ?? detail.differences?.length ?? 0,
        otherAssertionsFailed: hasFailedOtherAssertion(entry),
      });
    }
  }
  return result;
}

/** acceptSnapshot の対象(listSnapshotMismatches の結果の snapshotFile と key をそのまま渡す) */
export interface AcceptSnapshotTarget {
  snapshotFile: string;
  key: string;
}

export type AcceptSnapshotResult =
  | { ok: true; state: "written" | "updated"; snapshotFile: string; key: string }
  | {
      ok: false;
      /**
       * not-found: run に該当する承認待ちが無い / unsafe: 書き込み先として許可できない /
       * corrupt: 既存のスナップショットファイル、または履歴の候補が壊れている /
       * failed-step: 候補を記録したステップの他のアサーション(OpenAPI を含む)が失敗していた
       */
      kind: "not-found" | "unsafe" | "corrupt" | "failed-step";
      message: string;
    };

/**
 * 履歴に記録された(マスク済みの)応答から作った候補を、スナップショットファイルの該当キーに書き込む。
 * 既存のキーがあれば置き換え(updated)、無ければ追加(written)。他のキーは変更しない。
 * 書き込み先は target.snapshotFile だが、`<dir>/__snapshots__/<name>.snap.json` の形で cwd 配下に解決され、
 * シンボリックリンクを含まない場合に限る(履歴や呼び出し元の入力を信用して任意のパスへ書かない)。
 * 失敗は例外ではなく結果で返す。
 */
export async function acceptSnapshot(
  cwd: string,
  runId: string,
  target: AcceptSnapshotTarget,
): Promise<AcceptSnapshotResult> {
  const history = await readAllHistoryEntries(cwd);
  let candidate: SnapshotEntry | undefined;
  let otherAssertionsFailed = false;
  // 同じキーが複数あれば最後(最新)の記録を採用する
  for (const entry of selectRunEntries(history, runId)) {
    for (const assertion of entry.assertions) {
      const detail = assertion.snapshot;
      if (
        isPendingDetail(detail) &&
        detail.key === target.key &&
        detail.file === target.snapshotFile
      ) {
        candidate = detail.candidate;
        otherAssertionsFailed = hasFailedOtherAssertion(entry);
      }
    }
  }
  if (candidate === undefined) {
    return {
      ok: false,
      kind: "not-found",
      message: `run "${runId}" has no pending snapshot "${target.key}" for "${target.snapshotFile}"`,
    };
  }

  // 履歴の候補は信用せず、基準ファイルのエントリと同じ検証を通す(形が不正なら書かない)
  const accepted = toSnapshotEntry(candidate);
  if (accepted === undefined) {
    return {
      ok: false,
      kind: "corrupt",
      message: `the candidate recorded in history for snapshot "${target.key}" is malformed and cannot be written`,
    };
  }
  if (otherAssertionsFailed) {
    return {
      ok: false,
      kind: "failed-step",
      message: `snapshot "${target.key}" was recorded from a step whose other assertions failed; fix the step and run it again instead of accepting this response`,
    };
  }

  const root = resolve(cwd);
  const absPath = resolve(root, target.snapshotFile);
  const unsafe = findUnsafeSnapshotPath(root, absPath);
  if (unsafe) return { ok: false, kind: "unsafe", message: unsafe };

  let state: "written" | "updated" = "written";
  let corrupt: string | undefined;
  try {
    await updateSnapshotFile(root, absPath, (current) => {
      if (current.loadError !== undefined) {
        corrupt = `snapshot file "${target.snapshotFile}" is corrupt: ${current.loadError}. Fix or delete it first`;
        return undefined;
      }
      const entries = new Map(current.baseline ?? []);
      state = entries.has(target.key) ? "updated" : "written";
      entries.set(target.key, accepted);
      return entries;
    });
  } catch (error) {
    if (error instanceof GuardRefusalError) {
      return { ok: false, kind: "unsafe", message: error.message };
    }
    throw error;
  }
  if (corrupt !== undefined) return { ok: false, kind: "corrupt", message: corrupt };
  return { ok: true, state, snapshotFile: target.snapshotFile, key: target.key };
}
