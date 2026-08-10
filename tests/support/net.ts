import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * サーバーをローカルの空きポート(127.0.0.1)で listen し、確定した port と baseUrl を返す。
 * 各テストファイルの fixture サーバーで繰り返されていた
 * 「listen(0, "127.0.0.1", ...) して AddressInfo からポートを取り出す」定型処理をまとめたもの。
 */
export function listenEphemeral(server: Server): Promise<{ port: number; baseUrl: string }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * サーバー(node:http の Server / ws の WebSocketServer など、close(callback) を持つもの)を閉じ、
 * 完了を待つ。
 */
export function closeServer(server: { close(callback: () => void): unknown }): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** 確実に接続不能になる(誰も listen していない)ポートを1つ確保する */
export async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  const { port } = await listenEphemeral(server);
  await closeServer(server);
  return port;
}
