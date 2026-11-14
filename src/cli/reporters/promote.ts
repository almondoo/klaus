import type { PromoteResult } from "../../core/index.js";
import { sanitizeForTerminal } from "./sanitize.js";

/** klaus promote --json の出力ペイロード(v1)。後方互換が壊れる変更をする場合は version を上げる */
export interface PromoteReport {
  version: 1;
  status: "ok";
  /** ファイルに書き込んだか(--stdout の場合は false) */
  written: boolean;
  /** 書き込んだファイルの cwd 相対パス(POSIX 区切り)。--stdout の場合は省略 */
  file?: string;
  flow: string;
  assert: PromoteResult["assert"];
  steps: PromoteResult["steps"];
  /** 実行前に OS 環境変数として設定するプレースホルダー({{env.NAME}}) */
  placeholders: PromoteResult["placeholders"];
  /** --base-url-var で置き換えた origin。環境ファイルに書くべき値 */
  variables: PromoteResult["baseUrls"];
  /** 推論したチェイン(検証用に一覧する) */
  captures: PromoteResult["captures"];
  skipped: PromoteResult["skipped"];
  /** 秘密情報らしい値のためリテラルではなくプレースホルダー({{env.TODO_*}})に置き換えた箇所 */
  redacted: PromoteResult["redacted"];
  /** --allow-template-literals で出力した、リテラルの "{{" を含む箇所(実行時にテンプレートとして展開される) */
  templateLiterals: PromoteResult["templateLiterals"];
  notes: string[];
  /** 記録した通信から生成したため、コミット前に機微情報を確認すべきという注意 */
  notice: string;
}

export function buildPromoteReport(result: PromoteResult, file: string | undefined): PromoteReport {
  return {
    version: 1,
    status: "ok",
    written: file !== undefined,
    ...(file !== undefined ? { file } : {}),
    flow: result.flowName,
    assert: result.assert,
    steps: result.steps,
    placeholders: result.placeholders,
    variables: result.baseUrls,
    captures: result.captures,
    skipped: result.skipped,
    redacted: result.redacted,
    templateLiterals: result.templateLiterals,
    notes: result.notes,
    notice: result.notice,
  };
}

export function formatPromoteJson(report: PromoteReport): string {
  return JSON.stringify(report);
}

/** promote の text 出力。履歴由来の文字列(URL・ステップ名・エラー等)はすべて端末向けにサニタイズする */
export function formatPromoteText(report: PromoteReport): string {
  const s = sanitizeForTerminal;
  const lines = [
    report.written
      ? `wrote ${s(report.file ?? "")} (${report.steps.length} step(s), assert: ${report.assert})`
      : `generated flow "${s(report.flow)}" (${report.steps.length} step(s), assert: ${report.assert}; nothing written)`,
  ];
  lines.push("", "steps:");
  for (const step of report.steps) {
    lines.push(`  ${s(step.name)}  ${s(step.method)} ${s(step.url)}`);
  }
  if (report.placeholders.length > 0) {
    lines.push(
      "",
      "placeholders to fill (set as OS environment variables; values were masked in history):",
    );
    for (const placeholder of report.placeholders) {
      lines.push(`  ${s(placeholder.name)}  ${s(placeholder.locations.join("; "))}`);
    }
  }
  if (report.variables.length > 0) {
    lines.push("", "variables to define in the environment file:");
    for (const variable of report.variables)
      lines.push(`  ${s(variable.name)}: ${s(variable.value)}`);
  }
  if (report.captures.length > 0) {
    lines.push("", "inferred captures (verify each link):");
    for (const capture of report.captures) {
      const uses = capture.used.map((use) => `step "${use.step}" ${use.location}`).join(", ");
      lines.push(
        `  ${s(capture.name)}: step "${s(capture.from.step)}" ${s(capture.from.path)} -> ${s(uses)}`,
      );
    }
  }
  if (report.redacted.length > 0) {
    lines.push("", "replaced with placeholders because they look sensitive (fill them in):");
    for (const item of report.redacted) {
      lines.push(`  ${s(item.name)}  ${s(item.location)} (${item.reason})`);
    }
  }
  if (report.templateLiterals.length > 0) {
    lines.push(
      "",
      "WARNING: literal template expressions were emitted (--allow-template-literals):",
    );
    for (const item of report.templateLiterals) {
      lines.push(`  step "${s(item.step)}" ${s(item.location)}`);
    }
  }
  if (report.skipped.length > 0) {
    lines.push("", "skipped:");
    for (const item of report.skipped) {
      lines.push(`  ${s(item.flow)} / ${s(item.step)} (run ${s(item.runId)}): ${s(item.reason)}`);
    }
  }
  if (report.notes.length > 0) {
    lines.push("", "notes:");
    for (const note of report.notes) lines.push(`  ${s(note)}`);
  }
  lines.push("", `NOTICE: ${s(report.notice)}`);
  if (report.written && report.file) {
    lines.push("", `run it with: klaus run ${s(report.file)}`);
  }
  return `${lines.join("\n")}\n`;
}
