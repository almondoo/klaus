/**
 * klaus localhost UI サーバーの Hono アプリ本体。
 * セキュリティミドルウェア(Host 検証・トークン認証・CSRF)→ API ルート → 静的配信、の順に構成する。
 * 契約は docs/dev/ui-design.md のセキュリティ節を参照。
 */
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { loadFlow, ParseError } from "../core/index.js";
import {
  handleGetEnvironmentDetail,
  handlePostEnvironmentCapture,
  handlePutEnvironment,
  listEnvironments,
} from "./routes/environments.js";
import { listFlows, resolveWithinCwd, summarizeStep } from "./routes/flows.js";
import { getHistoryPage } from "./routes/history.js";
import { handleSingleRequest } from "./routes/request.js";
import { handleRunRequest } from "./routes/runs.js";
import { createStaticHandler } from "./routes/static.js";
import type { FlowDetail } from "./types.js";

export interface CreateAppOptions {
  /** フロー探索・実行の基準ディレクトリ */
  cwd: string;
  /** 起動時に生成した認証トークン */
  token: string;
  /** 実際に listen しているポート番号(Host/Origin 検証に使う) */
  port: number;
  /** dist/ui の絶対パス */
  staticDir: string;
  /**
   * 実際にバインドしたホスト。既定は "127.0.0.1"。
   * ループバック(127.0.0.1 / localhost / ::1)以外を明示指定した場合は他ホストからの接続を
   * 受け付ける設定を選んだとみなし、Host/Origin 検証のホスト名部分を緩和する(ポート一致のみ確認、後述)。
   */
  host?: string;
}

/**
 * トークン比較をタイミングセーフに行う(タイミング攻撃対策)。
 * 長さが異なる場合は timingSafeEqual が例外を投げるため、その場合は即 false を返す。
 * (長さの違い自体は文字列比較でも早期に露呈しやすい情報のため、ここでの早期リターンは許容する)
 */
function timingSafeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** `key=value; key2=value2` 形式の Cookie ヘッダーを解析する */
function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) result[key] = decodeURIComponent(value);
  }
  return result;
}

export function createApp(options: CreateAppOptions): Hono {
  const { cwd, token, port, staticDir, host = "127.0.0.1" } = options;
  const app = new Hono();

  const expectedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const expectedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  // ループバック(127.0.0.1 / localhost / ::1)へのバインド時のみ、Host/Origin の
  // ホスト名部分まで厳密に照合する(未指定時の既定 127.0.0.1 もここに含まれる)。
  // --host 0.0.0.0 や LAN IP 等、ループバック以外へ明示的に公開した場合、クライアントが送る
  // Host/Origin のホスト名は接続元によって様々になり得て事前に列挙できないため、
  // ポート一致のみの確認まで緩和する(トークン認証・CSRF Cookie 検証は変更しない)。
  const isLoopbackHost = host === "127.0.0.1" || host === "localhost" || host === "::1";

  // DNS リバインディング対策: 全リクエストで Host ヘッダーを検証する(悪意あるページから
  // 想定外の Host 名で本サーバーへ誘導される攻撃を防ぐ)
  app.use("*", async (c, next) => {
    const hostHeader = c.req.header("host");
    if (!hostHeader) {
      return c.text("Forbidden: invalid Host header", 403);
    }
    const hostOk = isLoopbackHost ? expectedHosts.has(hostHeader) : hostHeader.endsWith(`:${port}`);
    if (!hostOk) {
      return c.text("Forbidden: invalid Host header", 403);
    }
    await next();
  });

  // ルートパスへの ?token= アクセスでトークンを検証し、成功時に Cookie を発行する
  app.use("/", async (c, next) => {
    const tokenParam = c.req.query("token");
    if (tokenParam && timingSafeTokenEqual(tokenParam, token)) {
      c.header("Set-Cookie", `klaus_token=${token}; Path=/; SameSite=Strict; HttpOnly`);
    }
    await next();
  });

  // 全 /api/* は X-Klaus-Token ヘッダー必須(不一致・未指定は 401)
  app.use("/api/*", async (c, next) => {
    const headerToken = c.req.header("x-klaus-token");
    if (!headerToken || !timingSafeTokenEqual(headerToken, token)) {
      return c.text("Unauthorized", 401);
    }
    await next();
  });

  // CSRF 対策: 状態変更 API(POST/PUT/DELETE)はさらに Cookie 一致を必須にし、
  // Origin ヘッダーが存在する場合は同一オリジンのみ許可する
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "DELETE") {
      const cookies = parseCookies(c.req.header("cookie") ?? "");
      if (!cookies.klaus_token || !timingSafeTokenEqual(cookies.klaus_token, token)) {
        return c.text("Forbidden: CSRF check failed (cookie)", 403);
      }
      const origin = c.req.header("origin");
      if (origin) {
        const originOk = isLoopbackHost
          ? expectedOrigins.has(origin)
          : origin.startsWith("http://") && origin.endsWith(`:${port}`);
        if (!originOk) {
          return c.text("Forbidden: CSRF check failed (origin)", 403);
        }
      }
    }
    await next();
  });

  app.get("/api/flows", async (c) => {
    const flows = await listFlows(cwd);
    return c.json(flows);
  });

  app.get("/api/flows/detail", async (c) => {
    const rawPath = c.req.query("path");
    if (!rawPath) return c.json({ error: "path is required" }, 400);

    const resolvedPath = resolveWithinCwd(cwd, rawPath);
    if (!resolvedPath) return c.text("Forbidden: path traversal detected", 403);

    try {
      const flow = await loadFlow(resolvedPath);
      const detail: FlowDetail = {
        path: rawPath,
        name: flow.name,
        env: flow.env,
        steps: flow.steps.map(summarizeStep),
      };
      return c.json(detail);
    } catch (error) {
      if (error instanceof ParseError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  app.get("/api/environments", async (c) => {
    return c.json(await listEnvironments(cwd));
  });

  app.get("/api/environments/:name", (c) =>
    handleGetEnvironmentDetail(c, cwd, c.req.param("name")),
  );

  app.put("/api/environments/:name", (c) => handlePutEnvironment(c, cwd, c.req.param("name")));

  app.post("/api/environments/:name/capture", (c) =>
    handlePostEnvironmentCapture(c, cwd, c.req.param("name")),
  );

  app.post("/api/runs", (c) => handleRunRequest(c, cwd));

  app.post("/api/request", (c) => handleSingleRequest(c, cwd));

  app.get("/api/history", async (c) => {
    const flow = c.req.query("flow");
    const limitParam = c.req.query("limit");
    const before = c.req.query("before");
    const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
    const page = await getHistoryPage(cwd, {
      flow: flow || undefined,
      limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
      before: before || undefined,
    });
    return c.json(page);
  });

  // 上記いずれにもマッチしない GET は静的配信(SPA フォールバック含む)
  app.get("*", createStaticHandler(staticDir));

  return app;
}
