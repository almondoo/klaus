import type { FlowResult, RunResult, StepResult } from "../../core/index.js";
import {
  flowTitle,
  type MaskedReportOptions,
  maskRunResult,
  maskText,
  type RunMeta,
  stepFailureMessages,
  stringifyDetail,
} from "./report-shared.js";
import { sanitizeForXml } from "./sanitize.js";
import { formatOpenApiSummary, formatSnapshotSummary, summarizeSteps, truncate } from "./text.js";

/** formatHtml のオプション */
export interface FormatHtmlOptions extends MaskedReportOptions {
  /** ヘッダーに表示する実行メタ情報(env / actor / git commit)。省略した項目は表示しない */
  meta?: RunMeta;
}

/**
 * HTML 用エスケープ。動的な文字列はすべてこの関数を通す(唯一の絞り込み点)。
 * 制御文字を可視化してから & < > " ' を実体参照にする。< を潰すので </style> や <script> も無効化される。
 */
export function escapeHtml(value: unknown): string {
  return sanitizeForXml(String(value))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1f2328; --muted:#59636e; --border:#d1d9e0; --panel:#f6f8fa; --pass:#1a7f37; --fail:#cf222e; --err:#9a6700; --skip:#59636e; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --border:#3d444d; --panel:#151b23; --pass:#3fb950; --fail:#ff7b72; --err:#d29922; --skip:#9198a1; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 960px; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
h1 { font-size: 22px; margin: 0 0 8px; }
h2 { font-size: 17px; margin: 0; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
pre { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 8px; margin: 4px 0 8px; white-space: pre-wrap; word-break: break-all; }
.meta { color: var(--muted); margin: 0 0 16px; }
.meta span + span::before { content: " | "; }
.counts { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 24px; padding: 0; list-style: none; }
.counts li { border: 1px solid var(--border); background: var(--panel); border-radius: 6px; padding: 6px 12px; }
.counts b { font-size: 18px; margin-right: 4px; }
.warnings { border: 1px solid var(--err); border-radius: 6px; padding: 8px 12px; margin: 0 0 16px; }
.warnings h2 { font-size: 14px; color: var(--err); }
.warnings ul { margin: 4px 0 0; padding-left: 20px; }
.flow { border: 1px solid var(--border); border-radius: 6px; margin: 0 0 16px; }
.flow > header { padding: 8px 12px; background: var(--panel); border-bottom: 1px solid var(--border); border-radius: 6px 6px 0 0; }
.flow > header p { margin: 0; color: var(--muted); }
.step { border-bottom: 1px solid var(--border); }
.step:last-child { border-bottom: 0; }
.step > summary, .step > .row { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; padding: 6px 12px; }
.step > summary { cursor: pointer; }
.step .name { font-weight: 600; }
.step .req { flex: 1 1 200px; color: var(--muted); word-break: break-all; }
.detail { padding: 0 12px 8px; }
.detail h3 { font-size: 13px; margin: 8px 0 0; }
.badge { font-weight: 600; text-transform: uppercase; font-size: 12px; min-width: 56px; }
.passed { color: var(--pass); } .failed { color: var(--fail); } .error { color: var(--err); } .skipped { color: var(--skip); }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; vertical-align: top; }
@media print { body { max-width: none; } .step > summary { cursor: auto; } }
`;

function badge(status: string): string {
  return `<span class="badge ${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function requestLine(step: StepResult): string {
  if (!step.request) return "";
  return `${step.request.method} ${step.request.url}`;
}

function responseLine(step: StepResult): string {
  return step.response ? `HTTP ${step.response.status}` : "";
}

function headerRow(step: StepResult): string {
  const parts = [
    badge(step.status),
    `<span class="name">${escapeHtml(step.name)}</span>`,
    `<code class="req">${escapeHtml(requestLine(step))}</code>`,
    `<span>${escapeHtml(responseLine(step))}</span>`,
    `<span>${Math.round(step.durationMs)} ms</span>`,
  ];
  return parts.join("");
}

/** リダイレクトの経路と、別オリジンへの遷移で落としたヘッダー名(無ければ空文字列) */
function redirectBlocks(step: StepResult): string {
  const blocks: string[] = [];
  if (step.redirects !== undefined && step.redirects.length > 0) {
    blocks.push(
      `<h3>Redirects</h3><pre>${escapeHtml(truncate(step.redirects.join("\n-> ")))}</pre>`,
    );
  }
  if (step.droppedHeaders !== undefined && step.droppedHeaders.length > 0) {
    const dropped = step.droppedHeaders
      .map((entry) => `hop ${entry.hop}: ${entry.headers.join(", ")}`)
      .join("\n");
    blocks.push(`<h3>Headers dropped on redirect</h3><pre>${escapeHtml(truncate(dropped))}</pre>`);
  }
  return blocks.join("");
}

