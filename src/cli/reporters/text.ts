import type {
  OpenApiRunSummary,
  RunResult,
  StepCompleteContext,
  StepResult,
  StepStartContext,
} from "../../core/index.js";
import { describeSnapshotDifference } from "../../core/index.js";
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

/**
 * リダイレクトの経路と、別オリジンへの遷移で落としたヘッダー名を、失敗の原因調査用に短い行にする
 * (failed / error ステップの詳細にだけ付ける)。URL は攻撃者制御になり得るためサニタイズする
 */
function formatRedirectLines(result: StepResult): string[] {
  const lines: string[] = [];
  if (result.redirects !== undefined && result.redirects.length > 0) {
    const route = result.redirects.map((url) => sanitizeForTerminal(url)).join(" -> ");
    lines.push(`    redirects: ${truncate(route)}`);
  }
  if (result.droppedHeaders !== undefined && result.droppedHeaders.length > 0) {
    const dropped = result.droppedHeaders
      .map((entry) => `hop ${entry.hop}: ${entry.headers.map(sanitizeForTerminal).join(", ")}`)
      .join("; ");
    lines.push(`    dropped headers on redirect: ${truncate(dropped)}`);
  }
  return lines;
}

/** text 出力で 1 つの不一致につき表示する差分の最大件数 */
const MAX_TEXT_DIFFERENCES = 10;

