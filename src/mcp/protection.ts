/**
 * klaus mcp が、保護された環境($protected: true / "readonly")の値をエージェントへ返さないための判定と整形。
 *
 * - 値の集め方: environments/ にある環境ファイルの一覧に加えて、履歴エントリに記録された環境名も、core が実行時に使うのと同じ解決
 *   (core の loadEnvironment: 上方探索・シンボリックリンクの規則を含む)で読む。保護されていれば全変数の値を秘密として扱う
 * - 値が得られないとき(失敗は閉じる): 履歴に envProtection(保護された環境で書かれた事実)があるのに、記録された環境名が
 *   現在も保護された名前付き環境として読めない(場所が違う --env-file・削除・改名)エントリは、値を隠せないので
 *   リクエスト・レスポンスの中身を出さない(メタデータと withheld の理由だけを返す)。envProtection が無い旧エントリでも、
 *   記録された環境が今は読めない・名前として使えない(--env-file のファイル名)ものは、保護の有無を確かめられないので同じにする
 * - それ以外のエントリは、現在保護されているすべての環境の値を *** にして返す
 */
import {
  EnvironmentNotFoundError,
  getProtectedMode,
  protectedEnvironmentSecretValues,
} from "../core/env.js";
import {
  expandSecretVariants,
  type HistoryEntry,
  loadEnvironment,
  maskDeep,
  resolveHistoryEntryStatus,
} from "../core/index.js";
import { listEnvironments } from "../server/routes/environments.js";
import { ENV_NAME_PATTERN } from "../server/validation.js";

/** 環境の現在の状態。missing は見つからない、failed は読み込み・解釈に失敗 */
export type EnvironmentStatus = "protected" | "unprotected" | "missing" | "failed";

/** 現在の保護された環境の値と、記録された環境名ごとの状態 */
export interface ProtectionView {
  /** 現在保護されているすべての環境の値(host・hostname・origin を含む)。秘密として扱う文字列 */
  values: string[];
  statusOf(name: string): EnvironmentStatus | undefined;
}

/** 本文を出さずに返すエントリ(HistoryEntry の形のまま、withheld に理由を持つ) */
export type GuardedEntry = HistoryEntry & { withheld?: string };

async function statusAndValues(
  cwd: string,
  name: string,
): Promise<{ status: EnvironmentStatus; values: string[] }> {
  try {
    const environment = await loadEnvironment(cwd, undefined, name);
    if (getProtectedMode(environment) === false) return { status: "unprotected", values: [] };
    return { status: "protected", values: protectedEnvironmentSecretValues(environment) };
  } catch (error) {
    return { status: error instanceof EnvironmentNotFoundError ? "missing" : "failed", values: [] };
  }
}

/**
 * environments/ の一覧と recordedNames(履歴に記録された環境名)から、現在保護されている環境の値と状態を集める。
 * 名前として使えないもの(--env-file のファイル名など)は解決せず、状態は undefined のまま。
 */
export async function loadProtectionView(
  cwd: string,
  recordedNames: Iterable<string | undefined> = [],
): Promise<ProtectionView> {
  const names = new Set<string>();
  for (const { name } of await listEnvironments(cwd)) names.add(name);
  for (const name of recordedNames) {
    if (name !== undefined && ENV_NAME_PATTERN.test(name)) names.add(name);
  }
  const statuses = new Map<string, EnvironmentStatus>();
  const values: string[] = [];
  for (const name of names) {
    const resolved = await statusAndValues(cwd, name);
    statuses.set(name, resolved.status);
    values.push(...resolved.values);
  }
  return { values, statusOf: (name) => statuses.get(name) };
}

/** 値を持たない(隠せない)ためにエントリの中身を出さない理由。出してよければ undefined */
export function withholdReason(entry: HistoryEntry, view: ProtectionView): string | undefined {
  const name = entry.env;
  const named = name !== undefined && ENV_NAME_PATTERN.test(name);
  if (entry.envProtection !== undefined) {
    if (named && view.statusOf(name) === "protected") return undefined;
    return `this entry was recorded against a protected environment (${entry.envProtection}) whose values cannot be obtained here for masking (an --env-file outside environments/, or a file that was deleted, renamed, or is no longer protected)`;
  }
  if (name === undefined) return undefined;
  if (!named) {
    return `this entry was recorded with an --env-file ("${name}"), and whether that file was protected cannot be determined`;
  }
  const status = view.statusOf(name);
  if (status === "missing" || status === "failed") {
    return `this entry was recorded against the environment "${name}", which cannot be read now, so whether it was protected cannot be determined`;
  }
  return undefined;
}

/** エントリの中身(リクエスト・レスポンス・アサーション・エラー・スナップショットの候補)を外し、メタデータと理由だけにする */
function withhold(entry: HistoryEntry, reason: string): GuardedEntry {
  return {
    v: entry.v,
    runId: entry.runId,
    flow: entry.flow,
    step: entry.step,
    startedAt: entry.startedAt,
    durationMs: entry.durationMs,
    status: resolveHistoryEntryStatus(entry),
    ...(entry.iteration !== undefined ? { iteration: entry.iteration } : {}),
    ...(entry.errorCode !== undefined ? { errorCode: entry.errorCode } : {}),
    ...(entry.env !== undefined ? { env: entry.env } : {}),
    ...(entry.envProtection !== undefined ? { envProtection: entry.envProtection } : {}),
    ...(entry.file !== undefined ? { file: entry.file } : {}),
    ...(entry.actor !== undefined ? { actor: entry.actor } : {}),
    assertions: [],
    withheld: `${reason}. The request and response are not shown; the user can view it with \`klaus history show ${entry.runId} --step ${entry.step}\` in a terminal.`,
  };
}

/** values を秘密として、文字列をすべて *** にした複製を返す(values が空なら元のまま) */
export function maskValues<T>(value: T, values: readonly string[]): T {
  return values.length === 0 ? value : maskDeep(value, expandSecretVariants(values));
}

/**
 * 履歴を読むツールが返すエントリを整える: 値を隠せないエントリは中身を出さず、それ以外は現在保護されている
 * すべての環境の値を隠す。履歴は CLI や UI が書いたもので、環境の値が保存されたまま入っていることがあるため
 */
export async function guardEntries(cwd: string, entries: HistoryEntry[]): Promise<GuardedEntry[]> {
  const view = await loadProtectionView(
    cwd,
    entries.map((entry) => entry.env),
  );
  return entries.map((entry) => {
    const reason = withholdReason(entry, view);
    return reason !== undefined ? withhold(entry, reason) : maskValues(entry, view.values);
  });
}
