import type { HistoryEntry } from "../api/client";

/** ステップ単体の状態(HistoryEntry.status と同じ語彙) */
export type HistoryStepStatus = "passed" | "failed" | "skipped";

/** 履歴ブラウザで使う run 単位のグループ(純関数。render 時に導出する派生値) */
export interface HistoryRunGroup {
  runId: string;
  /** --data 実行時のみ設定される 1 始まりのイテレーション番号(グループ内の全エントリで共通) */
  iteration?: number;
  /** --data 実行時は CLI レポーターと同じ語彙で ` (iteration N)` を付加したフロー名(表示用の派生値) */
  flow: string;
  /** グループ内で最も古いステップの startedAt(= run 開始時刻とみなす) */
  startedAt: string;
  durationMs: number;
  status: HistoryStepStatus;
  steps: HistoryEntry[];
}

/**
 * ステップ1件分の状態を判定する。
 * - status フィールドがあればそれをそのまま使う
 * - 無ければ(旧エントリ)従来通り assertions から導出する(1件でも ok:false があれば "failed")
 */
export function resolveStepStatus(entry: HistoryEntry): HistoryStepStatus {
  if (entry.status) return entry.status;
  return entry.assertions.some((a) => !a.ok) ? "failed" : "passed";
}

/**
 * グループ(run)全体の状態を、含まれる全ステップの状態から導出する。
 * - 1件でも "failed" があれば group は "failed"(skipped は failed に影響しない)
 * - failed が無く、全ステップが "skipped" なら group も "skipped"
 *   (全ステップがスキップされた run を "passed" と偽装せず、既存の "skipped" 語彙をそのまま使う)
 * - それ以外(skipped でないステップが1件でもあり、failed が無い)は "passed"
 */
function resolveGroupStatus(steps: HistoryEntry[]): HistoryStepStatus {
  const stepStatuses = steps.map(resolveStepStatus);
  if (stepStatuses.some((s) => s === "failed")) return "failed";
  if (stepStatuses.every((s) => s === "skipped")) return "skipped";
  return "passed";
}

/**
 * グループの表示用フロー名を組み立てる。
 * --data 実行時のみ、CLI レポーター(src/cli/reporters/text.ts の formatFlowHeader)と同じ語彙で
 * 末尾に ` (iteration N)` を付加する(通常実行ではこれまでどおりフロー名のみ)。
 */
function formatGroupFlowLabel(flow: string, iteration?: number): string {
  return iteration !== undefined ? `${flow} (iteration ${iteration})` : flow;
}

/**
 * 履歴エントリ(ステップ単位)を runId でグルーピングする。
 * --data 実行では同一 runId の下に複数 iteration の行が混在するため、runId だけでなく
 * iteration も含めてグルーピングキーとする(iteration が無い通常実行では従来どおり runId のみで一意)。
 * - steps は startedAt 昇順(実行順)に並べ替える
 * - グループ自体は startedAt 降順(新しい順)で返す
 * - グループの status は resolveGroupStatus を参照
 */
export function groupHistoryByRun(entries: HistoryEntry[]): HistoryRunGroup[] {
  const groups = new Map<string, HistoryRunGroup>();

  for (const entry of entries) {
    const key = entry.iteration !== undefined ? `${entry.runId}:${entry.iteration}` : entry.runId;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        runId: entry.runId,
        iteration: entry.iteration,
        flow: formatGroupFlowLabel(entry.flow, entry.iteration),
        startedAt: entry.startedAt,
        durationMs: entry.durationMs,
        // 仮値。全ステップが揃った後段の resolveGroupStatus で確定させる
        status: "passed",
        steps: [entry],
      });
      continue;
    }

    existing.steps.push(entry);
    existing.durationMs += entry.durationMs;
    if (entry.startedAt < existing.startedAt) existing.startedAt = entry.startedAt;
  }

  for (const group of groups.values()) {
    group.steps.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    group.status = resolveGroupStatus(group.steps);
  }

  return Array.from(groups.values()).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
