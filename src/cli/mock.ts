/**
 * `klaus mock <dir>` サブコマンドの実装。
 * `klaus run --record <dir>` で記録したカセットを返すだけのローカル HTTP サーバーを起動する。
 * ネットワークへは一切転送しない(未マッチは 404)。マッチングは core/mock.ts の純粋関数に委ねる。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import {
  buildMockResponse,
  createMockMatcher,
  loadCassetteEntries,
  type MockMatcher,
  normalizeOrigin,
  parseRequestTarget,
  RuntimeError,
} from "../core/index.js";

/** UI の既定ポート(4884)と衝突しない mock 用の既定ポート */
export const MOCK_DEFAULT_PORT = 4885;

export interface MockCommandOptions {
  port?: number;
  host?: string;
  cors?: boolean;
  /** 固定遅延(ミリ秒) */
  delay?: number;
  ignoreQuery?: boolean;
  sequence?: boolean;
  origin?: string;
  /** 起動行とリクエストログを機械可読(JSON Lines)にする */
  json?: boolean;
}

export interface StartedMock {
  url: string;
  matcher: MockMatcher;
  close: () => Promise<void>;
}

type LogEvent =
  | { event: "request"; method: string; path: string; status: number; matched: boolean }
  | { event: "warning"; message: string };

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 受信ボディは使わないが、読み捨てないと keep-alive 接続が詰まるため消費する */
function drain(req: IncomingMessage): void {
  req.resume();
}

function writeJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extra: Record<string, string>,
): void {
  const body = Buffer.from(JSON.stringify(payload), "utf-8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.byteLength),
    ...extra,
  });
  res.end(body);
}

/**
 * mock サーバーを起動する(listen 完了まで待つ)。close は進行中の接続も切って停止する。
 * カセットの読み込み失敗・空は RuntimeError(呼び出し側で exit 2 に変換)。
 */
export async function startMockServer(
  dir: string,
  options: MockCommandOptions,
  log: (event: LogEvent) => void,
): Promise<StartedMock> {
  const entries = await loadCassetteEntries(dir);
  const matcher = createMockMatcher(entries, {
    origin: options.origin,
    ignoreQuery: options.ignoreQuery,
    sequence: options.sequence,
  });
  if (matcher.routeCount === 0) {
    const scope = options.origin !== undefined ? ` for origin ${options.origin}` : "";
    throw new RuntimeError(`cassette in "${dir}" has no recorded responses${scope}`);
  }
  for (const collision of matcher.collisions) {
    log({
      event: "warning",
      message: `collision on "${collision.key}": using ${collision.winner}, ignoring ${collision.ignored.join(", ")} (use --origin to choose)`,
    });
  }

  const cors = options.cors === true;
  const delay = options.delay ?? 0;
  const corsHeaders = cors ? CORS_HEADERS : {};

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    drain(req);
    const method = (req.method ?? "GET").toUpperCase();
    const target = req.url ?? "/";
    if (delay > 0) await sleep(delay);

    // preflight(--cors 時のみ)。マッチングより前に応答する
    if (
      cors &&
      method === "OPTIONS" &&
      req.headers["access-control-request-method"] !== undefined
    ) {
      res.writeHead(204, corsHeaders);
      res.end();
      log({ event: "request", method, path: target, status: 204, matched: true });
      return;
    }

    // origin-form / absolute-form 以外(asterisk-form・authority-form など)は照合せず拒否する
    const parsedTarget = parseRequestTarget(target);
    if (method === "CONNECT" || parsedTarget === undefined) {
      const status = method === "CONNECT" ? 405 : 400;
      writeJson(
        res,
        status,
        { error: status === 405 ? "method not allowed" : "unsupported request target", method },
        corsHeaders,
      );
      log({ event: "request", method, path: target, status, matched: false });
      return;
    }

    const entry = matcher.match(method, target);
    if (entry === undefined) {
      writeJson(
        res,
        404,
        {
          error: "no recorded response",
          method,
          path: parsedTarget.path,
          closest: matcher.closestPaths(method, target),
        },
        corsHeaders,
      );
      log({ event: "request", method, path: target, status: 404, matched: false });
      return;
    }
    const response = buildMockResponse(entry, method);
    res.writeHead(response.status, { ...response.headers, ...corsHeaders });
    res.end(response.body);
    log({ event: "request", method, path: target, status: response.status, matched: true });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(`klaus mock error: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? MOCK_DEFAULT_PORT, host, () => resolve());
  });
  const address = server.address() as AddressInfo;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  const url = `http://${urlHost}:${address.port}`;

  return {
    url,
    matcher,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}

/**
 * mock コマンド本体。起動後は SIGINT/SIGTERM(またはテスト用の signal の abort)まで待機し、
 * 停止したら 0 を返す。カセットの欠落・不正・空は stderr + 2、不正な --origin は stderr + 1。
 * それ以外の例外(ポート使用中など)はそのまま投げる(呼び出し元で exit 1 に変換する契約)。
 */
export async function mockCommand(
  dir: string,
  options: MockCommandOptions,
  signal?: AbortSignal,
): Promise<number> {
  const json = options.json === true;
  const log = (event: LogEvent): void => {
    if (json) {
      process.stderr.write(`${JSON.stringify(event)}\n`);
    } else if (event.event === "warning") {
      process.stderr.write(`klaus mock: warning: ${event.message}\n`);
    } else {
      process.stderr.write(
        `${event.method} ${event.path} -> ${event.status}${event.matched ? "" : " (no recorded response)"}\n`,
      );
    }
  };

  // 不正なオプション値は commander の検証失敗と同じく exit 1(定義ファイルの内容の問題ではない)
  const originError = validateOrigin(options.origin);
  if (originError !== undefined) {
    process.stderr.write(`klaus: ${originError}\n`);
    return 1;
  }

  let started: StartedMock;
  try {
    started = await startMockServer(dir, options, log);
  } catch (error) {
    if (error instanceof RuntimeError) {
      process.stderr.write(`klaus: ${error.message}\n`);
      return 2;
    }
    if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
      throw new Error(
        `${error.message} (port is already in use; specify a different port with --port)`,
      );
    }
    throw error;
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ event: "listening", url: started.url, routes: started.matcher.routeCount, origins: started.matcher.origins })}\n`,
    );
  } else {
    const hostNote = options.host === "0.0.0.0" ? " (listening on 0.0.0.0)" : "";
    process.stdout.write(`klaus mock started: ${started.url}${hostNote}\n`);
    process.stderr.write(
      `serving ${started.matcher.routeCount} recorded route(s) from ${started.matcher.origins.join(", ")}; Press Ctrl+C to stop\n`,
    );
  }

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    if (signal?.aborted === true) stop();
    else signal?.addEventListener("abort", stop);
  });
  await started.close();
  return 0;
}

/** --origin の値を検証する。問題があればメッセージを返す */
function validateOrigin(value: string | undefined): string | undefined {
  if (value === undefined || normalizeOrigin(value) !== undefined) return undefined;
  return `invalid --origin value: "${value}" (expected e.g. http://api.example.com)`;
}

