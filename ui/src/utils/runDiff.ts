import type { BodyDiff, JsonDifference, JsonDifferenceKind, RunDiff, StepDiff } from "@/api/types";
import type { HistoryRunGroup } from "./history";

/** 単発リクエスト(klaus req / UI の単発実行)の flow 名。runner.ts が履歴に書く値 */
export const SINGLE_FLOW_NAME = "(single)";

/** 差分の種別の表示ラベル(色だけに意味を持たせないため、記号とあわせて表示する) */
export const DIFFERENCE_KIND_LABEL: Record<JsonDifferenceKind, { symbol: string; label: string }> =
  {
    added: { symbol: "+", label: "追加" },
    removed: { symbol: "-", label: "削除" },
    changed: { symbol: "~", label: "変更" },
    "type-changed": { symbol: "~", label: "型の変更" },
    "too-deep": { symbol: "~", label: "深すぎて比較不能" },
  };

/** ステップごとの比較結果の表示ラベル */
export const STEP_CHANGE_LABEL: Record<StepDiff["change"], string> = {
  same: "同じ",
  different: "差分あり",
  added: "追加",
  removed: "削除",
};

/**
 * 値を 1 行の表示用テキストにする(文字列は引用符つき、undefined は「(なし)」)。
 * limit を超える場合は先頭だけにして truncated を立てる(呼び出し側が「全文を表示」を出す)。
 */
export function previewValue(
  value: unknown,
  limit: number,
): { text: string; full: string; truncated: boolean } {
  const full = value === undefined ? "(なし)" : (JSON.stringify(value) ?? String(value));
  if (full.length <= limit) return { text: full, full, truncated: false };
  return { text: `${full.slice(0, limit)}…`, full, truncated: true };
}

const IDENTIFIER_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 差分のパス("$.items[0].createdAt")を除外パターンへ一般化する。
 * 配列の添字([0])を [*] に置き換え、同じ形の要素の差分を 1 つのパターンでまとめて除外できるようにする。
 * ['...'] の引用の中にある [数字] は(キー名の一部なので)置き換えない。
 */
export function generalizePath(path: string): string {
  let result = "";
  let i = 0;
  while (i < path.length) {
    if (path.startsWith("['", i)) {
      // 引用つきキー: 閉じ ']' までそのままコピーする(\' のエスケープを考慮)
      let j = i + 2;
      while (j < path.length) {
        if (path[j] === "\\") j += 2;
        else if (path[j] === "'" && path[j + 1] === "]") break;
        else j += 1;
      }
      const end = Math.min(j + 2, path.length);
      result += path.slice(i, end);
      i = end;
      continue;
    }
    const index = /^\[\d+\]/.exec(path.slice(i));
    if (index) {
      result += "[*]";
      i += index[0].length;
      continue;
    }
    result += path[i];
    i += 1;
  }
  return result;
}

/** パスの最後のキー名(末尾が配列の添字・ワイルドカードなら undefined) */
export function lastKeyOf(path: string): string | undefined {
  const quoted = /\['((?:[^'\\]|\\.)*)'\]$/.exec(path);
  if (quoted) return (quoted[1] as string).replace(/\\(.)/g, "$1");
  const dotted = /\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(path);
  return dotted ? dotted[1] : undefined;
}

// 実行のたびに変わりやすいキー名(id・時刻・トークン・リクエスト識別子など)
const VOLATILE_KEY =
  /^(id|uuid|guid|etag|nonce|token|ts|timestamp|time|date|expires|expiry|requestid|traceid|spanid|correlationid)$|(Id|ID|At|_at|_id|Time|Timestamp|Date)$/;

/** キー名が揮発しやすい(実行ごとに変わりがち)値らしいか */
export function isVolatileKey(key: string | undefined): boolean {
  return key !== undefined && IDENTIFIER_KEY.test(key) && VOLATILE_KEY.test(key);
}

export interface IgnoreSuggestion {
  /** 除外パターン(JSONPath) */
  pattern: string;
  /** 揮発しやすいキーらしいか(先頭に並べ、ラベルで示す) */
  volatile: boolean;
  /** このパターンに該当する差分の件数 */
  count: number;
}

function collectDifferences(step: StepDiff): JsonDifference[] {
  const lists: Array<JsonDifference[] | undefined> = [
    step.body?.kind === "json" ? step.body.differences : undefined,
    step.request?.body?.kind === "json" ? step.request.body.differences : undefined,
    step.events?.differences,
  ];
  return lists.flatMap((list) => list ?? []);
}

/**
 * 差分に現れたパスから、除外パターンの候補を作る。
 * 揮発しやすいキー(id・createdAt 等)を先頭に、該当件数の多い順に並べる。
 * 既に除外済みのパターンと too-deep(パスの末端ではないため)は含めない。
 */
export function suggestIgnorePaths(
  steps: readonly StepDiff[],
  ignored: readonly string[],
  limit = 12,
): IgnoreSuggestion[] {
  const counts = new Map<string, number>();
  for (const step of steps) {
    for (const difference of collectDifferences(step)) {
      if (difference.kind === "too-deep") continue;
      const pattern = generalizePath(difference.path);
      if (pattern === "$" || ignored.includes(pattern)) continue;
      counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
    }
  }
  const suggestions = [...counts.entries()].map(([pattern, count]) => ({
    pattern,
    count,
    volatile: isVolatileKey(lastKeyOf(pattern)),
  }));
  suggestions.sort(
    (x, y) =>
      Number(y.volatile) - Number(x.volatile) ||
      y.count - x.count ||
      x.pattern.localeCompare(y.pattern),
  );
  return suggestions.slice(0, limit);
}

