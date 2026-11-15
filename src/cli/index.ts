/**
 * klaus CLI のエントリポイント。commander のセットアップのみを行い、
 * 実処理は run.ts(および reporters/*)に委譲する薄い皮にする。
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError, Option } from "commander";
import { ParseError } from "../core/index.js";
import {
  applyConfigToRunOptions,
  applyConfigToUiOptions,
  loadCliConfig,
  resolveGuardOptions,
} from "./config.js";
import { registerDiffCommand } from "./diff.js";
import { type GenerateCommandOptions, generateCommand } from "./generate.js";
import {
  DEFAULT_HISTORY_FIELDS,
  type HistoryListOptions,
  type HistoryShowOptions,
  historyListCommand,
  historyShowCommand,
  parseHistoryStatuses,
} from "./history.js";
import { initCommand } from "./init.js";
import { registerMockCommand } from "./mock.js";
import {
  collectHeaderOption,
  collectQueryOption,
  collectVarOption,
  parseActorOption,
  parseMethodArgument,
  parseTimeoutOption,
} from "./option-parsers.js";
import { registerPromoteCommand } from "./promote.js";
import { type ReqCommandOptions, reqCommand } from "./req.js";
import { type RunCommandOptions, runCommand } from "./run.js";
import { schemaCommand } from "./schema.js";
import { registerSnapshotCommand } from "./snapshot.js";
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

/**
 * --tags / --exclude-tags のカンマ区切りリストをパースする共通ヘルパー。
 * 各要素を trim し、trim 後に空文字列になった要素(空エントリ・連続カンマ・前後カンマ)が
 * 1つでもあれば InvalidArgumentError で拒否する(--var の区切り検証と同じ、commander の
 * _callParseArg が InvalidArgumentError のみ特別扱いする挙動に合わせる)。
 */
