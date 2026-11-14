import type { BodyDiff, DifferenceList, RunDiff, RunSummary, StepDiff } from "../../core/index.js";
import { sanitizeForTerminal } from "./sanitize.js";

/** klaus diff --json の出力ペイロード(v1)。後方互換が壊れる変更をする場合は version を上げる */
export interface DiffReport extends RunDiff {
  version: 1;
}

export function buildDiffReport(diff: RunDiff): DiffReport {
  return { version: 1, ...diff };
}

const TRUNCATION_SUFFIX = "...(truncated)";

/** 値を max 文字に切り詰める。文字列は文字列のまま、それ以外は max を超える場合のみ JSON 文字列にして切り詰める */
function limitValue(value: unknown, max: number): unknown {
  if (typeof value === "string") {
    return value.length > max ? `${value.slice(0, max)}${TRUNCATION_SUFFIX}` : value;
  }
  if (value === undefined) return value;
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}${TRUNCATION_SUFFIX}` : value;
}

function limitDifferences(list: DifferenceList, max: number): DifferenceList {
  return {
    ...list,
    differences: list.differences.map((difference) => ({
      ...difference,
      ...("before" in difference ? { before: limitValue(difference.before, max) } : {}),
      ...("after" in difference ? { after: limitValue(difference.after, max) } : {}),
    })),
  };
}

function limitBody(body: BodyDiff, max: number): BodyDiff {
  if (body.kind === "json") return { ...body, ...limitDifferences(body, max) };
  return {
    ...body,
    lines: body.lines.map((change) => ({
      ...change,
      line: limitValue(change.line, max) as string,
    })),
  };
}

function limitChange<T>(
  change: { a?: T; b?: T } | undefined,
  max: number,
): { a?: T; b?: T } | undefined {
  if (!change) return change;
  return {
    ...("a" in change ? { a: limitValue(change.a, max) as T } : {}),
    ...("b" in change ? { b: limitValue(change.b, max) as T } : {}),
  };
}

/** --max-value-length 指定時に、差分に含まれる値(body の値・ヘッダー値・URL・エラー)を切り詰めたレポートを返す */
export function truncateReportValues(report: DiffReport, max: number): DiffReport {
  const steps = report.steps.map((step): StepDiff => {
    const next: StepDiff = { ...step };
    if (step.body) next.body = limitBody(step.body, max);
    if (step.events) next.events = limitDifferences(step.events, max);
    if (step.error) next.error = limitChange(step.error, max) as StepDiff["error"] & object;
    if (step.request) {
      next.request = {
        ...step.request,
        ...(step.request.url
          ? { url: limitChange(step.request.url, max) as { a?: string; b?: string } }
          : {}),
        ...(step.request.body ? { body: limitBody(step.request.body, max) } : {}),
      };
    }
    if (step.responseHeaders) {
      const cut = (value: string): string => limitValue(value, max) as string;
      next.responseHeaders = {
        added: Object.fromEntries(
          Object.entries(step.responseHeaders.added).map(([k, v]) => [k, cut(v)]),
        ),
        removed: Object.fromEntries(
          Object.entries(step.responseHeaders.removed).map(([k, v]) => [k, cut(v)]),
        ),
        changed: Object.fromEntries(
          Object.entries(step.responseHeaders.changed).map(([k, v]) => [
            k,
            { a: cut(v.a), b: cut(v.b) },
          ]),
        ),
      };
    }
    return next;
  });
  return { ...report, steps };
}

export function formatDiffJson(report: DiffReport): string {
  return JSON.stringify(report);
}

/** text 出力の既定の値の最大長(JSON では --max-value-length 指定が無い限り切り詰めない) */
export const DEFAULT_TEXT_MAX_VALUE_LENGTH = 80;

function show(value: unknown, max: number): string {
  if (value === undefined) return "(none)";
  const text = JSON.stringify(value);
  return sanitizeForTerminal(
    text.length > max ? `${text.slice(0, max)}${TRUNCATION_SUFFIX}` : text,
  );
}

function formatRun(label: string, run: RunSummary): string {
  const parts = [`${label} ${run.runId}`, run.startedAt, `${run.steps} step(s)`, run.status];
  if (run.env) parts.push(`env=${run.env}`);
  if (run.actor) parts.push(`actor=${run.actor.kind}${run.actor.name ? `:${run.actor.name}` : ""}`);
  if (run.git) parts.push(`git=${run.git.commit.slice(0, 7)}${run.git.dirty ? "+dirty" : ""}`);
  return sanitizeForTerminal(parts.join("  "));
}

function describeStep(step: StepDiff): string {
  const iteration = step.iteration !== undefined ? ` (iteration ${step.iteration})` : "";
  return sanitizeForTerminal(`${step.flow} / ${step.step}${iteration}`);
}

function formatList(list: DifferenceList, max: number, indent: string): string[] {
  const lines = list.differences.map((difference) => {
    const path = sanitizeForTerminal(difference.path);
    switch (difference.kind) {
      case "added":
        return `${indent}+ ${path}: ${show(difference.after, max)}`;
      case "removed":
        return `${indent}- ${path}: ${show(difference.before, max)}`;
      case "too-deep":
        return `${indent}~ ${path}: too deep to compare (the subtrees differ)`;
      case "type-changed":
        return `${indent}~ ${path} (type): ${show(difference.before, max)} -> ${show(difference.after, max)}`;
      default:
        return `${indent}~ ${path}: ${show(difference.before, max)} -> ${show(difference.after, max)}`;
    }
  });
  if (list.omitted > 0) lines.push(`${indent}... and ${list.omitted} more`);
  return lines;
}

function formatBody(body: BodyDiff, max: number, indent: string): string[] {
  if (body.kind === "json") return formatList(body, max, indent);
  const lines = [`${indent}text: +${body.added} -${body.removed} line(s)`];
  for (const change of body.lines) {
    lines.push(`${indent}${change.op} ${sanitizeForTerminal(change.line.slice(0, max))}`);
  }
  if (body.omitted > 0) lines.push(`${indent}... and ${body.omitted} more`);
  return lines;
}

function formatStep(step: StepDiff, max: number): string[] {
  if (step.change === "added") return [`+ ${describeStep(step)}  (only in B)`];
  if (step.change === "removed") return [`- ${describeStep(step)}  (only in A)`];
  const lines = [`~ ${describeStep(step)}`];
  if (step.status) lines.push(`  status: ${step.status.a} -> ${step.status.b}`);
  if (step.httpStatus) {
    lines.push(
      `  http status: ${step.httpStatus.a ?? "(none)"} -> ${step.httpStatus.b ?? "(none)"}`,
    );
  }
  if (step.error) {
    lines.push(`  error: ${show(step.error.a, max)} -> ${show(step.error.b, max)}`);
  }
  if (step.request) {
    lines.push("  request changed:");
    if (step.request.method) {
      lines.push(
        `    method: ${step.request.method.a ?? "(none)"} -> ${step.request.method.b ?? "(none)"}`,
      );
    }
    if (step.request.url) {
      lines.push(`    url: ${show(step.request.url.a, max)} -> ${show(step.request.url.b, max)}`);
    }
    if (step.request.body) {
      lines.push("    body:", ...formatBody(step.request.body, max, "      "));
    }
  }
  if (step.responseHeaders) {
    lines.push("  response headers:");
    for (const [name, value] of Object.entries(step.responseHeaders.added)) {
      lines.push(`    + ${sanitizeForTerminal(name)}: ${show(value, max)}`);
    }
    for (const [name, value] of Object.entries(step.responseHeaders.removed)) {
      lines.push(`    - ${sanitizeForTerminal(name)}: ${show(value, max)}`);
    }
    for (const [name, value] of Object.entries(step.responseHeaders.changed)) {
      lines.push(
        `    ~ ${sanitizeForTerminal(name)}: ${show(value.a, max)} -> ${show(value.b, max)}`,
      );
    }
  }
  if (step.body) lines.push("  response body:", ...formatBody(step.body, max, "    "));
  if (step.events) lines.push("  events:", ...formatList(step.events, max, "    "));
  if (step.durationMs) {
    const sign = step.durationMs.delta >= 0 ? "+" : "";
    lines.push(
      `  duration: ${Math.round(step.durationMs.a)}ms -> ${Math.round(step.durationMs.b)}ms (${sign}${Math.round(step.durationMs.delta)}ms)`,
    );
  }
  return lines;
}

/** diff の text 出力。差分のあるステップだけを列挙し、同一のステップは件数のみ示す */
export function formatDiffText(report: DiffReport, maxValueLength: number): string {
  const { counts } = report;
  const lines = [formatRun("A", report.runs.a), formatRun("B", report.runs.b), ""];
  const differing = counts.different + counts.added + counts.removed;
  lines.push(
    report.status === "same"
      ? `same: ${counts.same} step(s) compared, no differences`
      : `different: ${differing} of ${report.steps.length} step(s) differ (${counts.different} changed, ${counts.added} added, ${counts.removed} removed; ${counts.same} same)`,
  );
  for (const step of report.steps) {
    if (step.change === "same") continue;
    lines.push("", ...formatStep(step, maxValueLength));
  }
  return `${lines.join("\n")}\n`;
}
