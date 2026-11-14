import type {
  AssertionResult,
  OpenApiRunSummary,
  OpenApiState,
  SnapshotMismatch,
  SnapshotState,
} from "@/api/types";

/** スナップショットの状態の表示ラベル(色だけに意味を持たせないため、テキストとあわせて表示する) */
export const SNAPSHOT_STATE_LABEL: Record<SnapshotState, string> = {
  matched: "一致",
  written: "新規に基準を書き込み",
  updated: "基準を更新",
  mismatch: "不一致",
  missing: "基準なし(書き込まれていない)",
};

/** OpenAPI 検証の状態の表示ラベル */
export const OPENAPI_STATE_LABEL: Record<OpenApiState, string> = {
  valid: "仕様どおり",
  invalid: "仕様に違反",
  undocumented: "仕様に記載なし",
  unmatched: "対応するオペレーションなし",
  skipped: "検証できず",
};

/** 一覧を上限件数に切り詰め、省略した件数を返す(total は切り詰め前の総数。省略時は items.length) */
export function capList<T>(
  items: readonly T[],
  max: number,
  total?: number,
): { shown: T[]; omitted: number } {
  const shown = items.slice(0, max);
  return { shown, omitted: Math.max((total ?? items.length) - shown.length, 0) };
}

/** 別オリジンへのリダイレクトで落としたヘッダーの 1 行表示 */
export function describeDroppedHeaders(dropped: { hop: number; headers: string[] }): string {
  return `${dropped.hop} 回目のリダイレクトで ${dropped.headers.join(", ")} を落としました`;
}

export interface SnapshotCounts {
  matched: number;
  written: number;
  updated: number;
  mismatch: number;
  missing: number;
}

/** ステップ群の snapshot アサーションを状態別に数える(snapshot アサーションが無ければ undefined) */
export function countSnapshotStates(
  steps: ReadonlyArray<{ assertions: readonly AssertionResult[] }>,
): SnapshotCounts | undefined {
  const counts: SnapshotCounts = { matched: 0, written: 0, updated: 0, mismatch: 0, missing: 0 };
  let any = false;
  for (const step of steps) {
    for (const assertion of step.assertions) {
      const state = assertion.snapshot?.state;
      if (state === undefined) continue;
      any = true;
      counts[state] += 1;
    }
  }
  return any ? counts : undefined;
}

/** 承認待ち(不一致・基準なし)の snapshot アサーションを含むか(履歴の run 詳細で、承認 UI を出すかの判定) */
export function hasPendingSnapshot(
  entries: ReadonlyArray<{ assertions: readonly AssertionResult[] }>,
): boolean {
  return entries.some((entry) =>
    entry.assertions.some(
      (assertion) =>
        assertion.snapshot?.state === "mismatch" || assertion.snapshot?.state === "missing",
    ),
  );
}

/** 承認待ち 1 件を識別するキー(同じファイルの同じキー) */
export function mismatchId(item: Pick<SnapshotMismatch, "snapshotFile" | "key">): string {
  return `${item.snapshotFile}\u0000${item.key}`;
}

/** 承認の結果の表示文 */
export function describeAcceptState(state: "written" | "updated"): string {
  return state === "written" ? "新しいキーとして書き込みました" : "既存のキーを置き換えました";
}

/** 承認待ちを書き込み先のファイルごとにまとめる(確認画面用。ファイル名順、キーは元の順) */
export function groupMismatchesByFile(
  items: readonly SnapshotMismatch[],
): Array<{ file: string; items: SnapshotMismatch[] }> {
  const map = new Map<string, SnapshotMismatch[]>();
  for (const item of items) {
    const list = map.get(item.snapshotFile) ?? [];
    list.push(item);
    map.set(item.snapshotFile, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, list]) => ({ file, items: list }));
}

/** 承認待ちの識別(ステップ名・iteration)。差分パネルのステップ単位の表示に使う */
export function mismatchesForStep(
  items: readonly SnapshotMismatch[],
  step: { flow: string; step: string; iteration?: number | undefined },
): SnapshotMismatch[] {
  return items.filter(
    (item) =>
      item.flow === step.flow && item.step === step.step && item.iteration === step.iteration,
  );
}

/** OpenAPI カバレッジの 1 行要約 */
export function describeOpenApiCoverage(summary: OpenApiRunSummary): string {
  const { total, covered, percent } = summary.operations;
  return `オペレーション ${covered} / ${total}(${percent}%)を照合、仕様違反 ${summary.violations} 件`;
}
