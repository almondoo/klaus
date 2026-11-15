import { constants } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type Command, InvalidArgumentError } from "commander";
import {
  findUnsafeSymlinkInWritePath,
  isPathWithinDir,
  isRealPathWithinDir,
  type PromoteAssertMode,
  promoteRuns,
  readAllHistoryEntries,
  renderPromotedYaml,
  selectRunEntries,
  toDisplayPath,
  validateFlowYaml,
} from "../core/index.js";
import { runCommandAction } from "./command-action.js";
import {
  buildPromoteReport,
  formatPromoteJson,
  formatPromoteText,
  type PromoteReport,
} from "./reporters/promote.js";

/** promote コマンドのオプション(commander から渡される値を正規化した形) */
export interface PromoteCommandOptions {
  out?: string;
  stdout?: boolean;
  force?: boolean;
  /** 既定は "schema"(status + bodySchema + content-type) */
  assert?: PromoteAssertMode;
  baseUrlVar?: string;
  /** commander の --no-chain により、指定が無ければ true(チェイン推論を行う) */
  chain?: boolean;
  name?: string;
  flow?: string;
  /** 記録値のリテラルの "{{" を許可する(既定では生成を拒否する) */
  allowTemplateLiterals?: boolean;
  json?: boolean;
  text?: boolean;
}

const ASSERT_MODES: readonly PromoteAssertMode[] = ["status", "schema", "values", "all"];
const TEMPLATE_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 引数の誤り・不明な run は exit 1(klaus history show と同じ) */
function fail(message: string): number {
  process.stderr.write(`klaus: ${message}\n`);
  return 1;
}

/** 内容に起因する拒否(出力ファイルが既存・cwd 外・生成物の検証エラー等)は exit 2 */
function failContent(message: string): number {
  process.stderr.write(`klaus: ${message}\n`);
  return 2;
}

function isErrnoException(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code
  );
}

/**
 * promote コマンド本体。履歴の run からフロー YAML を生成する。
 * - 既存ファイルは --force なしでは上書きしない(exit 2)。出力先は cwd 配下に限り、最終要素のシンボリックリンクは
 *   行き先を問わず拒否し、途中のディレクトリのシンボリックリンクは実在して cwd 内を指す場合だけ許可する。
 *   書き込みは O_NOFOLLOW で開く(検査後にリンクへ差し替えられても辿らない)
 * - 書き込み前に validateFlowYaml で検証する(use ステップを生成しないため validateFlowFile と同じ判定になる)
 * - --stdout では YAML だけを stdout に出し、サマリーは stderr に出す
 * - exit code: 成功 0 / 引数不正・不明な run・flow 指定の不足 1(klaus history show と同じ)/
 *   内容に起因する拒否 2(出力ファイルが既存・出力先が cwd 外・リンク拒否・生成物の検証エラー・マスク値の残存・
 *   リテラルの "{{"・フロー化できるステップが無い)。予期しない例外も 1
 */
