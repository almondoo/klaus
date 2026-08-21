import type {
  RunResult,
  StepCompleteContext,
  StepResult,
  StepStartContext,
} from "../../core/index.js";
import { sanitizeForTerminal } from "./sanitize.js";

/** 生の ANSI エスケープシーケンス(依存追加を避けるため自前で持つ) */
const ANSI = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
} as const;

type AnsiColor = keyof typeof ANSI;

/**
 * NO_COLOR / FORCE_COLOR 環境変数を踏まえて色出力の有無を判定する(判定ロジックはここに集約する)。
 * 優先順位:
 * 1. FORCE_COLOR が定義されていれば最優先("0" / "false" は無効化扱い。chalk が使う supports-color の慣習)
 * 2. NO_COLOR が定義され空文字以外 → false(no-color.org の仕様)
 * 3. どちらもなければ isTTY に従う
 */
export function resolveUseColor(isTTY: boolean): boolean {
  const forceColor = process.env.FORCE_COLOR;
  if (forceColor !== undefined) return forceColor !== "0" && forceColor !== "false";

  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;

  return isTTY;
}

/** useColor が真のときだけ ANSI エスケープで色付けする */
function colorize(text: string, color: AnsiColor, useColor: boolean): string {
  if (!useColor) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

/** レスポンスボディ等、長くなりがちな値を 500 文字程度で切り詰める */
export const MAX_DETAIL_LENGTH = 500;

export function truncate(text: string, max: number = MAX_DETAIL_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...(truncated)`;
}

/**
 * --json 明示指定、または非 TTY(パイプ・CI 等)なら JSON 出力モードとみなす。
 * validate/generate/history の各コマンドで共通の TTY 判定規約(run コマンドは record/replay 絡みで
 * 別ロジックのため対象外)。
 */
export function isJsonOutputMode(json?: boolean): boolean {
  return json === true || !process.stdout.isTTY;
}

/**
 * フロー切り替わり時のヘッダー行(フロー名・ファイル)。
 * --data 実行時のみ、iteration(1始まり)を末尾に ` (iteration N)` として付加する
 * (通常実行ではこれまでどおりフロー名・ファイルのみ)。
 */
export function formatFlowHeader(flowName: string, file: string, iteration?: number): string {
  // flowName/file は flow YAML の name / ファイルパス由来で攻撃者制御になり得るためサニタイズする
  const suffix = iteration !== undefined ? ` (iteration ${iteration})` : "";
  return `${sanitizeForTerminal(flowName)} (${sanitizeForTerminal(file)})${suffix}`;
}

/** 1 ステップ分の結果行。FAIL の場合は失敗アサーションの詳細を複数行で付加する */
export function formatStepLine(result: StepResult, useColor: boolean): string {
  const durationMs = Math.round(result.durationMs);
  // ステップ名は flow YAML の name 由来で攻撃者制御になり得るため、truncate/colorize より前にサニタイズする
  const name = sanitizeForTerminal(result.name);

  if (result.status === "passed") {
    const status = result.response?.status ?? "-";
    return colorize(`  PASS ${name} (${status}, ${durationMs}ms)`, "green", useColor);
  }

  if (result.status === "failed") {
    const status = result.response?.status ?? "-";
    const lines = [colorize(`  FAIL ${name} (${status}, ${durationMs}ms)`, "red", useColor)];
    for (const assertion of result.assertions.filter((a) => !a.ok)) {
      // 制御文字のサニタイズは truncate/colorize より前に行う(colorize が付与する ANSI コードを壊さないため)
      lines.push(`    - ${truncate(sanitizeForTerminal(assertion.message))}`);
    }
    return lines.join("\n");
  }

  if (result.status === "skipped") {
    const reason = result.error ? `: ${sanitizeForTerminal(result.error)}` : "";
    return colorize(`  SKIP ${name}${reason}`, "yellow", useColor);
  }

  // error(runtime エラー)
  const message = truncate(sanitizeForTerminal(result.error ?? "unknown error"));
  return colorize(`  ERROR ${name}: ${message}`, "red", useColor);
}

/** ステップ配列を4状態(passed/failed/error/skipped)で集計した結果 */
export interface StepsSummary {
  passed: number;
  failed: number;
  error: number;
  skipped: number;
}

/** ステップ配列から4状態(passed/failed/error/skipped)の件数を集計する(text/json 両レポーターで共有) */
export function summarizeSteps(steps: StepResult[]): StepsSummary {
  return {
    passed: steps.filter((s) => s.status === "passed").length,
    failed: steps.filter((s) => s.status === "failed").length,
    error: steps.filter((s) => s.status === "error").length,
    skipped: steps.filter((s) => s.status === "skipped").length,
  };
}

/** 全フロー完了後のサマリー行 */
export function formatSummary(runResult: RunResult): string {
  const flowsCount = runResult.flows.length;
  const steps = runResult.flows.flatMap((flow) => flow.steps);
  const { passed, failed, error: errored, skipped } = summarizeSteps(steps);

  const parts = [`${passed} passed`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (errored > 0) parts.push(`${errored} error`);
  if (skipped > 0) parts.push(`${skipped} skipped`);

  const durationMs = Math.round(runResult.durationMs);
  const flowWord = flowsCount === 1 ? "flow" : "flows";
  const stepWord = steps.length === 1 ? "step" : "steps";
  return `${flowsCount} ${flowWord}, ${steps.length} ${stepWord}: ${parts.join(", ")} (${durationMs}ms)`;
}

export interface TextReporter {
  onStepStart(context: StepStartContext): void;
  onStepComplete(context: StepCompleteContext): void;
  printSummary(runResult: RunResult): void;
}

/**
 * runFlows の onStepStart/onStepComplete フックに直結させるステートフルなレポーター。
 * フローが切り替わったタイミングでヘッダー行を1回だけ出す責務のみここで持ち、
 * 実際の整形は上記の純粋関数(formatFlowHeader/formatStepLine/formatSummary)に閉じ込めてテスト可能にしている。
 */
export function createTextReporter(
  useColor: boolean,
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): TextReporter {
  // --data 実行時は同じフロー名がイテレーションごとに複数回現れるため、
  // フロー名だけでなく iteration も含めて「切り替わったか」を判定する
  // (iteration が無い通常実行では従来どおりフロー名だけで判定される)。
  let currentFlow: { name: string; iteration: number | undefined } | null = null;

  return {
    onStepStart(context: StepStartContext): void {
      if (
        currentFlow === null ||
        context.flow !== currentFlow.name ||
        context.iteration !== currentFlow.iteration
      ) {
        currentFlow = { name: context.flow, iteration: context.iteration };
        write(`\n${formatFlowHeader(context.flow, context.file, context.iteration)}\n`);
      }
    },
    onStepComplete(context: StepCompleteContext): void {
      write(`${formatStepLine(context.result, useColor)}\n`);
    },
    printSummary(runResult: RunResult): void {
      write(`\n${formatSummary(runResult)}\n`);
    },
  };
}
