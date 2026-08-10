/**
 * klaus localhost UI サーバーの公開 API。
 * `klaus ui` サブコマンド(src/cli/ui.ts)がビルド後の dist/server.js を dynamic import して使う。
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createNodeServer } from "node:http";
import type { Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { bridgeHonoApp } from "./node-bridge.js";

export interface StartServerOptions {
  // 呼び出し元(CLI の --port 未指定時など)から明示的に undefined が渡ることがあるため許容する
  /** 未指定ならエフェメラルポート(OS が空きポートを自動選択)を使う(テストの並列実行が随意ポートに依存しているため、この既定は CLI 層の固定ポート化とは独立に維持する) */
  port?: number | undefined;
  /** フロー探索・実行の基準ディレクトリ。既定は process.cwd() */
  cwd?: string;
  // 呼び出し元(CLI の --host 未指定時など)から明示的に undefined が渡ることがあるため許容する
  /** バインド先ホスト。未指定なら "127.0.0.1"(既定、これまでと同じ挙動)。"0.0.0.0" 等を指定するとコンテナ外など他ホストからの接続も受け付けられる */
  host?: string | undefined;
}

export interface StartServerResult {
  port: number;
  token: string;
  /** トークン付きの起動 URL(ブラウザで開く用) */
  url: string;
  /** サーバーを停止する(進行中の接続も強制的に切断する) */
  close: () => Promise<void>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/** ビルド後の dist/server.js から見て dist/ui を静的配信ディレクトリとして解決する */
function resolveStaticDir(): string {
  return join(__dirname, "ui");
}

/**
 * klaus UI サーバーを起動する。
 * バインド先は既定で 127.0.0.1(host 未指定時)。host オプションで変更できる(例: "0.0.0.0")。
 * Host ヘッダー検証には実際に割り当てられたポート番号が必要なため、
 * 先に listen してポートを確定させてから Hono アプリを構築する(この間のリクエスト取りこぼしを防ぐため、
 * リクエストハンドラは差し替え可能な間接参照を経由させる)。
 */
export async function startServer(options: StartServerOptions = {}): Promise<StartServerResult> {
  const cwd = options.cwd ?? process.cwd();
  const bindHost = options.host ?? "127.0.0.1";
  const token = randomBytes(32).toString("hex");
  const staticDir = resolveStaticDir();

  let currentHandler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("klaus server is starting up");
  };

  const server = createNodeServer((req, res) => currentHandler(req, res));

  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, bindHost, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("failed to determine klaus server port");
  }
  const port = address.port;

  const app = createApp({ cwd, token, port, staticDir, host: bindHost });
  currentHandler = bridgeHonoApp(app, `127.0.0.1:${port}`);

  // 表示・接続用 URL は 127.0.0.1 を使う("0.0.0.0" はワイルドカードバインドであり、
  // ブラウザで直接開けない環境があるため。ローカルからは 0.0.0.0 バインドでも 127.0.0.1 で到達できる)
  const displayHost = bindHost === "0.0.0.0" ? "127.0.0.1" : bindHost;
  const url = `http://${displayHost}:${port}/?token=${token}`;

  const close = async (): Promise<void> => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return { port, token, url, close };
}
