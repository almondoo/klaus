/**
 * klaus CLI のエントリポイント。commander のセットアップのみを行い、
 * 実処理は run.ts(および reporters/*)に委譲する薄い皮にする。
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { ParseError } from "../core/index.js";
import { applyConfigToRunOptions, applyConfigToUiOptions, loadCliConfig } from "./config.js";
import { type GenerateCommandOptions, generateCommand } from "./generate.js";
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

// root ヘルプと run サブコマンドヘルプの両方の末尾に載せる共通の案内行。
// ドキュメント URL やロケール構成が変わったときに片方だけ直し漏れないよう一箇所にまとめる
const docsHelpLine = "Docs: https://almondoo.github.io/klaus/ (Japanese docs are under /ja/)";
const exitCodesHelpLine =
  "Exit codes: 0=success / 1=unexpected error / 2=invalid definition / 3=runtime error / 4=assertion failure";

/**
 * 各コマンドの action 本体を実行し、予期しない例外を共通の exit 1 ハンドリングに変換する薄いラッパー。
 * fn 内で個別に catch すべきエラー(ParseError 等、loadConfigOrReport 参照)は各アクションの責務のまま残す
 * (ここでは fn を素通しして呼ぶだけで、fn 内部の early return には関与しない)。
 */
async function runAction(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    // 予期しない例外は exit 1(パースエラー=2 / 実行時エラー=3 / アサーション失敗=4 とは区別する)
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`klaus: unexpected error: ${message}\n`);
    process.exitCode = 1;
  }
}

/**
 * klaus.config.yaml を読み込む共通ヘルパー(run/ui アクションで重複していたロジックを集約)。
 * config ファイルが見つからない場合の戻り値(undefined)は正常値のため、読み込み自体の成否は
 * ok で区別する: ParseError の場合は stderr に報告し exitCode=2 を設定した上で ok: false を返す
 * (呼び出し元はこれを見て早期 return する契約)。ParseError 以外はそのまま再送出する。
 */
async function loadConfigOrReport(
  cwd: string,
): Promise<{ ok: true; config: Awaited<ReturnType<typeof loadCliConfig>> } | { ok: false }> {
  try {
    return { ok: true, config: await loadCliConfig(cwd) };
  } catch (error) {
    if (error instanceof ParseError) {
      process.stderr.write(`klaus: parse error: ${error.message}\n`);
      process.exitCode = 2;
      return { ok: false };
    }
    throw error;
  }
}

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
${docsHelpLine}
Run \`klaus init\` to scaffold a starting point in the current directory.
${exitCodesHelpLine}
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
  .option("--text", "force text output (prints text even when stdout is not a TTY)")
  .option("--report <type>", "output an additional report format (only junit is supported for now)")
  .option(
    "--report-file <path>",
    "output path for the report format given via --report",
    "klaus-report.xml",
  )
  .option("--no-history", "disable writing to the execution history (.klaus/history/*.jsonl)")
  .option("--no-mask", "disable secret masking in stdout output (JSON/text)")
  .option(
    "--record <dir>",
    "record mode: send real HTTP requests and save request/response pairs (masked) to a cassette in <dir>",
  )
  .option(
    "--replay <dir>",
    "replay mode: serve HTTP responses from the cassette in <dir> instead of the network (unrecorded requests fail with exit code 3); cannot be combined with --record",
  )
  .option(
    "--allow-protected",
    "allow running against an environment marked $protected: true (refused with exit code 3 otherwise)",
  )
  .addHelpText(
    "after",
    `