/** 除外パスの入力を正規化する(前後の空白を除く)。空・重複・"$" で始まらないものは null */
export function normalizeIgnoreInput(input: string, current: readonly string[]): string | null {
  const value = input.trim();
  if (value === "" || !value.startsWith("$") || current.includes(value)) return null;
  return value;
}

/** 本文の差分の件数(省略された分を含む総数) */
export function bodyDiffTotal(body: BodyDiff | undefined): number {
  if (!body) return 0;
  if (body.kind === "json") return body.total;
  return body.added + body.removed;
}

/** ステップの差分のうち「リクエスト側」の件数(メソッド・URL・body) */
export function requestChangeCount(step: StepDiff): number {
  const request = step.request;
  if (!request) return 0;
  return (request.method ? 1 : 0) + (request.url ? 1 : 0) + bodyDiffTotal(request.body);
}

/** ステップの差分のうち「レスポンス側」の件数(ヘッダー・body・イベント) */
export function responseChangeCount(step: StepDiff): number {
  const headers = step.responseHeaders;
  const headerCount = headers
    ? Object.keys(headers.added).length +
      Object.keys(headers.removed).length +
      Object.keys(headers.changed).length
    : 0;
  return headerCount + bodyDiffTotal(step.body) + (step.events?.total ?? 0);
}

/** ステップ件数の内訳の要約文 */
export function describeCounts(counts: RunDiff["counts"]): string {
  return `同じ ${counts.same} / 差分あり ${counts.different} / 追加 ${counts.added} / 削除 ${counts.removed}`;
}

/** 比較対象にする run のフロー名(--data の iteration 付き表示名ではなく、履歴に記録された名前) */
export function rawFlowOf(group: HistoryRunGroup): string {
  return group.steps[0]?.flow ?? group.flow;
}

/** 単発リクエスト(各 run が 1 回きりでフローの前回という概念が無い)の run か */
export function isSingleGroup(group: HistoryRunGroup): boolean {
  return group.steps.length > 0 && group.steps.every((step) => step.flow === SINGLE_FLOW_NAME);
}

/**
 * 「前回の同じフローと比較」の相手を探す。groups は新しい順(groupHistoryByRun の戻り値)。
 * target と同じフロー(履歴の記録名)で、より古く、runId が異なる直近の run を返す。単発リクエストは対象外。
 */
export function findPreviousRun(
  groups: readonly HistoryRunGroup[],
  target: HistoryRunGroup,
): HistoryRunGroup | undefined {
  if (isSingleGroup(target)) return undefined;
  const flow = rawFlowOf(target);
  return groups.find(
    (group) =>
      group.runId !== target.runId &&
      group.startedAt < target.startedAt &&
      rawFlowOf(group) === flow &&
      !isSingleGroup(group),
  );
}

/** 2 つの run を古い方を A(前)、新しい方を B(後)に並べる */
export function orderRunPair(
  x: Pick<HistoryRunGroup, "runId" | "startedAt">,
  y: Pick<HistoryRunGroup, "runId" | "startedAt">,
): { a: string; b: string } {
  return x.startedAt <= y.startedAt ? { a: x.runId, b: y.runId } : { a: y.runId, b: x.runId };
}

/** 2 つの run が同じフローの比較に使える共通のフロー名を返す(違う・単発なら undefined = 全体を比較) */
export function commonFlow(x: HistoryRunGroup, y: HistoryRunGroup): { flow?: string } {
  const flow = rawFlowOf(x);
  return flow === rawFlowOf(y) && !isSingleGroup(x) ? { flow } : {};
}

/** ステップ見出しに並べる、差分の要約(ステータスの変化と、リクエスト・レスポンスの差分の件数) */
export function summarizeStep(step: StepDiff): string[] {
  const parts: string[] = [];
  if (step.status) {
    parts.push(`状態 ${step.status.a ?? "(なし)"} → ${step.status.b ?? "(なし)"}`);
  }
  if (step.httpStatus) {
    parts.push(`HTTP ${step.httpStatus.a ?? "(なし)"} → ${step.httpStatus.b ?? "(なし)"}`);
  }
  const request = requestChangeCount(step);
  if (request > 0) parts.push(`リクエスト ${request} 件`);
  const response = responseChangeCount(step);
  if (response > 0) parts.push(`レスポンス ${response} 件`);
  if (step.error) parts.push("エラー内容が変化");
  if (step.durationMs)
    parts.push(
      `所要時間 ${step.durationMs.delta > 0 ? "+" : ""}${Math.round(step.durationMs.delta)}ms`,
    );
  return parts;
}

/**
 * 同じ基本キーが複数回現れるリストに、出現順の番号を付けた安定キーを振る
 * (配列の添字を key にせず、同じパス・同じステップが繰り返される場合にも一意にするため)。
 */
export function withOccurrenceKeys<T>(
  items: readonly T[],
  baseKeyOf: (item: T) => string,
): Array<{ key: string; item: T }> {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = baseKeyOf(item);
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return { key: `${base}#${occurrence}`, item };
  });
}