/** 1 ステップ分の結果行。FAIL の場合は失敗アサーションの詳細を複数行で付加する */
export function formatStepLine(result: StepResult, useColor: boolean): string {
  const durationMs = Math.round(result.durationMs);
  // ステップ名は flow YAML の name 由来で攻撃者制御になり得るため、truncate/colorize より前にサニタイズする
  const name = sanitizeForTerminal(result.name);

  if (result.status === "passed") {
    const status = result.response?.status ?? "-";
    // 基準を書き込んだ・書き換えたステップは、見落とさないよう行に明記する
    const written = result.assertions.find(
      (a) => a.snapshot?.state === "written" || a.snapshot?.state === "updated",
    );
    const note = written?.snapshot ? ` [snapshot ${written.snapshot.state}]` : "";
    return colorize(`  PASS ${name} (${status}, ${durationMs}ms)${note}`, "green", useColor);
  }

  if (result.status === "failed") {
    const status = result.response?.status ?? "-";
    const lines = [colorize(`  FAIL ${name} (${status}, ${durationMs}ms)`, "red", useColor)];
    for (const assertion of result.assertions.filter((a) => !a.ok)) {
      // 制御文字のサニタイズは truncate/colorize より前に行う(colorize が付与する ANSI コードを壊さないため)
      // スナップショットの不一致は、メッセージ中の差分(先頭の数件)を省き、差分を 1 件ずつ別の行にする
      // (先頭の一部。全件は JSON 出力にある)
      const differences = assertion.snapshot?.differences ?? [];
      const message =
        differences.length > 0
          ? (/^(.*? differs from the baseline \(\d+ differences?\)): /s.exec(
              assertion.message,
            )?.[1] ?? assertion.message)
          : assertion.message;
      lines.push(`    - ${truncate(sanitizeForTerminal(message))}`);
      const shown = Math.min(differences.length, MAX_TEXT_DIFFERENCES);
      for (const difference of differences.slice(0, shown)) {
        lines.push(
          `        ${truncate(sanitizeForTerminal(describeSnapshotDifference(difference)))}`,
        );
      }
      const total = assertion.snapshot?.differenceCount ?? differences.length;
      if (total > shown) lines.push(`        ... ${total - shown} more`);
    }
    lines.push(...formatRedirectLines(result));
    return lines.join("\n");
  }

  if (result.status === "skipped") {
    const reason = result.error ? `: ${sanitizeForTerminal(result.error)}` : "";
    return colorize(`  SKIP ${name}${reason}`, "yellow", useColor);
  }

  // error(runtime エラー)
  const message = truncate(sanitizeForTerminal(result.error ?? "unknown error"));
  const errorLines = [colorize(`  ERROR ${name}: ${message}`, "red", useColor)];
  errorLines.push(...formatRedirectLines(result));
  return errorLines.join("\n");
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

/**
 * スナップショットの集計行(snapshot アサーションが無い実行では空)。書き込んだファイルは、コミット対象として
 * 見落とさないよう列挙する。ファイル名はユーザー入力由来のためサニタイズする。
 */
export function formatSnapshotSummary(runResult: RunResult): string[] {
  const snapshots = runResult.snapshots;
  if (!snapshots) return [];
  const parts = [`${snapshots.matched} matched`];
  if (snapshots.written > 0) parts.push(`${snapshots.written} written`);
  if (snapshots.updated > 0) parts.push(`${snapshots.updated} updated`);
  if (snapshots.mismatched > 0) parts.push(`${snapshots.mismatched} mismatched`);
  if (snapshots.missing > 0) parts.push(`${snapshots.missing} missing`);
  if (snapshots.obsolete > 0) parts.push(`${snapshots.obsolete} obsolete`);
  return [
    `snapshots: ${parts.join(", ")}`,
    ...snapshots.files.map((file) => `snapshot file written: ${sanitizeForTerminal(file)}`),
  ];
}

/** text / GitHub サマリーに載せる、一覧の先頭の件数 */
const OPENAPI_LIST_LIMIT = 10;

function limitedList(items: string[]): string {
  const shown = items.slice(0, OPENAPI_LIST_LIMIT).join(", ");
  const rest = items.length - OPENAPI_LIST_LIMIT;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
}

/**
 * OpenAPI の集計行(--openapi を指定しない実行では空)。カバレッジ・違反数・未カバーのオペレーション・
 * 照合できなかったリクエスト・検証の対象外にしたステップを、先頭の数件ずつ載せる(全件は JSON 出力にある)。
 * 値(オペレーション・URL・ステップ名)は仕様やフロー由来のためサニタイズする。
 */
export function formatOpenApiSummary(openapi: OpenApiRunSummary | undefined): string[] {
  if (!openapi) return [];
  const { total, covered, percent } = openapi.operations;
  const labels: string[] = [];
  if (openapi.planned) labels.push("planned, nothing was sent");
  if (openapi.partial) labels.push("partial run: only the selected flows");
  const violations = openapi.violations > 0 ? `, ${openapi.violations} violation(s)` : "";
  const label = labels.length > 0 ? ` [${labels.join("; ")}]` : "";
  const lines = [
    `openapi: ${covered}/${total} operations covered (${percent}%)${violations}${label}`,
  ];
  if (openapi.coverageMin !== undefined && !openapi.coverageMin.met) {
    lines.push(
      `openapi: coverage ${percent}% is below --openapi-coverage-min ${openapi.coverageMin.percent}%`,
    );
  }
  if (openapi.uncovered.length > 0) {
    lines.push(
      `openapi: uncovered: ${sanitizeForTerminal(limitedList(openapi.uncovered.map((u) => u.operation)))}`,
    );
  }
  if (openapi.unmatched.length > 0) {
    lines.push(
      `openapi: unmatched requests: ${sanitizeForTerminal(
        limitedList(openapi.unmatched.map((u) => `${u.method} ${u.url}`)),
      )}`,
    );
  }
  if (openapi.excluded.length > 0) {
    lines.push(
      `openapi: not validated: ${sanitizeForTerminal(
        limitedList(openapi.excluded.map((e) => `${e.flow} / ${e.step} (${e.reason})`)),
      )}`,
    );
  }
  return lines;
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
      // 警告(tls.insecure など)はサマリーの直前に出す。stderr にも同じ警告が出ているが、stdout だけを保存した場合にも残すため
      const warnings = (runResult.warnings ?? []).map(
        (message) =>
          `${colorize("warning:", "yellow", useColor)} ${truncate(sanitizeForTerminal(message))}\n`,
      );
      const snapshotLines = [
        ...formatSnapshotSummary(runResult),
        ...formatOpenApiSummary(runResult.openapi),
      ].map((line) => `${line}\n`);
      write(
        `\n${warnings.join("")}${warnings.length > 0 ? "\n" : ""}${snapshotLines.join("")}${formatSummary(runResult)}\n`,
      );
    },
  };
}
