/**
 * klaus CLI のエントリポイント。commander のセットアップのみを行い、
 * 実処理は run.ts(および reporters/*)に委譲する薄い皮にする。
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  DEFAULT_HISTORY_FIELDS,
  type HistoryListOptions,
  type HistoryShowOptions,
  historyListCommand,
  historyShowCommand,
} from "./history.js";
import { initCommand } from "./init.js";
import { type RunCommandOptions, runCommand } from "./run.js";
import { schemaCommand } from "./schema.js";
import { type UiCommandOptions, uiCommand } from "./ui.js";
import { type ValidateCommandOptions, validateCommand } from "./validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * package.json を読む。dist/cli.js から見て一つ上がパッケージルート(package.json が常に同梱される)だが、
 * ビルド前の src/cli/index.ts をテストから直接 import した場合は二つ上(src/ の親)がパッケージルートになるため、
 * 両方を候補として先に見つかった方を使う。
 */
function readPackageJson(): { version: string } {
  const candidates = [
    join(__dirname, "..", "package.json"),
    join(__dirname, "..", "..", "package.json"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error(`package.json not found (looked in: ${candidates.join(", ")})`);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as { version: string };
}

const pkg = readPackageJson();

const program = new Command();

program
  .name("klaus")
  .description(
    "API testing CLI: define request flows in YAML and run execution, assertions, and history tracking",
  )
  .version(pkg.version);

program.addHelpText(
  "after",
  `
Docs: https://almondoo.github.io/klaus/ (English docs are under /en/)
Run \`klaus init\` to scaffold a starting point in the current directory.
Exit codes: 0=success / 1=unexpected error / 2=invalid definition / 3=runtime error / 4=assertion failure
`,
);

program
  .command("run")
  .description("run flow definition YAML files")
  .argument("<files...>", "flow definition YAML files to run")
  .option(
    "-e, --env <name>",
    "environment name (references environments/<name>.yaml and overrides the flow definition's env)",
  )
  .option("--json", "force JSON output (prints JSON even when running on a TTY)")
  .option("--report <type>", "output an additional report format (only junit is supported for now)")
  .option(
    "--report-file <path>",
    "output path for the report format given via --report",
    "klaus-report.xml",
  )
  .option("--no-history", "disable writing to the execution history (.klaus/history/*.jsonl)")
  .addHelpText(
    "after",
    `
Docs: https://almondoo.github.io/klaus/ (English docs are under /en/)
Exit codes: 0=success / 1=unexpected error / 2=invalid definition / 3=runtime error / 4=assertion failure
`,
  )
  .action(async (files: string[], options: RunCommandOptions) => {
    if (options.report !== undefined && options.report !== "junit") {
      process.stderr.write(`klaus: unknown report type "${options.report}" (supported: junit)\n`);
      process.exitCode = 1;
      return;
    }
    try {
      process.exitCode = await runCommand(files, options);
    } catch (error) {
      // 予期しない例外は exit 1(パースエラー=2 / 実行時エラー=3 / アサーション失敗=4 とは区別する)
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`klaus: unexpected error: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("ui")
  .description("launch the localhost Web UI (runner + viewer)")
  .option("-p, --port <n>", "port to listen on (an ephemeral port is used if omitted)", (value) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`invalid --port value: ${value}`);
    }
    return parsed;
  })
  .option("--no-open", "do not automatically open a browser on startup")
  .action(async (options: UiCommandOptions) => {
    try {
      await uiCommand(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`klaus: unexpected error: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("validate")
  .description("schema-validate flow definition YAML files without executing them")
  .argument(
    "[files...]",
    "flow definition YAML files to validate (searches the current directory recursively if omitted)",
  )
  .option("--json", "force JSON output (prints JSON even when running on a TTY)")
  .action(async (files: string[], options: ValidateCommandOptions) => {
    try {
      process.exitCode = await validateCommand(files, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`klaus: unexpected error: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("schema")
  .description(
    "print the JSON Schema for the flow definition YAML (or the run --json output) to stdout",
  )
  .option("-t, --target <target>", 'schema to print: "flow" (default) or "run-report"', "flow")
  .action(async (options: { target: string }) => {
    // target は 2 値のみ許可(不正値は commander では検証されないためここで弾く)
    if (options.target !== "flow" && options.target !== "run-report") {
      process.stderr.write(
        `klaus: invalid --target "${options.target}" (expected "flow" or "run-report")\n`,
      );
      process.exitCode = 1;
      return;
    }
    try {
      process.exitCode = await schemaCommand(options.target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`klaus: unexpected error: ${message}\n`);
      process.exitCode = 1;
    }
  });

program
  .command("init")
  .description("generate a minimal flows/environments starting point in the current directory")
  .action(async () => {
    try {
      process.exitCode = await initCommand();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`klaus: unexpected error: ${message}\n`);
      process.exitCode = 1;
    }
  });

const historyCommand = program
  .command("history")
  .description("list execution history (.klaus/history/*.jsonl)")
  .option("--flow <name>", "filter by flow name")
  .option("--failed", "only include entries whose status is failed")
  .option(
    "--last <n>",
    "number of entries to fetch",
    (value) => {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new Error(`invalid --last value: ${value}`);
      }
      return parsed;
    },
    20,
  )
  .option("--fields <csv>", "comma-separated list of fields to output", DEFAULT_HISTORY_FIELDS)
  .option("--json", "force JSON output (prints JSON even when running on a TTY)")
  .action(async (options: HistoryListOptions) => {
    try {
      process.exitCode = await historyListCommand(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`klaus: unexpected error: ${message}\n`);
      process.exitCode = 1;
    }
  });

historyCommand
  .command("show")
  .description("print the history entries for the given runId, exactly as stored, as JSON")
  .argument("<runId>", "the target runId")
  .option("--step <name>", "filter by step name")
  .action(async (runId: string, options: HistoryShowOptions) => {
    try {
      process.exitCode = await historyShowCommand(runId, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`klaus: unexpected error: ${message}\n`);
      process.exitCode = 1;
    }
  });

// このモジュールが直接実行された(node dist/cli.js ...)場合のみパースする。
// テストから import した際に process.argv(vitest 自身の起動引数)を誤ってパースしないためのガード。
// program 自体は tests/cli/ から helpInformation() 等で参照できるよう export しておく。
// 注意: npm/pnpm の bin 経由では argv[1] がシンボリックリンクのパスになる一方、
// import.meta.url は realpath 解決済みのため、argv[1] 側も realpath に揃えて比較する。
const isMainModule = (() => {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMainModule) {
  await program.parseAsync(process.argv);
}

export { program };