/** OpenAPI のカバレッジ(--openapi を指定した実行にだけ出す)。集計行と、未カバー・照合できなかったもの・対象外の一覧 */
function openApiHtml(result: RunResult): string {
  const openapi = result.openapi;
  if (!openapi) return "";
  const lines = formatOpenApiSummary(openapi)
    .map((line) => `<p class="meta">${escapeHtml(line)}</p>`)
    .join("");
  const list = (title: string, items: string[]): string =>
    items.length === 0
      ? ""
      : `<details><summary>${escapeHtml(title)} (${items.length})</summary><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`;
  const coveredRows = openapi.covered
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.operation)}</td><td>${escapeHtml(c.statuses.join(", "))}</td><td>${escapeHtml(c.documented.join(", "))}</td></tr>`,
    )
    .join("");
  const coveredTable =
    openapi.covered.length === 0
      ? ""
      : `<details><summary>Covered operations (${openapi.covered.length})</summary><table><thead><tr><th>Operation</th><th>Observed statuses</th><th>Documented</th></tr></thead><tbody>${coveredRows}</tbody></table></details>`;
  return `<div class="openapi"><h2>OpenAPI</h2>${lines}${list(
    "Uncovered operations",
    openapi.uncovered.map((u) => u.operation),
  )}${coveredTable}${list(
    "Unmatched requests",
    openapi.unmatched.map((u) => `${u.method} ${u.url} (x${u.count})`),
  )}${list(
    "Not validated",
    openapi.excluded.map((e) => `${e.flow} / ${e.step} (${e.reason})`),
  )}</div>\n`;
}

/** failed/error ステップの詳細(失敗アサーション + 切り詰め済みの request/response) */
function stepDetail(step: StepResult): string {
  const blocks: string[] = [];
  if (step.status === "error") {
    blocks.push(`<h3>Error</h3><pre>${escapeHtml(step.error ?? "runtime error")}</pre>`);
  }
  const failed = step.assertions.filter((a) => !a.ok);
  if (failed.length > 0) {
    const rows = failed
      .map(
        (a) =>
          `<tr><td>${escapeHtml(a.kind)}</td><td>${escapeHtml(a.message)}</td><td><code>${escapeHtml(stringifyDetail(a.expected))}</code></td><td><code>${escapeHtml(stringifyDetail(a.actual))}</code></td></tr>`,
      )
      .join("");
    blocks.push(
      `<h3>Failed assertions</h3><table><thead><tr><th>Kind</th><th>Message</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${rows}</tbody></table>`,
    );
    // スナップショットの不一致は、基準との構造差分を表にする(全件は JSON 出力にある)
    for (const a of failed) {
      const differences = a.snapshot?.differences ?? [];
      if (differences.length === 0) continue;
      const diffRows = differences
        .map(
          (d) =>
            `<tr><td><code>${escapeHtml(d.path)}</code></td><td>${escapeHtml(d.kind)}</td><td><code>${escapeHtml(stringifyDetail(d.before))}</code></td><td><code>${escapeHtml(stringifyDetail(d.after))}</code></td></tr>`,
        )
        .join("");
      const total = a.snapshot?.differenceCount ?? differences.length;
      const more =
        total > differences.length ? ` (${total - differences.length} more not shown)` : "";
      blocks.push(
        `<h3>Snapshot differences${escapeHtml(more)}</h3><table><thead><tr><th>Path</th><th>Kind</th><th>Baseline</th><th>This response</th></tr></thead><tbody>${diffRows}</tbody></table>`,
      );
    }
    // OpenAPI の違反は、場所・パス・内容を表にする(全件は JSON 出力にある)
    for (const a of failed) {
      const violations = a.openapi?.violations ?? [];
      if (violations.length === 0) continue;
      const violationRows = violations
        .map(
          (v) =>
            `<tr><td>${escapeHtml(v.location)}</td><td><code>${escapeHtml(v.path ?? "")}</code></td><td>${escapeHtml(v.message)}</td></tr>`,
        )
        .join("");
      const total = a.openapi?.violationCount ?? violations.length;
      const more =
        total > violations.length ? ` (${total - violations.length} more not shown)` : "";
      blocks.push(
        `<h3>OpenAPI violations${escapeHtml(more)}</h3><table><thead><tr><th>Location</th><th>Path</th><th>Message</th></tr></thead><tbody>${violationRows}</tbody></table>`,
      );
    }
  } else if (step.status === "failed") {
    blocks.push(`<h3>Failure</h3><pre>${escapeHtml(stepFailureMessages(step).join("\n"))}</pre>`);
  }
  blocks.push(redirectBlocks(step));
  if (step.request) {
    const body = stringifyDetail(step.request.body);
    blocks.push(
      `<h3>Request</h3><pre>${escapeHtml(requestLine(step))}${body ? `\n\n${escapeHtml(body)}` : ""}</pre>`,
    );
  }
  if (step.response) {
    const body = stringifyDetail(step.response.body);
    blocks.push(
      `<h3>Response</h3><pre>${escapeHtml(responseLine(step))}${body ? `\n\n${escapeHtml(body)}` : ""}</pre>`,
    );
  }
  return `<div class="detail">${blocks.join("")}</div>`;
}

function stepHtml(step: StepResult): string {
  if (step.status === "failed" || step.status === "error") {
    // 失敗ステップは既定で開いておく(<details> なので JavaScript なしで開閉できる)
    return `<details class="step" open><summary>${headerRow(step)}</summary>${stepDetail(step)}</details>`;
  }
  const reason =
    step.status === "skipped" && step.error ? ` <code>${escapeHtml(step.error)}</code>` : "";
  // 成功したステップでも、リダイレクトを辿った場合は経路を折りたたんで見られるようにする
  const redirects = redirectBlocks(step);
  if (redirects !== "") {
    return `<details class="step"><summary>${headerRow(step)}${reason}</summary><div class="detail">${redirects}</div></details>`;
  }
  return `<div class="step"><div class="row">${headerRow(step)}${reason}</div></div>`;
}

function flowHtml(flow: FlowResult): string {
  const counts = summarizeSteps(flow.steps);
  const stats = `${flow.steps.length} steps: ${counts.passed} passed, ${counts.failed} failed, ${counts.error} error, ${counts.skipped} skipped | ${Math.round(flow.durationMs)} ms`;
  return `<section class="flow"><header><h2>${badge(flow.status)} ${escapeHtml(flowTitle(flow))}</h2><p><code>${escapeHtml(flow.file)}</code> | ${escapeHtml(stats)}</p></header>${flow.steps.map(stepHtml).join("")}</section>`;
}

/** RunResult 全体を自己完結した単一 HTML 文書(インライン CSS のみ、JavaScript なし)に変換する */
export function formatHtml(runResult: RunResult, options?: FormatHtmlOptions): string {
  const result = maskRunResult(runResult, options?.secrets);
  const steps = result.flows.flatMap((flow) => flow.steps);
  const counts = summarizeSteps(steps);
  // メタ情報(env / actor / commit)も結果本体と同じ secrets でマスクする
  const meta = options?.meta
    ? {
        env: options.meta.env && maskText(options.meta.env, options.secrets),
        actor: options.meta.actor && maskText(options.meta.actor, options.secrets),
        commit: options.meta.commit && maskText(options.meta.commit, options.secrets),
      }
    : undefined;
  const metaItems = [
    `Started: ${result.startedAt}`,
    `Duration: ${Math.round(result.durationMs)} ms`,
    `Run: ${result.runId}`,
    ...(meta?.env ? [`Env: ${meta.env}`] : []),
    ...(meta?.actor ? [`Actor: ${meta.actor}`] : []),
    ...(meta?.commit ? [`Commit: ${meta.commit}`] : []),
  ]
    .map((item) => `<span>${escapeHtml(item)}</span>`)
    .join("");
  const countItems = [
    ["Flows", result.flows.length, ""],
    ["Steps", steps.length, ""],
    ["Passed", counts.passed, "passed"],
    ["Failed", counts.failed, "failed"],
    ["Error", counts.error, "error"],
    ["Skipped", counts.skipped, "skipped"],
  ]
    .map(([label, value, cls]) => `<li><b class="${cls}">${value}</b>${label}</li>`)
    .join("");
  const snapshotsHtml = formatSnapshotSummary(result)
    .map((line) => `<p class="meta">${escapeHtml(line)}</p>`)
    .join("");
  const warningsHtml =
    result.warnings !== undefined && result.warnings.length > 0
      ? `<div class="warnings"><h2>Warnings</h2><ul>${result.warnings.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul></div>\n`
      : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>klaus report: ${escapeHtml(result.status)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>klaus report ${badge(result.status)}</h1>
<p class="meta">${metaItems}</p>
<ul class="counts">${countItems}</ul>
${snapshotsHtml}${warningsHtml}${openApiHtml(result)}${result.flows.map(flowHtml).join("\n")}
</body>
</html>
`;
}
