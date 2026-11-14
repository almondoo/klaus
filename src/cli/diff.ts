import { type Command, InvalidArgumentError } from "commander";
import {
  DEFAULT_IGNORED_HEADERS,
  diffRuns,
  type JsonPathPattern,
  MAX_DESCENDANT_OPERATORS,
  parseJsonPathPattern,
  readAllHistoryEntries,
  resolveRunRef,
  selectRunEntries,
} from "../core/index.js";
import { runCommandAction } from "./command-action.js";
import {
  buildDiffReport,
  DEFAULT_TEXT_MAX_VALUE_LENGTH,
  formatDiffJson,
  formatDiffText,
  truncateReportValues,
} from "./reporters/diff.js";

/** diff コマンドのオプション(commander から渡される値を正規化した形) */
export interface DiffCommandOptions {
  flow?: string;
  /** --ignore-header の累積結果 */
  ignoreHeader?: string[];
  /** commander の --no-default-ignores により、指定が無ければ true(既定の除外ヘッダーを使う) */
  defaultIgnores?: boolean;
  /** --ignore-path の累積結果 */
  ignorePath?: string[];
  durationThreshold?: number;
  maxDifferences?: number;
  maxValueLength?: number;
  json?: boolean;
  text?: boolean;
}

const DEFAULT_MAX_DIFFERENCES = 50;

/** 引数の誤り・不明な run は exit 1(klaus history show と同じ。定義・内容の検証エラーを表す 2 は使わない) */
function fail(message: string): number {
  process.stderr.write(`klaus: ${message}\n`);
  return 1;
}

/**
 * diff コマンド本体。履歴(.klaus/history)から2つの run を引いて比較する。
 * - 引数は runId 2つ(完全一致)、または "latest" / "previous"(--flow 必須)。引数なしで --flow のみなら previous と latest を比較する
 * - exit code: 差分なし 0 / 差分あり 4(run の assertion 失敗と同じ「失敗」の意味合いで揃える)/
 *   引数不正・不明な run(--flow に該当する run が無い場合を含む)1(klaus history show と同じ)。予期しない例外も 1
 * - 出力: --json または非 TTY なら JSON、TTY なら text(--text で強制)。結果は stdout、エラーは stderr
 */
export async function diffCommand(
  refs: string[],
  options: DiffCommandOptions,
  cwd: string = process.cwd(),
): Promise<number> {
  if (options.json === true && options.text === true) {
    return fail("--json and --text cannot be used together");
  }
  if (refs.length !== 0 && refs.length !== 2) {
    return fail("expected two runs (<runA> <runB>) or none (with --flow <name>)");
  }
  if (refs.length === 0 && options.flow === undefined) {
    return fail(
      "expected <runA> <runB>, or --flow <name> to compare the previous run with the latest",
    );
  }
  const [refA, refB] = refs.length === 2 ? (refs as [string, string]) : ["previous", "latest"];

  const ignorePaths: JsonPathPattern[] = [];
  for (const source of options.ignorePath ?? []) {
    const pattern = parseJsonPathPattern(source);
    if (!pattern)
      return fail(
        `invalid --ignore-path "${source}" (expected a JSONPath such as $.data.id, $.items[*].createdAt, or $..updatedAt, with at most ${MAX_DESCENDANT_OPERATORS} ".." operators)`,
      );
    ignorePaths.push(pattern);
  }

  const useJson =
    options.json === true ? true : options.text === true ? false : !process.stdout.isTTY;

  const entries = await readAllHistoryEntries(cwd);
  const resolvedA = resolveRunRef(entries, refA, options.flow);
  if (!resolvedA.ok) return fail(resolvedA.message);
  const resolvedB = resolveRunRef(entries, refB, options.flow);
  if (!resolvedB.ok) return fail(resolvedB.message);

  // --flow 指定時は両 run とも、そのフローのステップだけを比較する(別フローの混在を除く)。
  // 同一ミリ秒のステップの順序を履歴の行順で確定させるため、追記順で取り出す
  const entriesA = selectRunEntries(entries, resolvedA.runId, options.flow);
  const entriesB = selectRunEntries(entries, resolvedB.runId, options.flow);
  if (entriesA.length === 0 || entriesB.length === 0) {
    const missing = entriesA.length === 0 ? resolvedA.runId : resolvedB.runId;
    return fail(`run "${missing}" has no entries for flow "${options.flow}"`);
  }

  const ignoreHeaders = [
    ...(options.defaultIgnores === false ? [] : DEFAULT_IGNORED_HEADERS),
    ...(options.ignoreHeader ?? []),
  ];
  const diff = diffRuns(
    { runId: resolvedA.runId, entries: entriesA },
    { runId: resolvedB.runId, entries: entriesB },
    {
      ignoreHeaders,
      ignorePaths,
      durationThresholdMs: options.durationThreshold,
      maxDifferences: options.maxDifferences ?? DEFAULT_MAX_DIFFERENCES,
    },
  );

  let report = buildDiffReport(diff);
  if (options.maxValueLength !== undefined) {
    report = truncateReportValues(report, options.maxValueLength);
  }
  if (useJson) {
    process.stdout.write(`${formatDiffJson(report)}\n`);
  } else {
    process.stdout.write(
      formatDiffText(report, options.maxValueLength ?? DEFAULT_TEXT_MAX_VALUE_LENGTH),
    );
  }
  return diff.status === "same" ? 0 : 4;
}

