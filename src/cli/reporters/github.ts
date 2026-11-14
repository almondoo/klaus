import type { RunResult, StepResult } from "../../core/index.js";
import {
  FAILING_STATUSES,
  flowTitle,
  type MaskedReportOptions,
  maskRunResult,
  stepFailureMessages,
  truncateWithEllipsis,
} from "./report-shared.js";
import { sanitizeForXml } from "./sanitize.js";
import { summarizeSteps } from "./text.js";

/**
 * Markdown サマリー全体のバイト数上限。GitHub のステップサマリーは 1 ステップあたり 1 MiB 上限で、
 * 他のステップが同じファイルに追記している可能性もあるため、余裕を持たせて 512 KiB に抑える。
 */
export const SUMMARY_MAX_BYTES = 512 * 1024;
/** 失敗テーブルの最大行数(超過分は件数のみ注記する) */
const MAX_FAILURE_ROWS = 200;
/** 失敗テーブルの1セルあたりのメッセージ最大文字数 */
const MAX_MESSAGE_LENGTH = 300;
/** 名前・URL など、メッセージ以外のセルの最大文字数(エスケープ前) */
const MAX_CELL_LENGTH = 200;
/** アノテーションの title / file プロパティと message の最大文字数(エスケープ前) */
const MAX_ANNOTATION_PROPERTY_LENGTH = 200;
const MAX_ANNOTATION_MESSAGE_LENGTH = 4000;

