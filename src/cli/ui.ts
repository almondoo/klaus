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
  port?: number;
  /** commander の --no-open により、指定が無ければ true(ブラウザを開く) */
  open: boolean;
}

interface ServerModule {
  startServer: (options: StartServerOptions) => Promise<StartServerResult>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** OS ごとのコマンドでデフォルトブラウザを開く(依存追加はしない) */
function openBrowser(url: string): void {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (platform === "win32") {
      // Windows の `start` はコマンド解釈の都合上、第一引数をウィンドウタイトルとして扱うため空文字を渡す
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // ブラウザが開けなくても致命的ではない(URL は stdout に出力済みなので手動で開ける)
  }
}

/** klaus ui コマンド本体。サーバーを起動し、Ctrl+C まで待機し続ける */
export async function uiCommand(options: UiCommandOptions): Promise<void> {
  // dist/cli.js と dist/server.js は同じ dist/ 直下に並ぶビルド構成(tsup.config.ts 参照)
  const serverEntryPath = join(__dirname, "server.js");
  const { startServer } = (await import(serverEntryPath)) as ServerModule;

  const { url, close } = await startServer({ port: options.port, cwd: process.cwd() });

  process.stdout.write(`klaus UI を起動しました: ${url}\n`);
  process.stdout.write("終了するには Ctrl+C を押してください\n");

  if (options.open) {
    openBrowser(url);
  }

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write("\nklaus UI を終了します\n");
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // commander の action から抜けるとプロセスが終了してしまうため、Ctrl+C まで待機し続ける
  await new Promise<void>(() => {});
}
