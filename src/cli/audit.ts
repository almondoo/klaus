/**
 * 履歴の監査項目(actor / git)を CLI 側で取得するヘルパー。
 * core は実行主体や git の状態を計算せず、ここで得た値を RunFlowOptions / ExecuteSingleRequestOptions
 * 経由で受け取って履歴へ記録するだけにする(依存方向を保つため)。
 */
import { execFile } from "node:child_process";
import type { HistoryActor, HistoryGit } from "../core/index.js";

/** git コマンドの実行タイムアウト(ミリ秒)。履歴の補助情報のために実行を遅らせないよう短くする */
const GIT_TIMEOUT_MS = 2000;

/** --actor の名前の最大長(履歴に任意の長大な文字列を残さないための上限) */
export const MAX_ACTOR_NAME_LENGTH = 100;

/**
 * エージェント実行を示す環境変数のマーカー。実在を確認できたものだけを載せている。
 * - CLAUDECODE: Claude Code が実行するシェルに設定される("1")
 * - AI_AGENT: 各種エージェントが設定する汎用の識別子(値はエージェント名。例: claude-code_...)
 * ほかのエージェントのマーカーは、実在を確認できたものからここに追加する。
 */
const AGENT_MARKERS: ReadonlyArray<{ variable: string; name?: string }> = [
  { variable: "CLAUDECODE", name: "claude-code" },
  { variable: "AI_AGENT" },
];

/**
 * 環境変数から実行主体を推定する。優先順位は「agent(既知のマーカー) > ci(CI) > human」。
 * CI は一般的な慣習(`CI` が空でも "false" / "0" でもない)に従って判定する。
 * actorName(--actor)が指定された場合は、推定した kind を保ったまま name だけを上書きする。
 */
export function detectActor(env: NodeJS.ProcessEnv, actorName?: string): HistoryActor {
  const detected = detectActorFromEnv(env);
  const name = actorName ?? detected.name;
  return name !== undefined ? { kind: detected.kind, name } : { kind: detected.kind };
}

function detectActorFromEnv(env: NodeJS.ProcessEnv): HistoryActor {
  for (const { variable, name } of AGENT_MARKERS) {
    const value = env[variable]?.trim();
    if (value === undefined || value === "" || value === "0" || value === "false") continue;
    // 名前が固定のマーカーはその名前、AI_AGENT のように値自体がエージェント名のものは値を使う
    const resolved = name ?? value.slice(0, MAX_ACTOR_NAME_LENGTH);
    return { kind: "agent", name: resolved };
  }
  const ci = env.CI?.trim().toLowerCase();
  if (ci !== undefined && ci !== "" && ci !== "false" && ci !== "0") {
    return { kind: "ci" };
  }
  return { kind: "human" };
}

/** git を実行して stdout を返す。失敗・タイムアウト時は undefined(例外にしない) */
function runGit(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      // fsmonitor フックなどリポジトリ設定由来の外部コマンドを実行させないため無効化する
      ["-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        // status によるインデックス更新(ロック取得)を避ける。読み取り専用の用途のため
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        windowsHide: true,
      },
      (error, stdout) => {
        resolve(error ? undefined : stdout);
      },
    );
  });
}

/**
 * cwd の git の状態(HEAD のコミットと、追跡対象ファイルの未コミット変更の有無)を取得する。
 * git が無い・リポジトリ外・コミットが無い・タイムアウトなど、どの失敗でも undefined を返し、
 * 履歴の git フィールドを省くだけにする(実行自体には影響させない)。
 * 未追跡ファイルは dirty に含めない(.klaus/ や出力ファイルによる常時 dirty を避けるため)。
 */
export async function resolveGitState(cwd: string): Promise<HistoryGit | undefined> {
  const [head, status] = await Promise.all([
    runGit(["rev-parse", "HEAD"], cwd),
    runGit(["status", "--porcelain", "--untracked-files=no"], cwd),
  ]);
  const commit = head?.trim();
  if (commit === undefined || commit === "" || status === undefined) return undefined;
  return { commit, dirty: status.trim() !== "" };
}
