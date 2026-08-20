import type { AssertionResult, FlowResult, RunResult, StepResult } from "../../core/index.js";
import { expandSecretVariants, maskString } from "../../core/index.js";
import { sanitizeForTerminal } from "./sanitize.js";

/** formatTap のオプション。secrets を渡すと TAP ファイル出力にのみシークレットマスクを適用する(formatJUnit の FormatJUnitOptions と同じ方針) */
export interface FormatTapOptions {
  /** {{env.X}} 等で解決した secrets の生値一覧。省略時はマスクしない(従来どおりの出力) */
  secrets?: readonly string[];
}

/**
 * TAP (Test Anything Protocol version 13) 用のテキストサニタイズ。
 * TAP は「1 行 1 テスト」のプレーンテキストプロトコルのため、
 * 名前や診断メッセージに改行が含まれると行構造が壊れ、'#' が含まれると
 * コメント/ディレクティブ(`# SKIP ...` 等)の構文と衝突しうる。
 * 変換順序は formatJUnit の escapeXmlText と同じ: ①シークレットマスク(生のバイト列のまま照合する
 * 必要があるため最初)②制御文字のサニタイズ(sanitizeForTerminal)③'#' のエスケープ(TAP の構文要素との衝突回避)。
 */
function sanitizeForTap(text: string, secretVariants: readonly string[]): string {
  const masked = secretVariants.length > 0 ? maskString(text, secretVariants) : text;
  return sanitizeForTerminal(masked).replace(/#/g, "\\#");
}

/**
 * 1 ステップ分のテスト名(`<flowName> > <stepName>`)を組み立てる。
 * flow/step それぞれ独立にサニタイズしてから連結する(区切り文字 " > " 自体は攻撃者制御にならないため素通し)。
 */
function testDescription(
  flow: FlowResult,
  step: StepResult,
  secretVariants: readonly string[],
): string {
  return `${sanitizeForTap(flow.name, secretVariants)} > ${sanitizeForTap(step.name, secretVariants)}`;
}

/** failed ステップの診断行(失敗したアサーションごとに1行の `# ...` コメント)を組み立てる */
function assertionDiagnostics(
  assertions: AssertionResult[],
  secretVariants: readonly string[],
): string[] {
  return assertions
    .filter((assertion) => !assertion.ok)
    .map((assertion) => `# ${sanitizeForTap(assertion.message, secretVariants)}`);
}

/**
 * 1 ステップ分の TAP テスト行(+ 失敗時の診断コメント行)を組み立てる。
 * TAP は skip を「ok + SKIP ディレクティブ」で表現する規約のため、klaus の skipped ステータスは
 * passed/failed とは異なる特別扱いになる(not ok にはしない)。
 */
function testLines(
  testNumber: number,
  flow: FlowResult,
  step: StepResult,
  secretVariants: readonly string[],
): string[] {
  const description = testDescription(flow, step, secretVariants);

  if (step.status === "passed") {
    return [`ok ${testNumber} - ${description}`];
  }

  if (step.status === "skipped") {
    const reason = step.error ?? "skipped";
    return [`ok ${testNumber} - ${description} # SKIP ${sanitizeForTap(reason, secretVariants)}`];
  }

  // failed / error
  const lines = [`not ok ${testNumber} - ${description}`];
  if (step.status === "error") {
    lines.push(`# ${sanitizeForTap(step.error ?? "runtime error", secretVariants)}`);
  } else {
    lines.push(...assertionDiagnostics(step.assertions, secretVariants));
  }
  return lines;
}

/**
 * RunResult 全体を TAP version 13 形式に変換する。
 * 全フローを通してステップの実行順に連番を振り、`1..N` のプラン行(N = 総ステップ数)を先頭に出力する。
 *
 * シークレットマスクについて: formatJUnit と同じ方針で、options.secrets を渡すとこの関数自身が
 * expandSecretVariants で URL エンコード等のバリアントも含めて展開し、内部でマスクする
 * (呼び出し側がマスク済みの RunResult を用意する必要はない)。
 */
export function formatTap(runResult: RunResult, options?: FormatTapOptions): string {
  const secretVariants =
    options?.secrets && options.secrets.length > 0 ? expandSecretVariants(options.secrets) : [];
  const entries = runResult.flows.flatMap((flow) => flow.steps.map((step) => ({ flow, step })));

  const lines = ["TAP version 13", `1..${entries.length}`];
  entries.forEach(({ flow, step }, index) => {
    lines.push(...testLines(index + 1, flow, step, secretVariants));
  });

  return `${lines.join("\n")}\n`;
}
