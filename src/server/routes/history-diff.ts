/**
 * GET /api/history/diff が使うロジック。
 * 履歴(マスク済みで保存されている)から 2 つの run を引き、core の diffRuns の結果をそのまま返す
 * (klaus diff --json から CLI 専用の version を除いた形)。差分ロジック自体は core にしかない。
 * 履歴の内容は保存時点でマスク済みのため、ここでアンマスクは行わない。
 */
import type { Context } from "hono";
import {
  DEFAULT_IGNORED_HEADERS,
  diffRuns,
  type JsonPathPattern,
  parseJsonPathPattern,
  readAllHistoryEntries,
  resolveRunRef,
  selectRunEntries,
} from "../../core/index.js";
import { hasControlCharacter, RUN_ID_PATTERN } from "../validation.js";

/** ignorePath として受け付ける最大個数(病的なパターンの大量指定による負荷の抑制) */
export const MAX_IGNORE_PATHS = 20;
/** flow 名の最大長 */
const MAX_FLOW_LENGTH = 256;
/** CLI の klaus diff の既定と同じ、1 ステップ・1 セクションあたりに保持する差分の最大数 */
const MAX_DIFFERENCES = 50;

/** 同じクエリキーが複数回指定された場合は曖昧なので拒否する。未指定なら undefined を返す */
function singleQuery(
  c: Context,
  key: string,
): { ok: true; value: string | undefined } | { ok: false; message: string } {
  const values = c.req.queries(key) ?? [];
  if (values.length > 1) return { ok: false, message: `${key} must be specified at most once` };
  return { ok: true, value: values[0] };
}

/** GET /api/history/diff?a=&b=[&flow=][&ignorePath=...]: 2 つの run の差分を返す */
export async function handleHistoryDiff(c: Context, cwd: string): Promise<Response> {
  const a = singleQuery(c, "a");
  if (!a.ok) return c.json({ error: a.message }, 400);
  const b = singleQuery(c, "b");
  if (!b.ok) return c.json({ error: b.message }, 400);
  const flowQuery = singleQuery(c, "flow");
  if (!flowQuery.ok) return c.json({ error: flowQuery.message }, 400);

  const refA = a.value;
  const refB = b.value;
  if (!refA || !refB) return c.json({ error: "a and b are required" }, 400);
  for (const [name, ref] of [
    ["a", refA],
    ["b", refB],
  ] as const) {
    if (!RUN_ID_PATTERN.test(ref)) return c.json({ error: `${name} is not a valid run ID` }, 400);
  }

  const flow = flowQuery.value;
  if (flow !== undefined) {
    if (flow.length === 0 || flow.length > MAX_FLOW_LENGTH || hasControlCharacter(flow)) {
      return c.json({ error: "flow is invalid" }, 400);
    }
  }
  // latest / previous は flow の指定が必須(CLI と同じ。基準が曖昧になるため)
  for (const ref of [refA, refB]) {
    if ((ref === "latest" || ref === "previous") && flow === undefined) {
      return c.json({ error: `"${ref}" requires flow` }, 400);
    }
  }

  const ignoreSources = c.req.queries("ignorePath") ?? [];
  if (ignoreSources.length > MAX_IGNORE_PATHS) {
    return c.json({ error: `ignorePath can be specified at most ${MAX_IGNORE_PATHS} times` }, 400);
  }
  const ignorePaths: JsonPathPattern[] = [];
  for (const source of ignoreSources) {
    const pattern = parseJsonPathPattern(source);
    if (!pattern) {
      return c.json(
        {
          error: `invalid ignorePath "${source.slice(0, 80)}" (expected a JSONPath such as $.data.id, $.items[*].createdAt, or $..updatedAt)`,
        },
        400,
      );
    }
    ignorePaths.push(pattern);
  }

  const entries = await readAllHistoryEntries(cwd);
  const resolvedA = resolveRunRef(entries, refA, flow);
  if (!resolvedA.ok) return c.json({ error: resolvedA.message }, 404);
  const resolvedB = resolveRunRef(entries, refB, flow);
  if (!resolvedB.ok) return c.json({ error: resolvedB.message }, 404);

  // 同一ミリ秒のステップの順序を履歴の行順で確定させるため、追記順で取り出す(CLI と同じ)
  const entriesA = selectRunEntries(entries, resolvedA.runId, flow);
  const entriesB = selectRunEntries(entries, resolvedB.runId, flow);
  if (entriesA.length === 0 || entriesB.length === 0) {
    const missing = entriesA.length === 0 ? resolvedA.runId : resolvedB.runId;
    return c.json({ error: `run "${missing}" has no entries for flow "${flow}"` }, 404);
  }

  const diff = diffRuns(
    { runId: resolvedA.runId, entries: entriesA },
    { runId: resolvedB.runId, entries: entriesB },
    {
      ignoreHeaders: [...DEFAULT_IGNORED_HEADERS],
      ignorePaths,
      maxDifferences: MAX_DIFFERENCES,
    },
  );
  return c.json(diff);
}