function parsePositiveInt(option: string): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new InvalidArgumentError(
        `invalid ${option} value (expected a positive integer): ${value}`,
      );
    }
    return parsed;
  };
}

/** program に `klaus diff` を登録する(src/cli/index.ts から呼ぶ) */
export function registerDiffCommand(program: Command): void {
  program
    .command("diff")
    .description(
      "compare two recorded runs from history (status, headers, response bodies, request changes); exits 4 when they differ",
    )
    .argument(
      "[runs...]",
      'two run IDs (exact match), or "latest" / "previous" together with --flow; omit both to compare the previous run of --flow with its latest',
    )
    .option(
      "--flow <name>",
      'flow name; required for "latest" / "previous", and limits the comparison to that flow',
    )
    .option(
      "--ignore-header <name>",
      "response header to exclude from the comparison (repeatable, case-insensitive), in addition to the default list",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--no-default-ignores",
      "do not exclude the default volatile response headers (date, age, content-length, request-id family, ...)",
    )
    .option(
      "--ignore-path <jsonpath>",
      "JSON path to exclude from body comparisons (repeatable), e.g. $.id, $.items[*].createdAt, $..updatedAt",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--duration-threshold <ms>",
      "report a step as different when its duration changed by more than this many milliseconds (durations are ignored when omitted)",
      (value: string) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0) {
          throw new InvalidArgumentError(`invalid --duration-threshold value: ${value}`);
        }
        return parsed;
      },
    )
    .option(
      "--max-differences <n>",
      `maximum differences kept per step and section (default ${DEFAULT_MAX_DIFFERENCES}); the rest is counted as "and N more"`,
      parsePositiveInt("--max-differences"),
    )
    .option(
      "--max-value-length <n>",
      `truncate values in the output to n characters (default: ${DEFAULT_TEXT_MAX_VALUE_LENGTH} in text, no limit in JSON)`,
      parsePositiveInt("--max-value-length"),
    )
    .option("--json", "force JSON output (prints JSON even when running on a TTY)")
    .option("--text", "force text output (prints text even when stdout is not a TTY)")
    .addHelpText(
      "after",
      `
Exit codes: 0=no differences / 1=invalid arguments, unknown run, or unexpected error / 4=differences found
Secrets are stored masked ("***") in history, so a change to a secret value is not visible.
`,
    )
    .action(async (refs: string[], options: DiffCommandOptions) => {
      await runCommandAction(() => diffCommand(refs, options));
    });
}
