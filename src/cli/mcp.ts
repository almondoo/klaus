import type { Command } from "commander";
import { runCommandAction } from "./command-action.js";

/** mcp コマンドのオプション(commander から渡される値を正規化した形) */
export interface McpCommandOptions {
  /** ファイルを書くツール(klaus_promote / klaus_snapshot_accept)を登録しない */
  readOnly?: boolean;
}

/** 終了を決めてから、まだ何かがイベントループを占有している場合に強制終了するまでの猶予(ミリ秒) */
const EXIT_GRACE_MS = 3000;

/**
 * 標準出力に書かれる console 出力を標準エラーへ回す。stdout は MCP のプロトコルのメッセージ専用で、
 * 1 行でも別のものが混ざるとクライアントが接続を壊すため、依存ライブラリの console.log 等も含めて塞ぐ。
 */
function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(
      `${args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")}\n`,
    );
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

/**
 * mcp コマンド本体。stdio の MCP サーバーを起動し、標準入力が閉じる・SIGINT・SIGTERM のいずれかまで待つ。
 * 作業ディレクトリは process.cwd()。guard などの設定はツールの呼び出しごとに klaus.config.yaml から読み直す。
 * MCP サーバー(と SDK)は実行時に読み込み、他のコマンドの起動時間に影響させない。
 * 終了コードは常に 0(起動後の異常は標準エラーに出して継続する。起動前の例外は呼び出し側が exit 1 にする)。
 */
export async function mcpCommand(
  options: McpCommandOptions,
  version: string,
  cwd: string = process.cwd(),
): Promise<number> {
  redirectConsoleToStderr();
  const { runMcpServer } = await import("../mcp/server.js");
  await runMcpServer({ cwd, readOnly: options.readOnly === true, version });
  // 接続が閉じた後、実行中だったリクエストなどが残っていても、猶予のあとに終了する(自然に終われば、これは働かない)
  setTimeout(() => process.exit(0), EXIT_GRACE_MS).unref();
  return 0;
}

/** program に `klaus mcp` を登録する(src/cli/index.ts から呼ぶ) */
export function registerMcpCommand(program: Command): void {
  program
    .command("mcp")
    .description(
      "run a stdio MCP server that exposes klaus operations as tools for AI agents (guards and secret masking always apply; there is no option to turn them off)",
    )
    .option(
      "--read-only",
      "do not register the tools that write files (klaus_promote, klaus_snapshot_accept)",
    )
    .addHelpText(
      "after",
      `
Run from the project directory. The server speaks the Model Context Protocol over stdin/stdout only (no network listener);
all diagnostics go to stderr. It exits 0 when stdin closes or on SIGINT/SIGTERM.
There is no --allow-protected, --no-mask or guard option. guard.allowedHosts in klaus.config.yaml is what limits where requests can be sent (set it when using klaus mcp); $protected only gates runs that select that environment.
`,
    )
    .action(async (options: McpCommandOptions) => {
      await runCommandAction(() => mcpCommand(options, program.version() ?? "0.0.0"));
    });
}