/** ワークフローコマンドのデータ部(メッセージ)のエスケープ。% → %25、CR → %0D、LF → %0A */
export function escapeCommandData(value: string): string {
  return sanitizeForXml(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** ワークフローコマンドのプロパティ値のエスケープ。データ部に加えて : → %3A、, → %2C */
export function escapeCommandProperty(value: string): string {
  return escapeCommandData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** failed/error ステップごとに `::error file=...,title=...::message` を1行ずつ返す */
export function formatGithubAnnotations(
  runResult: RunResult,
  options?: MaskedReportOptions,
): string[] {
  const result = maskRunResult(runResult, options?.secrets);
  const lines: string[] = [];
  for (const flow of result.flows) {
    for (const step of flow.steps) {
      if (!FAILING_STATUSES.has(step.status)) continue;
      const title = truncateWithEllipsis(
        `${flowTitle(flow)} / ${step.name}`,
        MAX_ANNOTATION_PROPERTY_LENGTH,
      );
      const file = truncateWithEllipsis(flow.file, MAX_ANNOTATION_PROPERTY_LENGTH);
      // 長すぎるメッセージは切り詰めて注記を付ける(1 行のアノテーションが肥大化しないように)
      const joined = stepFailureMessages(step).join("\n");
      const message =
        joined.length > MAX_ANNOTATION_MESSAGE_LENGTH
          ? `${truncateWithEllipsis(joined, MAX_ANNOTATION_MESSAGE_LENGTH)} (message truncated)`
          : joined;
      lines.push(
        `::error file=${escapeCommandProperty(file)},title=${escapeCommandProperty(title)}::${escapeCommandData(message)}`,
      );
    }
  }
  return lines;
}

/**
 * Markdown 表セル用エスケープ。HTML 化 → Markdown の特殊文字(\ | ` * _ [ ] ~ !)→ 改行は <br>。
 * 自動リンク(URL・www.・メールアドレス)も実体参照で無効化し、敵対的な名前でクリック可能なリンクを作れないようにする。
 */
export function escapeMarkdownCell(value: string): string {
  return sanitizeForXml(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\|`*_[\]~!]/g, "\\$&")
    .replace(/:\/\//g, "&#58;//")
    .replace(/www\./gi, (match) => `${match.slice(0, 3)}&#46;`)
    .replace(/@/g, "&#64;")
    .replace(/\r\n|\r|\n/g, "<br>");
}

/** セル用: 先に文字数を切り詰めてからエスケープする */
function cell(value: string, max: number = MAX_CELL_LENGTH): string {
  return escapeMarkdownCell(truncateWithEllipsis(value, max));
}

function requestSummary(step: StepResult): string {
  if (!step.request) return "";
  return `${step.request.method} ${step.request.url}`;
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf-8");

/** RunResult を GitHub Actions のジョブサマリー向け Markdown に変換する */
export function formatGithubSummary(runResult: RunResult, options?: MaskedReportOptions): string {
  const result = maskRunResult(runResult, options?.secrets);
  const steps = result.flows.flatMap((flow) => flow.steps);
  const counts = summarizeSteps(steps);

  const parts: string[] = [];
  parts.push(`## klaus run: ${result.status.toUpperCase()}\n`);
  parts.push(
    `Started ${escapeMarkdownCell(result.startedAt)} | ${Math.round(result.durationMs)} ms | run \`${escapeMarkdownCell(result.runId)}\`\n`,
  );
  parts.push(
    `| Flows | Steps | Passed | Failed | Error | Skipped |\n| ---: | ---: | ---: | ---: | ---: | ---: |\n| ${result.flows.length} | ${steps.length} | ${counts.passed} | ${counts.failed} | ${counts.error} | ${counts.skipped} |\n`,
  );

  // 失敗テーブル(最重要なので常に出す。件数が多い場合のみ行数を打ち切る)
  const failures = result.flows.flatMap((flow) =>
    flow.steps.filter((step) => FAILING_STATUSES.has(step.status)).map((step) => ({ flow, step })),
  );
  if (failures.length > 0) {
    const rows = failures
      .slice(0, MAX_FAILURE_ROWS)
      .map(({ flow, step }) => {
        const first = stepFailureMessages(step)[0] ?? "";
        return `| ${cell(flowTitle(flow))} | ${cell(step.name)} | ${step.status} | ${cell(first, MAX_MESSAGE_LENGTH)} |`;
      })
      .join("\n");
    parts.push(
      `### Failed steps\n\n| Flow | Step | Status | Message |\n| --- | --- | --- | --- |\n${rows}\n`,
    );
    if (failures.length > MAX_FAILURE_ROWS) {
      parts.push(`_${failures.length - MAX_FAILURE_ROWS} more failed steps are not shown._\n`);
    }
  }

  // 全フローの詳細(折りたたみ)。バイト数の予算内に収まる分だけ出し、超過したら注記して打ち切る
  const header = parts.join("\n");
  let budget = SUMMARY_MAX_BYTES - byteLength(header) - 512;
  const details: string[] = [];
  let omitted = 0;
  for (const flow of result.flows) {
    const rows = flow.steps
      .map(
        (step) =>
          `| ${cell(step.name)} | ${step.status} | ${cell(requestSummary(step))} | ${step.response ? step.response.status : ""} | ${Math.round(step.durationMs)} ms |`,
      )
      .join("\n");
    const flowCounts = summarizeSteps(flow.steps);
    const block = `<details>\n<summary>${cell(flowTitle(flow))} (${flow.status}: ${flowCounts.passed}/${flow.steps.length} passed)</summary>\n\n| Step | Status | Request | HTTP | Duration |\n| --- | --- | --- | ---: | ---: |\n${rows}\n\n</details>\n`;
    const size = byteLength(block) + 1;
    if (size > budget) {
      omitted += 1;
      continue;
    }
    budget -= size;
    details.push(block);
  }

  let body = header;
  if (details.length > 0 || omitted > 0) {
    body += `\n### All flows\n\n${details.join("\n")}`;
    if (omitted > 0) {
      body += `\n_Details of ${omitted} flow(s) were omitted to stay under the GitHub step summary size limit._\n`;
    }
  }
  return enforceByteLimit(body.endsWith("\n") ? body : `${body}\n`);
}

/**
 * 最終的なバイト数の上限保証。超過時は行境界(=表の行・タグの途中ではない)で切り、
 * 開いたままの <details> を閉じて打ち切りの注記を付ける。行単位なので UTF-8 の多バイト文字も分断しない。
 */
function enforceByteLimit(markdown: string): string {
  if (byteLength(markdown) <= SUMMARY_MAX_BYTES) return markdown;
  const note = "\n_Summary truncated to stay under the GitHub step summary size limit._\n";
  const reserve = byteLength(note) + byteLength("\n</details>\n");
  const kept: string[] = [];
  let used = 0;
  for (const line of markdown.split("\n")) {
    const size = byteLength(line) + 1;
    if (used + size > SUMMARY_MAX_BYTES - reserve) break;
    kept.push(line);
    used += size;
  }
  let out = kept.join("\n");
  const opened = (out.match(/<details>/g) ?? []).length;
  const closed = (out.match(/<\/details>/g) ?? []).length;
  if (opened > closed) out += "\n\n</details>";
  return `${out}\n${note}`;
}
