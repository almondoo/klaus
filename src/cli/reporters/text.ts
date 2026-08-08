import type {
  RunResult,
  StepCompleteContext,
  StepResult,
  StepStartContext,
} from "../../core/index.js";

/** 生の ANSI エスケープシーケンス(依存追加を避けるため自前で持つ) */
const ANSI = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  reset: "\x1b[0m",
} as const;

type AnsiColor = keyof typeof ANSI;

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

/** フロー切り替わり時のヘッダー行(フロー名・ファイル) */
export function formatFlowHeader(flowName: string, file: string): string {
  return `${flowName} (${file})`;
}

/** 1 ステップ分の結果行。FAIL の場合は失敗アサーションの詳細を複数行で付加する */
export function formatStepLine(result: StepResult, useColor: boolean): string {
  const durationMs = Math.round(result.durationMs);

  if (result.status === "passed") {
    const status = result.response?.status ?? "-";
    return colorize(`  PASS ${result.name} (${status}, ${durationMs}ms)`, "green", useColor);
  }

  if (result.status === "failed") {
    const status = result.response?.status ?? "-";
    const lines = [colorize(`  FAIL ${result.name} (${status}, ${durationMs}ms)`, "red", useColor)];
    for (const assertion of result.assertions.filter((a) => !a.ok)) {
      lines.push(`    - ${truncate(assertion.message)}`);
    }
    return lines.join("\n");
  }

  if (result.status === "skipped") {
    const reason = result.error ? `: ${result.error}` : "";
    return colorize(`  SKIP ${result.name}${reason}`, "yellow", useColor);
  }

  // error(runtime エラー)
  const message = truncate(result.error ?? "unknown error");
  return colorize(`  ERROR ${result.name}: ${message}`, "red", useColor);
}

/** 全フロー完了後のサマリー行 */
export function formatSummary(runResult: RunResult): string {
  const flowsCount = runResult.flows.length;
  const steps = runResult.flows.flatMap((flow) => flow.steps);
  const passed = steps.filter((s) => s.status === "passed").length;
  const failed = steps.filter((s) => s.status === "failed").length;
  const errored = steps.filter((s) => s.status === "error").length;
  const skipped = steps.filter((s) => s.status === "skipped").length;

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
  let currentFlow: string | null = null;

  return {
    onStepStart(context: StepStartContext): void {
      if (context.flow !== currentFlow) {
        currentFlow = context.flow;
        write(`\n${formatFlowHeader(context.flow, context.file)}\n`);
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
