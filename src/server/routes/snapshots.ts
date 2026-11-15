/**
 * GET /api/snapshots/mismatches と POST /api/snapshots/accept が使うロジック。
 * 履歴に記録された snapshot アサーションの不一致・未記録(承認待ち)を一覧し、人間が確認したものを
 * 基準(__snapshots__/*.snap.json)として書き込む。列挙と書き込みの本体は core の
 * listSnapshotMismatches / acceptSnapshot にしかない(ここでは再実装しない)。
 *
 * 承認は「リポジトリ内のファイルを書き換える」操作なので、次の制限をかける:
 * - クライアントが渡す snapshotFile / key は、その run の承認待ちとして core が返したものに限る(任意のパスを core に渡さない)
 * - run が実行された環境が保護環境($protected: true / readonly)の場合は承認を拒否する。core は保護環境で基準を暗黙に
 *   書かない。UI はエージェントも操作し得る経路で、環境ファイルの UI 編集も保護環境には拒否しているため、同じ方針に揃える
 *   (保護環境の基準を更新するには CLI の `klaus snapshot accept` を使う)。環境を判定できない場合も fail closed
 */
import type { Context } from "hono";
import { isProtectedEnvironment, resolveEnvironmentPath } from "../../core/env.js";
import {
  type AcceptSnapshotResult,
  acceptSnapshot,
  type HistoryEntry,
  listSnapshotMismatches,
  loadEnvironmentFile,
  readAllHistoryEntries,
  type SnapshotMismatch,
  selectRunEntries,
} from "../../core/index.js";
import { parseJsonBody } from "../json-body.js";
import {
  ENV_NAME_PATTERN,
  hasControlCharacter,
  RUN_ID_PATTERN,
  resolveWithinCwd,
} from "../validation.js";

const MAX_SNAPSHOT_FILE_LENGTH = 512;
const MAX_KEY_LENGTH = 1024;

/** GET /api/snapshots/mismatches のレスポンス */
export interface SnapshotMismatchesPayload {
  runId: string;
  mismatches: SnapshotMismatch[];
  /** 承認できない理由(保護環境の run など)。あれば UI は承認操作を無効にして理由を示す */
  acceptRefusal?: string;
}

/**
 * run が保護環境で実行されていて承認できない場合に、その理由を返す(承認できるなら undefined)。
 * 履歴の env は環境名(--env-file の場合はファイル名)。環境ファイルを名前で読めない・読み込めないものは判定できないため拒否する。
 */
export async function findAcceptRefusal(
  cwd: string,
  entries: readonly HistoryEntry[],
): Promise<string | undefined> {
  const envNames = new Set<string>();
  for (const entry of entries) if (entry.env !== undefined) envNames.add(entry.env);
  for (const name of envNames) {
    if (!ENV_NAME_PATTERN.test(name)) {
      return `the environment "${name}" of this run cannot be verified as unprotected (it was not a named environment); accept it with \`klaus snapshot accept\` instead`;
    }
    try {
      if (isProtectedEnvironment(await loadEnvironmentFile(resolveEnvironmentPath(cwd, name)))) {
        return `environment "${name}" is protected; snapshots from a run against it cannot be accepted via the UI (use \`klaus snapshot accept\`)`;
      }
    } catch {
      return `the environment "${name}" of this run could not be read to verify that it is not protected; accept it with \`klaus snapshot accept\` instead`;
    }
  }
  // 環境の今の状態に依らず、履歴に「保護された環境で書かれた」と記録されていれば拒否する(後から保護が外されても承認させない)
  if (entries.some((entry) => entry.envProtection !== undefined)) {
    return "this run was recorded against a protected environment; snapshots from it cannot be accepted via the UI (use `klaus snapshot accept`)";
  }
  return undefined;
}

/** GET /api/snapshots/mismatches?runId=: run の承認待ちスナップショットを返す */
export async function handleSnapshotMismatches(c: Context, cwd: string): Promise<Response> {
  const runIds = c.req.queries("runId") ?? [];
  const runId = runIds[0];
  if (runIds.length !== 1 || !runId || !RUN_ID_PATTERN.test(runId)) {
    return c.json({ error: "runId is required and must be a valid run ID" }, 400);
  }
  const entries = selectRunEntries(await readAllHistoryEntries(cwd), runId);
  if (entries.length === 0) {
    return c.json({ error: `no history entries found for runId "${runId}"` }, 404);
  }
  const mismatches = await listSnapshotMismatches(cwd, runId);
  const refusal = mismatches.length > 0 ? await findAcceptRefusal(cwd, entries) : undefined;
  const payload: SnapshotMismatchesPayload = {
    runId,
    mismatches,
    ...(refusal !== undefined ? { acceptRefusal: refusal } : {}),
  };
  return c.json(payload);
}