function parseIntOption(name: string, min: number, max: number): (value: string) => number {
  return (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new InvalidArgumentError(`invalid ${name} value: ${value}`);
    }
    return parsed;
  };
}

/** index.ts から呼ばれる mock コマンドの登録 */
export function registerMockCommand(program: Command): void {
  program
    .command("mock")
    .description(
      "serve responses recorded with `klaus run --record <dir>` from a local mock server",
    )
    .argument("<dir>", "cassette directory (contains cassette.jsonl)")
    .option(
      "-p, --port <n>",
      `port to listen on (0 = pick a free port)`,
      parseIntOption("--port", 0, 65535),
      MOCK_DEFAULT_PORT,
    )
    .option(
      "-H, --host <host>",
      "host to bind to (use 0.0.0.0 to allow connections from outside)",
      "127.0.0.1",
    )
    .option("--cors", "add permissive CORS headers and answer preflight requests")
    .option(
      "--delay <ms>",
      "fixed latency added to every response",
      parseIntOption("--delay", 0, 600000),
    )
    .option("--ignore-query", "match on method and path only, ignoring the query string")
    .option("--sequence", "serve repeated recordings of the same request in recorded order")
    .option(
      "--origin <url>",
      "serve only entries recorded for this origin (e.g. http://api.example.com)",
      (value) => {
        const message = validateOrigin(value);
        if (message !== undefined) throw new InvalidArgumentError(message);
        return value;
      },
    )
    .option("--json", "machine-readable startup line and request logs (JSON Lines)")
    .addHelpText(
      "after",
      "\nExit codes:\n  0  stopped by SIGINT/SIGTERM\n  1  invalid option value, port in use, other runtime failure\n  2  cassette missing, invalid, or empty (including --origin matching nothing)\n",
    )
    .action(async (dir: string, options: MockCommandOptions) => {
      try {
        process.exitCode = await mockCommand(dir, options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`klaus: unexpected error: ${message}\n`);
        process.exitCode = 1;
      }
    });
}
