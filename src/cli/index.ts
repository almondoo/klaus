/**
 * klaus CLI のエントリポイント。commander のセットアップのみを行い、
 * 実処理は run.ts(および reporters/*)に委譲する薄い皮にする。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { type RunCommandOptions, runCommand } from "./run.js";
import { type UiCommandOptions, uiCommand } from "./ui.js";

// dist/cli.js から見て一つ上がパッケージルート(package.json が常に同梱される)
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as {
  version: string;
};

const program = new Command();

program
  .name("klaus")
  .description("API 検証 CLI: YAML でリクエストフローを定義し、実行・アサーション・履歴管理を行う")
  .version(pkg.version);

program
  .command("run")
  .description("フロー定義 YAML を実行する")
  .argument("<files...>", "実行するフロー定義 YAML ファイル")
  .option(
    "-e, --env <name>",
    "環境名(environments/<name>.yaml を参照し、フロー定義の env を上書きする)",
  )
  .option("--json", "出力を JSON 形式に強制する(TTY 実行時でも JSON を出力する)")
  .option("--report <type>", "追加のレポート形式を出力する(現時点では junit のみ対応)")
  .option("--report-file <path>", "--report で指定した形式のレポート出力先パス", "klaus-report.xml")
  .option("--no-history", "実行履歴(.klaus/history/*.jsonl)への書き込みを無効化する")
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
  .description("localhost Web UI を起動する(ランナー + ビューア)")
  .option("-p, --port <n>", "待ち受けポート(未指定時はエフェメラルポート)", (value) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`invalid --port value: ${value}`);
    }
    return parsed;
  })
  .option("--no-open", "起動後にブラウザを自動で開かない")
  .action(async (options: UiCommandOptions) => {
    try {
      await uiCommand(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`klaus: unexpected error: ${message}\n`);
      process.exitCode = 1;
    }
  });

await program.parseAsync(process.argv);