/** POST /api/snapshots/accept: 承認待ちの 1 件を基準として書き込む */
export async function handleSnapshotAccept(c: Context, cwd: string): Promise<Response> {
  const body = await parseJsonBody<Record<string, unknown>>(c);
  if (body === undefined) return c.json({ error: "invalid JSON body" }, 400);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "request body must be a JSON object" }, 400);
  }
  for (const key of Object.keys(body)) {
    if (key !== "runId" && key !== "snapshotFile" && key !== "key") {
      return c.json({ error: `unknown field "${key}"` }, 400);
    }
  }
  const { runId, snapshotFile, key } = body;
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    return c.json({ error: "runId must be a valid run ID" }, 400);
  }
  if (
    typeof snapshotFile !== "string" ||
    snapshotFile.length === 0 ||
    snapshotFile.length > MAX_SNAPSHOT_FILE_LENGTH ||
    hasControlCharacter(snapshotFile)
  ) {
    return c.json({ error: "snapshotFile is invalid" }, 400);
  }
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_KEY_LENGTH ||
    hasControlCharacter(key)
  ) {
    return c.json({ error: "key is invalid" }, 400);
  }
  const outcome = await acceptPendingSnapshot(cwd, { runId, snapshotFile, key });
  if (outcome.ok) return c.json(outcome.result);
  switch (outcome.kind) {
    case "forbidden":
      return c.text(`Forbidden: ${outcome.message}`, 403);
    case "not-found":
      return c.json({ error: outcome.message }, 404);
    case "failed-step":
      // そのステップの他のアサーションが失敗していた(失敗した応答は基準にできない)。状態の衝突として 409 にする
      return c.json({ error: outcome.message }, 409);
    default:
      return c.json({ error: outcome.message }, 422);
  }
}

/** acceptPendingSnapshot の入力。形式(長さ・制御文字・runId の書式)の検証は呼び出し側が済ませておく */
export interface AcceptPendingSnapshotInput {
  runId: string;
  snapshotFile: string;
  key: string;
}

/**
 * acceptPendingSnapshot の結果。forbidden は拒否(メッセージに "Forbidden: " は含めない)、not-found は run または承認待ちが無い、
 * failed-step は他のアサーションが失敗していた、corrupt / unsafe 相当の残りは "invalid"(HTTP では 422)
 */
export type AcceptPendingSnapshotOutcome =
  | { ok: true; result: Extract<AcceptSnapshotResult, { ok: true }> }
  | { ok: false; kind: "forbidden" | "not-found" | "failed-step" | "invalid"; message: string };

/**
 * 承認待ちの 1 件を基準として書き込む(Hono 非依存。POST /api/snapshots/accept と klaus mcp が共有する)。
 * 呼び出し側は runId / snapshotFile / key の形式を検証済みであること。ここでは次の順に拒否する:
 * バックスラッシュ → cwd 外のパス → run が履歴に無い → 承認待ちの組でない → 保護環境の run → core の書き込み失敗。
 */
export async function acceptPendingSnapshot(
  cwd: string,
  input: AcceptPendingSnapshotInput,
): Promise<AcceptPendingSnapshotOutcome> {
  const { runId, snapshotFile, key } = input;
  // バックスラッシュを含むパスは一律に拒否する(区切りの解釈が環境で変わり得るため)
  if (snapshotFile.includes("\\")) {
    return {
      ok: false,
      kind: "forbidden",
      message: "backslashes are not allowed in snapshotFile",
    };
  }
  // cwd の外を指すパス(.. ・絶対パス・リンク経由)は、承認待ちの照合より前に拒否する
  if (!resolveWithinCwd(cwd, snapshotFile)) {
    return { ok: false, kind: "forbidden", message: "path traversal detected" };
  }

  const entries = selectRunEntries(await readAllHistoryEntries(cwd), runId);
  if (entries.length === 0) {
    return {
      ok: false,
      kind: "not-found",
      message: `no history entries found for runId "${runId}"`,
    };
  }
  // core が返した承認待ちに含まれる組だけを受け付ける(クライアントのパスをそのまま core に渡さない)
  const pending = await listSnapshotMismatches(cwd, runId);
  const target = pending.find((item) => item.snapshotFile === snapshotFile && item.key === key);
  if (!target) {
    return {
      ok: false,
      kind: "not-found",
      message: `run "${runId}" has no pending snapshot "${key}" for "${snapshotFile}"`,
    };
  }

  const refusal = await findAcceptRefusal(cwd, entries);
  if (refusal !== undefined) return { ok: false, kind: "forbidden", message: refusal };

  const result = await acceptSnapshot(cwd, runId, {
    snapshotFile: target.snapshotFile,
    key: target.key,
  });
  if (result.ok) return { ok: true, result };
  switch (result.kind) {
    case "not-found":
      return { ok: false, kind: "not-found", message: result.message };
    case "unsafe":
      return { ok: false, kind: "forbidden", message: result.message };
    case "failed-step":
      return { ok: false, kind: "failed-step", message: result.message };
    default:
      return { ok: false, kind: "invalid", message: result.message };
  }
}