function parseTagList(value: string): string[] {
  const tags = value.split(",").map((tag) => tag.trim());
  if (tags.some((tag) => tag.length === 0)) {
    throw new InvalidArgumentError(`invalid tag list (empty tag after trimming): ${value}`);
  }
  return tags;
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
    "environment name (references environments/<name>.yaml and overrides the flow definition's env; cannot be combined with --env-file)",
  )
  .option(
    "--env-file <path>",
    "load environment variables from an arbitrary YAML file path (relative to cwd or absolute) instead of a named environment; overrides the flow definition's env; cannot be combined with -e/--env",
  )
  .option(
    "--var <key=value>",
    "set an ad-hoc template variable (repeatable; the value may itself contain '='). Overrides same-named keys loaded from the environment. NOT masked as a secret in output — use OS env + {{env.X}} for real secrets",
    collectVarOption,
    {} as Record<string, string>,
  )
  .option("--json", "force JSON output (prints JSON even when running on a TTY)")
  .option("--text", "force text output (prints text even when stdout is not a TTY)")
  .option(
    "--report <list>",
    'output one or more additional report formats: a comma-separated list from "junit", "tap", "html", "github" (e.g. "junit,html")',
  )
  .option(
    "--report-file <path>",
    "output path for the report format(s) given via --report (repeatable). With N formats, pass this exactly N times, in the same order, to pair each path with its format; omit it entirely to use the per-format default filenames (klaus-report.xml for junit, klaus-report.tap for tap, klaus-report.html for html, klaus-report.md for github; github appends to $GITHUB_STEP_SUMMARY instead when that is set and no --report-file is given)",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
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
  .option(
    "--data <path>",
    "run data-driven: for each row in this JSON/YAML data file, run all given flow files once (iteration-major order). Row values land in the template env namespace, overriding same-named --var/environment values",
  )
  .option(
    "--tags <list>",
    "only run flows carrying at least one of these comma-separated tags (OR semantics). Untagged flows are excluded when this is given",
    parseTagList,
  )
  .option(
    "--exclude-tags <list>",
    "exclude flows carrying any of these comma-separated tags. Takes precedence over --tags when a flow matches both",
    parseTagList,
  )
  .option(
    "--jobs <n>",
    "run this many execution units (a flow file, or a flow-file x data-row pair when --data is given) in parallel (1-32). Steps within a single flow always stay sequential. Cannot be combined with --record",
    (value) => {
      const parsed = Number.parseInt(value, 10);
      // 理由は --port/--last と同じ(InvalidArgumentError のみ commander が整形して扱う)
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 32) {
        throw new InvalidArgumentError(`invalid --jobs value (expected an integer 1-32): ${value}`);
      }
      return parsed;
    },
  )
  .option(
    "--dry-run",
    "send nothing: print each step's expanded request (template variables that depend on earlier captures stay as {{name}}) and whether the guards would refuse it; exits 3 if any step would be refused. Writes no history; cannot be combined with --record, --replay, or --report",
  )
  .option(
    "--openapi <path>",
    "validate every HTTP response against this OpenAPI 3.0/3.1 document (YAML or JSON; local files only) and report operation coverage; a violation fails the step (exit code 4). Repeatable. Default from run.openapi in klaus.config.yaml; with --dry-run, only the planned coverage is reported",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option(
    "--openapi-base-url <url>",
    "treat this URL as a server of the OpenAPI documents when matching requests to operations (in addition to their servers; requires --openapi)",
  )
  .option(
    "--openapi-strict",
    "fail on requests that match no operation, on status codes the specification does not document, and on responses that cannot be validated (requires --openapi; cannot be combined with --dry-run)",
  )
  .option(
    "--openapi-coverage-min <percent>",
    "fail the run (exit code 4) when fewer than this percentage of the OpenAPI operations were matched by a request (0-100; requires --openapi; cannot be combined with --dry-run)",
    (value: string) => {
      // 10 進数だけを受け付ける(Number() は 0x10・1e1・空白つきの値も数にしてしまうため)
      const parsed = Number(value);
      if (!/^\d+(\.\d+)?$/.test(value) || parsed > 100) {
        throw new InvalidArgumentError(
          `invalid --openapi-coverage-min value (expected a number 0-100): ${value}`,
        );
      }
      return parsed;
    },
  )
  .option(
    "--actor <name>",
    "name recorded as history actor.name for this run (the actor kind — human/agent/ci — is still detected from environment variables)",
    parseActorOption,
  )
  .option(
    "-u, --update-snapshots",
    "assert.snapshot: rewrite baselines that differ or are missing, and remove obsolete entries (the explicit way to accept a changed response). Never read from klaus.config.yaml; cannot be combined with --dry-run, --replay, or --ci",
  )
  .option(
    "--ci",
    "assert.snapshot: fail instead of writing when a baseline is missing (also the default when the CI environment variable is set to a truthy value)",
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
          jobs: command.getOptionValueSource("jobs"),
          openapi: command.getOptionValueSource("openapi"),
        },
        configResult.config,
      );

      // --report/--report-file(フォーマット不明・個数不一致)の検査は runCommand 側(resolveReportTargets)
      // が行う(--record/--replay 等の他の組み合わせ検査と同じ流儀で runCommand に集約している)。
      // guard(送信先ホストの許可リスト)は config からのみ設定できる(CLI フラグでの上書きは設けない)
      const guard = resolveGuardOptions(configResult.config);
      // --dry-run ではレポートファイルを書かないため、config の run.report / run.reportFile は適用しない
      // (config に report を書いたプロジェクトでも --dry-run を使えるようにする。CLI で明示した --report は
      // runCommand が引数エラーにする)
      const { report: _configReport, ...mergedWithoutReport } = mergedOptions;
      const finalOptions: RunCommandOptions = options.dryRun
        ? {
            ...mergedWithoutReport,
            ...(options.report !== undefined ? { report: options.report } : {}),
            reportFile: options.reportFile,
          }
        : mergedOptions;
      process.exitCode = await runCommand(files, guard ? { ...finalOptions, guard } : finalOptions);
    });
  });