export async function promoteCommand(
  runIds: string[],
  options: PromoteCommandOptions,
  cwd: string = process.cwd(),
): Promise<number> {
  if (options.json === true && options.text === true) {
    return fail("--json and --text cannot be used together");
  }
  if (options.stdout === true && options.out !== undefined) {
    return fail("--stdout and --out cannot be used together");
  }
  if (options.stdout === true && options.force === true) {
    return fail("--force has no effect with --stdout");
  }
  const mode = options.assert ?? "schema";
  if (!ASSERT_MODES.includes(mode)) {
    return fail(`invalid --assert "${mode}" (expected ${ASSERT_MODES.join(", ")})`);
  }
  if (options.baseUrlVar !== undefined && !TEMPLATE_VARIABLE_NAME.test(options.baseUrlVar)) {
    return fail(
      `invalid --base-url-var "${options.baseUrlVar}" (expected letters, digits, and underscores)`,
    );
  }
  if (runIds.length === 0) return fail("at least one <runId> is required");

  const useJson =
    options.json === true ? true : options.text === true ? false : !process.stdout.isTTY;

  const history = await readAllHistoryEntries(cwd);
  const runs = [];
  for (const runId of runIds) {
    // 同一ミリ秒のステップの順序を履歴の行順で確定させるため、追記順で取り出す
    const entries = selectRunEntries(history, runId);
    if (entries.length === 0) return fail(`no history entries found for runId "${runId}"`);
    runs.push({ runId, entries });
  }

  const outcome = promoteRuns(runs, {
    assert: mode,
    baseUrlVar: options.baseUrlVar,
    chain: options.chain !== false,
    name: options.name,
    flow: options.flow,
    allowTemplateLiterals: options.allowTemplateLiterals === true,
  });
  if (!outcome.ok)
    return outcome.kind === "usage" ? fail(outcome.message) : failContent(outcome.message);
  const { result } = outcome;

  const yaml = renderPromotedYaml(result, runIds);
  // マスク値が再現できないまま残っていないことを確認する(残る場合は生成物が誤ったリクエストを送るため書かない)
  if (yaml.includes("***")) {
    return failContent(
      "the generated flow still contains a masked value (***); refusing to write it",
    );
  }
  const validation = validateFlowYaml(yaml);
  if (!validation.valid) {
    const issues = validation.errors.map((issue) => `${issue.path || "(root)"}: ${issue.message}`);
    return failContent(`the generated flow failed validation: ${issues.join("; ")}`);
  }

  let file: string | undefined;
  if (options.stdout !== true) {
    const resolvedCwd = resolve(cwd);
    const requested = options.out ?? result.suggestedPath;
    const target = resolve(cwd, requested);
    if (
      target === resolvedCwd ||
      !isPathWithinDir(resolvedCwd, target) ||
      !isRealPathWithinDir(resolvedCwd, target)
    ) {
      return failContent(`output path resolves outside the current directory: "${requested}"`);
    }
    file = toDisplayPath(resolvedCwd, target);
    const unsafe = findUnsafeSymlinkInWritePath(resolvedCwd, target);
    if (unsafe) return failContent(`refusing to write the output file: ${unsafe}`);
    try {
      await mkdir(dirname(target), { recursive: true });
      // mkdir 後に親ディレクトリの実体が cwd 内であることを再確認する(検査と作成の間の差し替えを狭める)
      const realParent = await realpath(dirname(target));
      const realCwd = await realpath(resolvedCwd);
      if (!isPathWithinDir(realCwd, realParent)) {
        return failContent(`output path resolves outside the current directory: "${requested}"`);
      }
      // O_NOFOLLOW: 最終要素がシンボリックリンクなら開かずに失敗する。O_EXCL(--force なし)は既存も失敗にする
      const handle = await open(
        target,
        constants.O_WRONLY |
          constants.O_CREAT |
          (constants.O_NOFOLLOW ?? 0) |
          (options.force === true ? constants.O_TRUNC : constants.O_EXCL),
        0o644,
      );
      try {
        await handle.writeFile(yaml, "utf-8");
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isErrnoException(error, "EEXIST")) {
        return failContent(`"${file}" already exists (use --force to overwrite)`);
      }
      if (isErrnoException(error, "ELOOP")) {
        return failContent(`refusing to write the output file: "${file}" is a symbolic link`);
      }
      if (isErrnoException(error, "EISDIR") || (await isDirectory(target))) {
        return failContent(`"${file}" is a directory`);
      }
      if (isErrnoException(error, "ENOTDIR") || isErrnoException(error, "ENOENT")) {
        return failContent(`cannot create "${file}": a parent path is not a usable directory`);
      }
      throw error;
    }
  }

  const report = buildPromoteReport(result, file);
  const summary = useJson ? `${formatPromoteJson(report)}\n` : formatPromoteText(report);
  if (options.stdout === true) {
    process.stdout.write(yaml);
    process.stderr.write(summary);
  } else {
    process.stdout.write(summary);
  }
  return 0;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export type { PromoteReport };

/** program に `klaus promote` を登録する(src/cli/index.ts から呼ぶ) */
export function registerPromoteCommand(program: Command): void {
  program
    .command("promote")
    .description(
      "turn recorded history into a re-runnable flow YAML with assertions inferred from the observed responses",
    )
    .argument("<runIds...>", "run ID(s) to promote (several are concatenated in the given order)")
    .option(
      "-o, --out <path>",
      "output file (relative to the current directory, must stay inside it; default api/<name>.yaml for one step, flows/<name>.yaml for several)",
    )
    .option(
      "--stdout",
      "print the YAML to stdout instead of writing a file (the summary goes to stderr)",
    )
    .option("--force", "overwrite the output file if it already exists")
    .option(
      "--assert <mode>",
      "assertions to infer: status (status only), schema (status + content-type + bodySchema, default), values (status + content-type + stable scalar equals), all",
      (value: string): PromoteAssertMode => {
        if (!ASSERT_MODES.includes(value as PromoteAssertMode)) {
          throw new InvalidArgumentError(`expected one of ${ASSERT_MODES.join(", ")}`);
        }
        return value as PromoteAssertMode;
      },
      "schema",
    )
    .option(
      "--base-url-var <name>",
      "replace the origin of every URL with {{name}} and print the value to put in the environment file",
    )
    .option("--no-chain", "do not infer capture links between steps")
    .option(
      "--allow-template-literals",
      'emit recorded request values that contain a literal "{{" instead of refusing; they are expanded as templates when the flow runs (e.g. {{env.X}} would send an OS environment variable), so review each one',
    )
    .option(
      "--name <name>",
      "flow name (default: the recorded flow name, or derived from the host)",
    )
    .option("--flow <name>", "when a run contains several flows, the flow to promote")
    .option("--json", "force JSON output (prints JSON even when running on a TTY)")
    .option("--text", "force text output (prints text even when stdout is not a TTY)")
    .addHelpText(
      "after",
      `
Masked values ("***") in the recorded request are replaced by {{env.TODO_*}} placeholders; set them as OS environment variables before running the generated flow.
Exit codes: 0=success / 1=invalid arguments, unknown run, or unexpected error / 2=the output file already exists, an unsafe output path, or the history cannot be promoted safely
`,
    )
    .action(async (runIds: string[], options: PromoteCommandOptions) => {
      await runCommandAction(() => promoteCommand(runIds, options));
    });
}
