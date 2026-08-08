import type { HistoryEntry } from "../api/client";

/** 履歴ブラウザで使う run 単位のグループ(純関数。render 時に導出する派生値) */
export interface HistoryRunGroup {
  runId: string;
  flow: string;
  /** グループ内で最も古いステップの startedAt(= run 開始時刻とみなす) */
  startedAt: string;
  durationMs: number;
  status: "passed" | "failed";
  steps: HistoryEntry[];
}

/**
 * 履歴エントリ(ステップ単位)を runId でグルーピングする。
 * - steps は startedAt 昇順(実行順)に並べ替える
 * - グループ自体は startedAt 降順(新しい順)で返す
 * - assertions に1件でも ok:false があれば group.status は "failed"
 */
export function groupHistoryByRun(entries: HistoryEntry[]): HistoryRunGroup[] {
  const groups = new Map<string, HistoryRunGroup>();

  for (const entry of entries) {
    const existing = groups.get(entry.runId);
    if (!existing) {
      groups.set(entry.runId, {
        runId: entry.runId,
        flow: entry.flow,
        startedAt: entry.startedAt,
        durationMs: entry.durationMs,
        status: entry.assertions.some((a) => !a.ok) ? "failed" : "passed",
        steps: [entry],
      });
      continue;
    }

    existing.steps.push(entry);
    existing.durationMs += entry.durationMs;
    if (entry.startedAt < existing.startedAt) existing.startedAt = entry.startedAt;
    if (entry.assertions.some((a) => !a.ok)) existing.status = "failed";
  }

  for (const group of groups.values()) {
    group.steps.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  return Array.from(groups.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
