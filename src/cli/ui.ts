/**
 * `klaus ui` サブコマンドの実装。
 * server モジュール(dist/server.js)は dynamic import で読み込み、通常の `klaus run` の
 * 起動時間に一切影響させない(import specifier を実行時に組み立てた変数にすることで、
 * バンドラがこの import を静的解析してバンドルに inline してしまうのを避けている)。
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StartServerOptions, StartServerResult } from "../server/index.js";

export interface UiCommandOptions {
  /** commander 側で既定値 4884 を設定しているため、通常は常に値が入る(直接呼び出すテスト等のために型上は任意にしている) */
  port?: number;
  /** バインド先ホスト。commander 側で既定値 "127.0.0.1" を設定している */
  host?: string;
  /** commander の --no-open により、指定が無ければ true(ブラウザを開く) */
  open: boolean;
}

interface ServerModule {
  startServer: (options: StartServerOptions) => Promise<StartServerResult>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

interface OpenerCommand {
  command: string;
  args: string[];
}

/** プラットフォームごとのデフォルト opener コマンドを組み立てる */
function resolveOpener(url: string): OpenerCommand {
  const platform = process.platform;
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    // Windows の `start` はコマンド解釈の都合上、第一引数をウィンドウタイトルとして扱うため空文字を渡す
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

/**
 * OS ごとのコマンドでデフォルトブラウザを開く(依存追加はしない)。
 * commandOverride はテストで opener コマンドを差し替えるためのフック(未指定時は既存のプラットフォーム別挙動)。
 */
export function openBrowser(url: string, commandOverride?: OpenerCommand): void {
  const { command, args } = commandOverride ?? resolveOpener(url);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    // spawn の ENOENT 等は同期 throw ではなく ChildProcess の 'error' イベントとして非同期に emit
    // されるため、リスナーを登録しないと unhandled 'error' でプロセスごとクラッシュする。
    // ブラウザが開けなくても致命的ではないので、警告を出すだけに留める(URL は stdout に出力済みなので手動で開ける)。
    child.on("error", (err) => {
      process.stderr.write(
        `klaus: could not open a browser automatically (${err.message}); open the URL manually or use --no-open\n`,
      );
    });
    child.unref();
  } catch {
    // 同期的な spawn 失敗(EPERM 等のまれなケース)にも備えて残す
  }
}

/**
 * Node のエラーオブジェクトかどうかを判定する(EADDRINUSE 等の `code` プロパティ参照用)。
 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** klaus ui コマンド本体。サーバーを起動し、Ctrl+C まで待機し続ける */
export async function uiCommand(options: UiCommandOptions): Promise<void> {
  // dist/cli.js と dist/server.js は同じ dist/ 直下に並ぶビルド構成(tsup.config.ts 参照)
  const serverEntryPath = join(__dirname, "server.js");
  const { startServer } = (await import(serverEntryPath)) as ServerModule;

  let startResult: StartServerResult;
  try {
    startResult = await startServer({ port: options.port, host: options.host, cwd: process.cwd() });
  } catch (error) {
    // 固定既定ポート(4884)化に伴い衝突しやすくなるため、EADDRINUSE には --port の案内を添える
    if (isErrnoException(error) && error.code === "EADDRINUSE") {
      const portHint = options.port !== undefined ? ` ${options.port}` : "";
      throw new Error(
        `${error.message} (port${portHint} is already in use; specify a different port with --port)`,
      );
    }
    throw error;
  }
  const { url, close } = startResult;

  const hostNote = options.host === "0.0.0.0" ? " (listening on 0.0.0.0)" : "";
  process.stdout.write(`klaus UI started: ${url}${hostNote}\n`);
  process.stdout.write("Press Ctrl+C to stop\n");

  if (options.open) {
    openBrowser(url);
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write("\nStopping klaus UI\n");
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // commander の action から抜けるとプロセスが終了してしまうため、Ctrl+C まで待機し続ける
  await new Promise<void>(() => {});
}