program
  .command("req")
  .description("send a single ad-hoc HTTP request (guarded, secret-masked, recorded in history)")
  .argument("<method>", "HTTP method (e.g. GET, POST; case-insensitive)", parseMethodArgument)
  .argument("<url>", "request URL (template placeholders such as {{baseUrl}} are expanded)")
  .option(
    "-H, --header <name:value>",
    "request header (repeatable; split at the first ':'. A repeated name keeps the last value). Values are template-expanded",
    collectHeaderOption,
    {} as Record<string, string>,
  )
  .option(
    "--query <key=value>",
    "query string parameter merged into the URL (repeatable; the value may itself contain '='; overrides a same-named key already in the URL)",
    collectQueryOption,
    {} as Record<string, string>,
  )
  .option(
    "--body <json>",
    "request body: a JSON value, or @<file> to read it from a file under the current directory. Input that is not valid JSON is sent as a raw string",
  )
  .option(
    "-e, --env <name>",
    "environment name (references environments/<name>.yaml; cannot be combined with --env-file)",
  )
  .option(
    "--env-file <path>",
    "load environment variables from an arbitrary YAML file path (relative to cwd or absolute) instead of a named environment; cannot be combined with -e/--env",
  )
  .option(
    "--var <key=value>",
    "set an ad-hoc template variable (repeatable; the value may itself contain '='). Overrides same-named keys loaded from the environment. NOT masked as a secret in output — use OS env + {{env.X}} for real secrets",
    collectVarOption,
    {} as Record<string, string>,
  )
  .option("--timeout <ms>", "request timeout in milliseconds (default 30000)", parseTimeoutOption)
  .option("--json", "force JSON output (prints JSON even when running on a TTY)")
  .option("--text", "force text output (prints text even when stdout is not a TTY)")
  .option("--no-history", "disable writing to the execution history (.klaus/history/*.jsonl)")
  .option("--no-mask", "disable secret masking in stdout output (JSON/text)")
  .option(
    "--actor <name>",
    "name recorded as history actor.name for this request (the actor kind — human/agent/ci — is still detected from environment variables)",
    parseActorOption,
  )
  .addHelpText(
    "after",
    `
${docsHelpLine}
${exitCodesHelpLine}
`,
  )
  .action(async (method: string, url: string, options: ReqCommandOptions) => {
    await runAction(async () => {
      // req は klaus.config.yaml から guard(送信先ホストの許可リスト)だけを読む。run の既定値
      // (run.env / run.history / run.mask 等)は `klaus run` のオプション用であり、req には適用しない
      const configResult = await loadConfigOrReport(process.cwd());
      if (!configResult.ok) {
        return;
      }
      const guard = resolveGuardOptions(configResult.config);
      process.exitCode = await reqCommand(method, url, guard ? { ...options, guard } : options);
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
        // commander の _callParseArg は InvalidArgumentError のみ特別扱いする(それ以外は
        // 素通しで re-throw され未捕捉スタックトレースになる)ため、plain Error ではなくこれを使う
        throw new InvalidArgumentError(`invalid --port value: ${value}`);
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

      const guard = resolveGuardOptions(configResult.config);
      await uiCommand(guard ? { ...mergedOptions, guard } : mergedOptions);
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
    "print the JSON Schema for the flow definition YAML (or the run --json output, the req --json output, the run --dry-run --json output, or klaus.config.yaml) to stdout",
  )
  .option(
    "-t, --target <target>",
    'schema to print: "flow" (default), "run-report", "req-report", "dry-run-report", or "config"',
    "flow",
  )
  .action(async (options: { target: string }) => {
    // target は 3 値のみ許可(不正値は commander では検証されないためここで弾く)
    if (
      options.target !== "flow" &&
      options.target !== "run-report" &&
      options.target !== "req-report" &&
      options.target !== "dry-run-report" &&
      options.target !== "config"
    ) {
      process.stderr.write(
        `klaus: invalid --target "${options.target}" (expected "flow", "run-report", "req-report", "dry-run-report", or "config")\n`,
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
  .addOption(
    new Option("--failed", "only include entries whose status is failed").conflicts("status"),
  )
  .addOption(
    new Option(
      "--status <statuses>",
      "only include entries whose status is in the comma-separated list (passed, failed, skipped, error)",
    )
      .argParser(parseHistoryStatuses)
      .conflicts("failed"),
  )
  .option(
    "--last <n>",
    "number of entries to fetch",
    (value) => {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        // 理由は --port と同じ(InvalidArgumentError のみ commander が整形して扱う)
        throw new InvalidArgumentError(`invalid --last value: ${value}`);
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
  .description(
    "print the history entries for the given runId as stored, as JSON (snapshot candidates are included only with --step)",
  )
  .argument("<runId>", "the target runId")
  .option("--step <name>", "filter by step name (also includes snapshot candidates)")
  .action(async (runId: string, options: HistoryShowOptions) => {
    await runAction(async () => {
      process.exitCode = await historyShowCommand(runId, options);
    });
  });

// 別ファイルで定義したコマンドを登録する。
registerDiffCommand(program);
registerPromoteCommand(program);
registerMockCommand(program);
registerSnapshotCommand(program);

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
