import type { HistoryActor, HistoryEntry } from "../api/types";

/** 再接続バックオフの初期値・上限(ms) */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/** UI 自身の実行直後に届く通知を「外部の実行」と区別しないための猶予(ms)。サーバーのデバウンス + ポーリング間隔より長く取る */
export const LOCAL_RUN_GRACE_MS = 3000;

/** 再接続までの待ち時間。attempt は 0 始まりの連続失敗回数で、指数的に伸びて上限で頭打ちになる */
export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt), BACKOFF_MAX_MS);
}

/** 通知が UI 自身の実行(実行中、または終了直後)に由来するとみなせるか */
export function isLocalRunEcho(
  localRunActive: boolean,
  lastLocalRunChangeAt: number,
  now: number,
): boolean {
  return localRunActive || now - lastLocalRunChangeAt < LOCAL_RUN_GRACE_MS;
}

/** 「新着」件数の更新。履歴を表示中は常に 0、それ以外は外部由来の通知のときだけ +1 */
export function nextNewRunCount(
  current: number,
  event: { viewingHistory: boolean; localEcho: boolean },
): number {
  if (event.viewingHistory) return 0;
  return event.localEcho ? current : current + 1;
}

/**
 * 読み込み済みの履歴件数。通知後の再取得で「読み込み済みの範囲を維持したまま」最新化するための limit に使う
 * (ページごとに再取得すると、先頭に新規分が増えた分だけ境界のエントリが欠落するため)。
 */
export function loadedEntryCount(
  data: { pages: Array<{ entries: unknown[] }> } | undefined,
  pageSize: number,
): number {
  const count = data ? data.pages.reduce((sum, page) => sum + page.entries.length, 0) : 0;
  return Math.max(count, pageSize);
}

/** 実行主体の表示用ラベル。agent / ci は名前があれば `agent:name` の形にする。旧エントリ(actor なし)は null */
export function formatActor(actor: HistoryActor | undefined): string | null {
  if (!actor) return null;
  return actor.name ? `${actor.kind}:${actor.name}` : actor.kind;
}

/** run(複数ステップ)の監査表示用に、ステップのうち最初に値を持つ actor / env を拾う */
export function pickAudit(steps: HistoryEntry[]): {
  actor: HistoryActor | undefined;
  env: string | undefined;
} {
  return {
    actor: steps.find((s) => s.actor)?.actor,
    env: steps.find((s) => s.env)?.env,
  };
}