${docsHelpLine}
${exitCodesHelpLine}
`,
  )
  .action(async (files: string[], options: RunCommandOptions, command: Command) => {
    await runAction(async () => {
      // klaus.config.yaml(存在すれば)を読み込み、CLI で明示指定されなかったオプションにのみ
      // config 側の既定値を適用する(優先順位: CLI 明示 > config > 組み込み既定)。
      const configResult = await loadConfigOrReport(process.cwd());
      if (!configResult.ok) {
        return;
      }
      const mergedOptions = applyConfigToRunOptions(
        options,
        {
          env: command.getOptionValueSource("env"),
          report: command.getOptionValueSource("report"),
          reportFile: command.getOptionValueSource("reportFile"),
          history: command.getOptionValueSource("history"),
          mask: command.getOptionValueSource("mask"),
        },
        configResult.config,
      );

      if (mergedOptions.report !== undefined && mergedOptions.report !== "junit") {
        process.stderr.write(
          `klaus: unknown report type "${mergedOptions.report}" (supported: junit)\n`,
        );
        process.exitCode = 1;
        return;
      }

      process.exitCode = await runCommand(files, mergedOptions);
    });
  });

program
  .command("ui")
  .description("launch the localhost Web UI (runner + viewer)")
  .option(
    "-p, --port <n>",
    "port to listen on",
    (value) => {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed)) {
        throw new Error(`invalid --port value: ${value}`);
      }
      return parsed;
    },
    4884,
  )
  .option(
    "-H, --host <host>",
    "host to bind to (use 0.0.0.0 to allow connections from outside, e.g. from a docker-compose host)",
    "127.0.0.1",
  )
  .option("--no-open", "do not automatically open a browser on startup")
  .action(async (options: UiCommandOptions, command: Command) => {
    await runAction(async () => {
      const configResult = await loadConfigOrReport(process.cwd());
      if (!configResult.ok) {
        return;
      }
      const mergedOptions = applyConfigToUiOptions(
        options,
        {
          port: command.getOptionValueSource("port"),
          host: command.getOptionValueSource("host"),
          open: command.getOptionValueSource("open"),
        },
        configResult.config,
      );

      await uiCommand(mergedOptions);
    });
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
    await runAction(async () => {
      process.exitCode = await validateCommand(files, options);
    });
  });

program
  .command("schema")
  .description(
    "print the JSON Schema for the flow definition YAML (or the run --json output, or klaus.config.yaml) to stdout",
  )
  .option(
    "-t, --target <target>",
    'schema to print: "flow" (default), "run-report", or "config"',
    "flow",
  )
  .action(async (options: { target: string }) => {
    // target は 3 値のみ許可(不正値は commander では検証されないためここで弾く)
    if (
      options.target !== "flow" &&
      options.target !== "run-report" &&
      options.target !== "config"
    ) {
      process.stderr.write(
        `klaus: invalid --target "${options.target}" (expected "flow", "run-report", or "config")\n`,
      );
      process.exitCode = 1;
      return;
    }
    // options.target のナローイングはクロージャ境界を越えて保持されない(TS の既知の制約)ため、
    // ナローイング済みの値をローカル変数に取り出してから渡す
    const target = options.target;
    await runAction(async () => {
      process.exitCode = await schemaCommand(target);
    });
  });

program
  .command("generate")
  .description(
    "generate skeleton flow definition YAML files (one per operation) from an OpenAPI spec",
  )
  .argument("<spec>", "OpenAPI spec file (.yaml/.yml/.json)")
  .option("--out-dir <dir>", "output directory for generated flow YAML files", "api")
  .option("--json", "force JSON output (prints JSON even when running on a TTY)")
  .action(async (spec: string, options: GenerateCommandOptions) => {
    await runAction(async () => {
      process.exitCode = await generateCommand(spec, options);
    });
  });

program
  .command("init")
  .description("generate a minimal flows/environments starting point in the current directory")
  .action(async () => {
    await runAction(async () => {
      process.exitCode = await initCommand();
    });
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
    await runAction(async () => {
      process.exitCode = await historyListCommand(options);
    });
  });

historyCommand
  .command("show")
  .description("print the history entries for the given runId, exactly as stored, as JSON")
  .argument("<runId>", "the target runId")
  .option("--step <name>", "filter by step name")
  .action(async (runId: string, options: HistoryShowOptions) => {
    await runAction(async () => {
      process.exitCode = await historyShowCommand(runId, options);
    });
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
