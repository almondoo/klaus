import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { GuardRefusalError } from "../src/core/errors.js";
import type { HistoryEntry } from "../src/core/history.js";
import { HttpSession, mergeHttpConfig } from "../src/core/http-session.js";
import { assertSendAllowed, executeFlow, executeSingleRequest } from "../src/core/runner.js";
import type { HttpConfig } from "../src/core/schema.js";
import { configSchema, flowSchema } from "../src/core/schema.js";
import { closeServer, listenEphemeral } from "./support/net.js";
import { generateTestCert, type TestCert } from "./support/tls.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

interface TestServer {
  server: Server;
  port: number;
  baseUrl: string;
  /** 受け取ったリクエスト(メソッド・URL・ヘッダー・ボディ) */
  requests: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[];
}

const servers: { close(callback: () => void): unknown }[] = [];
const tmpDirs: string[] = [];

async function startHttp(handler: Handler): Promise<TestServer> {
  const requests: TestServer["requests"] = [];
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  servers.push(server);
  const { port, baseUrl } = await listenEphemeral(server);
  return { server, port, baseUrl, requests };
}

const certDirs: string[] = [];
afterAll(async () => {
  for (const dir of certDirs) await rm(dir, { recursive: true, force: true });
});

afterEach(async () => {
  for (const server of servers.splice(0)) await closeServer(server);
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeTmp(): Promise<string> {
  const root = join(process.cwd(), "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "http-session-"));
  tmpDirs.push(dir);
  return dir;
}

function flowOf(steps: unknown[], http?: unknown): ReturnType<typeof flowSchema.parse> {
  return flowSchema.parse({ name: "f", ...(http ? { http } : {}), steps });
}

async function run(
  flow: ReturnType<typeof flowSchema.parse>,
  options: Parameters<typeof executeFlow>[2] = {},
) {
  const entries: HistoryEntry[] = [];
  const warnings: string[] = [];
  const result = await executeFlow(flow, "flow.yaml", {
    history: (entry) => {
      entries.push(entry);
    },
    onWarning: (message) => warnings.push(message),
    ...options,
  });
  return { result, entries, warnings };
}

const get = (url: string, extra: Record<string, unknown> = {}, name = "s") => ({
  name,
  request: { method: "GET", url, ...extra },
});

describe("リダイレクト", () => {
  it("既定ではリダイレクトを追わず、3xx をそのまま最終応答にする(redirects は付かない)", async () => {
    const target = await startHttp((_req, res) => res.end("final"));
    const origin = await startHttp((_req, res) => {
      res.writeHead(302, { Location: `${target.baseUrl}/x` });
      res.end();
    });
    const { result } = await run(flowOf([get(`${origin.baseUrl}/a`)]));
    expect(result.steps[0]?.response?.status).toBe(302);
    expect(result.steps[0]?.redirects).toBeUndefined();
    expect(target.requests).toHaveLength(0);
  });

  it("followRedirects: 301/302 の POST と 303 は GET に変えてボディを落とし、307/308 は保つ", async () => {
    const target = await startHttp((_req, res) => res.end("ok"));
    const origin = await startHttp((req, res) => {
      const status = Number(req.url?.slice(1));
      res.writeHead(status, { Location: `${target.baseUrl}/t${status}` });
      res.end();
    });
    const http = { followRedirects: true };
    const post = (status: number, method = "POST") => ({
      name: `s${status}${method}`,
      request: {
        method,
        url: `${origin.baseUrl}/${status}`,
        headers: { "Content-Type": "text/plain" },
        body: "payload",
      },
    });
    const { result } = await run(
      flowOf([post(301), post(302), post(303, "PUT"), post(307), post(308)], http),
    );
    expect(result.steps.map((s) => s.status)).toEqual(Array(5).fill("passed"));
    const seen = target.requests.map((r) => [r.method, r.url, r.body, r.headers["content-type"]]);
    expect(seen).toEqual([
      ["GET", "/t301", "", undefined],
      ["GET", "/t302", "", undefined],
      ["GET", "/t303", "", undefined],
      ["POST", "/t307", "payload", "text/plain"],
      ["POST", "/t308", "payload", "text/plain"],
    ]);
  });

  it("経由した URL を結果と履歴に残し、maxRedirects を超えるとステップは error になる", async () => {
    const server = await startHttp((req, res) => {
      const n = Number(req.url?.slice(1) ?? 0);
      if (n >= 3) {
        res.end("done");
        return;
      }
      res.writeHead(302, { Location: `/${n + 1}` });
      res.end();
    });
    const ok = await run(flowOf([get(`${server.baseUrl}/0`)], { followRedirects: true }));
    expect(ok.result.steps[0]?.redirects).toEqual([
      `${server.baseUrl}/1`,
      `${server.baseUrl}/2`,
      `${server.baseUrl}/3`,
    ]);
    expect(ok.entries[0]?.redirects).toEqual(ok.result.steps[0]?.redirects);

    const tooMany = await run(
      flowOf([get(`${server.baseUrl}/0`)], { followRedirects: true, maxRedirects: 2 }),
    );
    expect(tooMany.result.steps[0]?.status).toBe("error");
    expect(tooMany.result.steps[0]?.error).toContain("too many redirects");
  });

  it("別オリジンへ移るとき Authorization / Cookie / Proxy-Authorization を落とし、同一オリジンでは保つ", async () => {
    const other = await startHttp((_req, res) => res.end("other"));
    const origin = await startHttp((req, res) => {
      if (req.url === "/same") {
        res.writeHead(302, { Location: "/landing" });
      } else {
        res.writeHead(302, { Location: `${other.baseUrl}/landing` });
      }
      res.end();
    });
    const headers = {
      Authorization: "Bearer tok-abcdef",
      Cookie: "user=cookie-abcdef",
      "Proxy-Authorization": "Basic Zm9vOmJhcg==",
      Accept: "application/json",
    };
    await run(
      flowOf(
        [
          get(`${origin.baseUrl}/same`, { headers }, "same"),
          get(`${origin.baseUrl}/cross`, { headers }, "cross"),
        ],
        { followRedirects: true },
      ),
    );
    const sameLanding = origin.requests.find((r) => r.url === "/landing");
    expect(sameLanding?.headers.authorization).toBe("Bearer tok-abcdef");
    expect(sameLanding?.headers.cookie).toBe("user=cookie-abcdef");
    const crossLanding = other.requests[0];
    expect(crossLanding?.headers.authorization).toBeUndefined();
    expect(crossLanding?.headers.cookie).toBeUndefined();
    expect(crossLanding?.headers["proxy-authorization"]).toBeUndefined();
    expect(crossLanding?.headers.accept).toBe("application/json");
  });

  it("許可リストにないホストへのリダイレクトは拒否してステップを error にし、履歴に残す(送信しない)", async () => {
    const forbidden = await startHttp((_req, res) => res.end("must not be reached"));
    const origin = await startHttp((_req, res) => {
      res.writeHead(302, {
        Location: `http://localhost:${forbidden.port}/secret?t=hop-secret-xyz`,
      });
      res.end();
    });
    const { result, entries } = await run(
      flowOf([get(`${origin.baseUrl}/a`)], { followRedirects: true }),
      { guard: { allowedHosts: [`127.0.0.1:${origin.port}`] } },
    );
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("redirect hop 1");
    expect(result.steps[0]?.error).toContain("not in guard.allowedHosts");
    expect(result.steps[0]?.error).not.toContain("hop-secret-xyz");
    expect(forbidden.requests).toHaveLength(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("error");
  });

  it("各ホップで安全柵の判定をやり直し、拒否は GuardRefusalError になる(読み取り専用の判定を含む)", async () => {
    const target = await startHttp((_req, res) => res.end("ok"));
    const origin = await startHttp((_req, res) => {
      res.writeHead(307, { Location: `${target.baseUrl}/t` });
      res.end();
    });
    const session = new HttpSession({ followRedirects: true });
    const seen: string[] = [];
    const sendOne = async (options: { method: string; url: string }) => {
      const response = await fetch(options.url, { method: options.method, redirect: "manual" });
      return { status: response.status, headers: Object.fromEntries(response.headers) };
    };
    try {
      await session.send(
        { method: "GET", url: `${origin.baseUrl}/o`, headers: {} },
        { captures: {}, env: {} },
        (method, url) => {
          seen.push(`${method} ${url}`);
        },
        (options, onResponse) =>
          sendOne(options).then((r) => {
            onResponse(r);
            return r;
          }),
        () => {},
        false,
      );
      expect(seen).toEqual([`GET ${origin.baseUrl}/o`, `GET ${target.baseUrl}/t`]);

      // 読み取り専用の保護環境: 非安全メソッドに化けるホップがあれば assertSendAllowed が拒否する
      const readonlyGuard = { readonlyEnvName: "prod" };
      expect(() =>
        assertSendAllowed(readonlyGuard, "GET", target.baseUrl, {}, false),
      ).not.toThrow();
      await expect(
        session.send(
          { method: "GET", url: `${origin.baseUrl}/o`, headers: {} },
          { captures: {}, env: {} },
          (method, url, headers) => {
            // 追従先のホップだけ、非安全メソッドとして判定させる
            assertSendAllowed(
              readonlyGuard,
              url.startsWith(target.baseUrl) ? "POST" : method,
              url,
              headers,
              false,
            );
          },
          (options, onResponse) =>
            sendOne(options).then((r) => {
              onResponse(r);
              return r;
            }),
          () => {},
          false,
        ),
      ).rejects.toMatchObject({ errorCode: "guard.readonly" });
    } finally {
      await session.close();
    }
  });

  it("追従先のホップの拒否がコードを持たないときだけ guard.redirect になる", async () => {
    const target = await startHttp((_req, res) => res.end("ok"));
    const origin = await startHttp((_req, res) => {
      res.writeHead(307, { Location: `${target.baseUrl}/t` });
      res.end();
    });
    const session = new HttpSession({ followRedirects: true });
    try {
      await expect(
        session.send(
          { method: "GET", url: `${origin.baseUrl}/o`, headers: {} },
          { captures: {}, env: {} },
          (_method, url) => {
            if (url.startsWith(target.baseUrl)) throw new GuardRefusalError("refused");
          },
          async (options, onResponse) => {
            const response = await fetch(options.url, { redirect: "manual" });
            const r = { status: response.status, headers: Object.fromEntries(response.headers) };
            onResponse(r);
            return r;
          },
          () => {},
          false,
        ),
      ).rejects.toMatchObject({ errorCode: "guard.redirect" });
    } finally {
      await session.close();
    }
  });

  it("http(s) 以外のスキームへのリダイレクトと不正な Location は拒否する", async () => {
    const origin = await startHttp((req, res) => {
      res.writeHead(302, { Location: req.url === "/ftp" ? "ftp://example.com/x" : "http://[bad" });
      res.end();
    });
    const { result } = await run(
      flowOf([get(`${origin.baseUrl}/ftp`, {}, "ftp"), get(`${origin.baseUrl}/bad`, {}, "bad")], {
        followRedirects: true,
      }),
    );
    expect(result.steps[0]?.error).toContain("unsupported scheme");
    expect(result.steps[0]?.status).toBe("error");
  });

  it("Location の無い 3xx は追わずにそのまま返す", async () => {
    const origin = await startHttp((_req, res) => {
      res.writeHead(302);
      res.end();
    });
    const { result } = await run(flowOf([get(`${origin.baseUrl}/`)], { followRedirects: true }));
    expect(result.steps[0]?.response?.status).toBe(302);
    expect(result.steps[0]?.redirects).toBeUndefined();
  });

  it("SSE ステップでもリダイレクトを追い、追従先を安全柵で判定する", async () => {
    const stream = await startHttp((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("data: hello\n\n");
    });
    const origin = await startHttp((_req, res) => {
      res.writeHead(302, { Location: `${stream.baseUrl}/stream` });
      res.end();
    });
    const sse = {
      name: "sse",
      request: {
        method: "GET",
        url: `${origin.baseUrl}/old`,
        headers: { Accept: "text/event-stream" },
      },
    };
    const ok = await run(flowOf([sse], { followRedirects: true }));
    expect(ok.result.steps[0]?.events?.[0]?.data).toBe("hello");
    expect(ok.result.steps[0]?.redirects).toEqual([`${stream.baseUrl}/stream`]);

    const refused = await run(flowOf([sse], { followRedirects: true }), {
      guard: { allowedHosts: [`127.0.0.1:${origin.port}`] },
    });
    expect(refused.result.steps[0]?.status).toBe("error");
    expect(refused.result.steps[0]?.error).toContain("redirect hop 1");
  });

  it("単発リクエスト(executeSingleRequest)も http 設定でリダイレクトを追う", async () => {
    const target = await startHttp((_req, res) => res.end("single-final"));
    const origin = await startHttp((_req, res) => {
      res.writeHead(302, { Location: `${target.baseUrl}/t` });
      res.end();
    });
    const out = await executeSingleRequest({
      request: { method: "GET", url: `${origin.baseUrl}/o` },
      history: false,
      http: { followRedirects: true },
    });
    expect(out.result.response?.body).toBe("single-final");
    expect(out.result.redirects).toEqual([`${target.baseUrl}/t`]);
  });
});

describe("リダイレクトでのヘッダーの扱い(別オリジン)", () => {
  const KEY = "KLAUS_TEST_REDIRECT_SECRET";
  afterEach(() => {
    delete process.env[KEY];
  });

  it("別オリジンへは内容交渉のヘッダーだけを転送し、それ以外の独自ヘッダーは値に関わらず落とす。同一オリジンでは全ヘッダーを保つ(落とした名前は記録)", async () => {
    process.env[KEY] = "api-key-value-98765";
    const other = await startHttp((_req, res) => res.end("other"));
    const origin = await startHttp((req, res) => {
      if (req.url === "/landing") {
        res.end("landed");
        return;
      }
      res.writeHead(307, {
        Location: req.url === "/same" ? "/landing" : `${other.baseUrl}/landing`,
      });
      res.end();
    });
    const headers = {
      "X-Api-Key": `{{env.${KEY}}}`,
      "X-Token-Wrapped": `prefix-{{env.${KEY}}}-suffix`,
      "X-Trace": "trace-123",
      "Accept-Language": "ja",
      "User-Agent": "klaus-test",
      "Content-Type": "text/plain",
    };
    const request = (path: string, name: string) => ({
      name,
      request: { method: "POST", url: `${origin.baseUrl}${path}`, headers, body: "payload" },
    });
    const { result, entries } = await run(
      flowOf([request("/same", "same"), request("/cross", "cross")], { followRedirects: true }),
    );

    const sameLanding = origin.requests.find((r) => r.url === "/landing");
    expect(sameLanding?.headers["x-api-key"]).toBe("api-key-value-98765");
    expect(sameLanding?.headers["x-token-wrapped"]).toBe("prefix-api-key-value-98765-suffix");

    const crossLanding = other.requests[0];
    expect(crossLanding?.headers["x-api-key"]).toBeUndefined();
    expect(crossLanding?.headers["x-token-wrapped"]).toBeUndefined();
    // 秘密として登録されていない独自ヘッダーも落ちる(許可リスト方式)
    expect(crossLanding?.headers["x-trace"]).toBeUndefined();
    expect(crossLanding?.headers["accept-language"]).toBe("ja");
    expect(crossLanding?.headers["user-agent"]).toBe("klaus-test");
    expect(crossLanding?.headers["content-type"]).toBe("text/plain");
    expect(crossLanding?.body).toBe("payload");

    expect(result.steps[0]?.droppedHeaders).toBeUndefined();
    expect(result.steps[1]?.droppedHeaders).toEqual([
      { hop: 1, headers: ["X-Api-Key", "X-Token-Wrapped", "X-Trace"] },
    ]);
    expect(entries[1]?.droppedHeaders).toEqual(result.steps[1]?.droppedHeaders);
    // 記録するのは名前だけで、秘密値は履歴に出ない
    expect(JSON.stringify(entries)).not.toContain("api-key-value-98765");
  });

  it("https から同じホスト・ポートの http への格下げは別オリジンとして扱い、資格情報・秘密値のヘッダーと Secure cookie を送らない", async () => {
    const session = new HttpSession({ followRedirects: true, cookies: true });
    const secrets = new Set(["downgrade-secret-123"]);
    const sent: { url: string; headers: Record<string, string> }[] = [];
    const sender = async (
      options: { url: string; headers?: Record<string, string> },
      onResponse: (r: {
        status: number;
        headers: Record<string, string>;
        setCookies?: string[];
      }) => void,
    ) => {
      sent.push({ url: options.url, headers: options.headers ?? {} });
      const response =
        sent.length === 1
          ? {
              status: 302,
              headers: { location: "http://example.test/b" },
              setCookies: ["sid=secure-cookie-value; Secure; Path=/"],
            }
          : { status: 200, headers: {} };
      onResponse(response);
      return response;
    };
    try {
      const followed = await session.send(
        {
          method: "GET",
          url: "https://example.test/a",
          headers: { "X-Key": "downgrade-secret-123", Accept: "application/json" },
        },
        { captures: {}, env: {}, secrets },
        () => {},
        sender,
        () => {},
        true,
      );
      // 同じホスト名・既定ポートでもスキームが違えば別オリジン
      expect(sent[0]?.headers.Cookie).toBeUndefined();
      expect(sent[1]?.url).toBe("http://example.test/b");
      expect(sent[1]?.headers["X-Key"]).toBeUndefined();
      expect(sent[1]?.headers.Cookie).toBeUndefined();
      expect(sent[1]?.headers.Accept).toBe("application/json");
      expect(followed.droppedHeaders).toEqual([{ hop: 1, headers: ["X-Key"] }]);
    } finally {
      await session.close();
    }
  });
});

describe("cookie jar", () => {
  const loginServer = (setCookie: string[]) =>
    startHttp((req, res) => {
      if (req.url === "/login") {
        res.writeHead(200, { "Set-Cookie": setCookie });
        res.end("in");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
    });

  it("cookies: true で Set-Cookie を次のステップに送り、既定(false)では送らない", async () => {
    const server = await loginServer(["sid=session-value-1234; Path=/"]);
    const steps = [
      get(`${server.baseUrl}/login`, {}, "login"),
      get(`${server.baseUrl}/me`, {}, "me"),
    ];
    const on = await run(flowOf(steps, { cookies: true }));
    expect(on.result.steps[1]?.response?.body).toEqual({ cookie: "sid=session-value-1234" });
    const off = await run(flowOf(steps));
    expect(off.result.steps[1]?.response?.body).toEqual({ cookie: null });
  });

  it("Set-Cookie は実行時のレスポンスでは生の値のまま、履歴では位置でマスクされる(属性は残る)", async () => {
    const server = await loginServer(["sid=session-value-1234; Path=/", "t=second-value-5678"]);
    const { result, entries } = await run(
      flowOf([get(`${server.baseUrl}/login`, {}, "login")], { cookies: true }),
    );
    expect(entries[0]?.response?.headers["set-cookie"]).toBe("sid=***; Path=/, t=***");
    expect(result.steps[0]?.response?.headers["set-cookie"]).toBe(
      "sid=session-value-1234; Path=/, t=second-value-5678",
    );
    const text = JSON.stringify(entries);
    expect(text).not.toContain("session-value-1234");
    expect(text).not.toContain("second-value-5678");
  });

  it("短い cookie 値(json / true)を秘密値にせず、無関係な出力・アサーション・ヘッダーを壊さない", async () => {
    const server = await startHttp((req, res) => {
      if (req.url === "/login") {
        res.writeHead(200, { "Set-Cookie": ["fmt=json; Path=/", "consent=true; Path=/"] });
        res.end("in");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accept: req.headers.accept ?? null, ok: true }));
    });
    const secrets: string[] = [];
    const { result, entries } = await run(
      flowOf(
        [
          get(`${server.baseUrl}/login`, {}, "login"),
          {
            name: "api",
            request: {
              method: "GET",
              url: `${server.baseUrl}/api`,
              headers: { Accept: "application/json" },
            },
            assert: {
              status: 200,
              body: [{ path: "$.accept", equals: "application/json" }],
              headers: [{ name: "content-type", contains: "json" }],
            },
          },
        ],
        { cookies: true },
      ),
      { onSecrets: (values) => secrets.push(...values) },
    );
    expect(result.steps[1]?.status).toBe("passed");
    expect(secrets).not.toContain("json");
    expect(secrets).not.toContain("true");
    expect(entries[1]?.request?.headers.Accept).toBe("application/json");
    expect(entries[1]?.response?.body).toEqual({ accept: "application/json", ok: true });
  });

  it("cookie capture で取り出した値は run 中は使え、ヘッダーに入っても履歴ではマスクされる", async () => {
    const server = await startHttp((req, res) => {
      if (req.url === "/login") {
        res.writeHead(200, { "Set-Cookie": "sid=captured-cookie-9876; Path=/" });
        res.end("in");
        return;
      }
      res.writeHead(200, { "X-Seen": req.headers["x-sid"] ?? "none" });
      res.end("ok");
    });
    const { result, entries } = await run(
      flowOf(
        [
          { ...get(`${server.baseUrl}/login`, {}, "login"), capture: { sid: { cookie: "sid" } } },
          get(`${server.baseUrl}/use`, { headers: { "X-Sid": "{{sid}}" } }, "use"),
        ],
        { cookies: true },
      ),
    );
    expect(result.steps[1]?.status).toBe("passed");
    expect(result.steps[1]?.response?.headers["x-seen"]).toBe("captured-cookie-9876");
    const text = JSON.stringify(entries);
    expect(text).not.toContain("captured-cookie-9876");
    expect(entries[1]?.request?.headers["X-Sid"]).toBe("***");
  });

  it("cookie はホストに加えてポートでも限定する(同じホストの別ポートへは送らない)", async () => {
    const a = await loginServer(["sid=port-a-value-1; Path=/"]);
    const b = await loginServer([]);
    const { result } = await run(
      flowOf(
        [
          get(`${a.baseUrl}/login`, {}, "login"),
          get(`${b.baseUrl}/me`, {}, "other-port"),
          get(`${a.baseUrl}/me`, {}, "same-port"),
        ],
        { cookies: true },
      ),
    );
    expect(result.steps[1]?.response?.body).toEqual({ cookie: null });
    expect(result.steps[2]?.response?.body).toEqual({ cookie: "sid=port-a-value-1" });
  });

  it("ホスト限定 cookie は別ホスト名(同じサーバーの localhost)には送らない", async () => {
    const server = await loginServer(["sid=host-only-value-1; Path=/"]);
    const { result } = await run(
      flowOf(
        [
          get(`${server.baseUrl}/login`, {}, "login"),
          get(`http://localhost:${server.port}/me`, {}, "other-host"),
          get(`${server.baseUrl}/me`, {}, "same-host"),
        ],
        { cookies: true },
      ),
    );
    expect(result.steps[1]?.response?.body).toEqual({ cookie: null });
    expect(result.steps[2]?.response?.body).toEqual({ cookie: "sid=host-only-value-1" });
  });

  it("http:// のレスポンスの Secure cookie は保存せず、拒否した値もマスク対象にする", async () => {
    const server = await loginServer(["sid=secure-value-12345; Secure; Path=/"]);
    const { result, entries } = await run(
      flowOf([get(`${server.baseUrl}/login`, {}, "login"), get(`${server.baseUrl}/me`, {}, "me")], {
        cookies: true,
      }),
    );
    expect(result.steps[1]?.response?.body).toEqual({ cookie: null });
    expect(JSON.stringify(entries)).not.toContain("secure-value-12345");
  });

  it("リダイレクトの各ホップで jar から cookie を付け直す(途中のホップが設定した cookie も次に送る)", async () => {
    const server = await startHttp((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/landing", "Set-Cookie": "hop=hop-cookie-value; Path=/" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
    });
    const { result } = await run(
      flowOf([get(`${server.baseUrl}/start`)], { cookies: true, followRedirects: true }),
    );
    expect(result.steps[0]?.response?.body).toEqual({ cookie: "hop=hop-cookie-value" });
  });

  it("WebSocket のハンドシェイクにも jar の cookie を付ける", async () => {
    const http = await loginServer(["sid=ws-cookie-value-1; Path=/"]);
    const cookies: (string | undefined)[] = [];
    // cookie はホスト・ポート限定のため、WebSocket も同じサーバー(同じホスト名とポート)で受ける
    const wss = new WebSocketServer({ server: http.server });
    servers.push(wss);
    wss.on("connection", (socket, req) => {
      cookies.push(req.headers.cookie);
      socket.send("hi");
    });
    const wsPort = http.port;
    const { result } = await run(
      flowOf(
        [
          get(`${http.baseUrl}/login`, {}, "login"),
          { name: "ws", ws: { url: `ws://127.0.0.1:${wsPort}`, maxMessages: 1 } },
        ],
        { cookies: true },
      ),
    );
    expect(result.steps[1]?.status).toBe("passed");
    expect(cookies).toEqual(["sid=ws-cookie-value-1"]);
  });
});

describe("record / replay とリダイレクト", () => {
  it("record は各ホップを記録し、replay はサーバーなしで各ホップを再生する", async () => {
    const dir = await makeTmp();
    const target = await startHttp((_req, res) => res.end("recorded-final"));
    const origin = await startHttp((_req, res) => {
      res.writeHead(302, { Location: `${target.baseUrl}/t` });
      res.end();
    });
    const flow = flowOf([get(`${origin.baseUrl}/o`)], { followRedirects: true });
    await run(flow, { recording: { mode: "record", dir } });
    const lines = (await readFile(join(dir, "cassette.jsonl"), "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(2);

    await closeServer(origin.server);
    await closeServer(target.server);
    servers.length = 0;
    const replayed = await run(flow, { recording: { mode: "replay", dir } });
    expect(replayed.result.steps[0]?.response?.body).toBe("recorded-final");
    expect(replayed.result.steps[0]?.redirects).toEqual([`${target.baseUrl}/t`]);
  });
});

describe("プロキシ(設定ファイル由来の http.proxy のみ)", () => {
  interface ProxyFixture {
    server: Server;
    port: number;
    url: string;
    forwarded: {
      url: string;
      proxyAuthorization: string | undefined;
      headers: IncomingMessage["headers"];
    }[];
    connects: string[];
  }

  /** 平文の転送(絶対形式のリクエスト行)と CONNECT トンネルの両方を受ける簡易プロキシ */
  async function startProxy(): Promise<ProxyFixture> {
    const forwarded: ProxyFixture["forwarded"] = [];
    const connects: string[] = [];
    const server = createHttpServer((req, res) => {
      forwarded.push({
        url: req.url ?? "",
        proxyAuthorization: req.headers["proxy-authorization"] as string | undefined,
        headers: req.headers,
      });
      res.end("via-proxy");
    });
    server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
      connects.push(req.url ?? "");
      const [host, port] = (req.url ?? "").split(":");
      const upstream = netConnect(Number(port), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    });
    servers.push(server);
    const { port, baseUrl } = await listenEphemeral(server);
    return { server, port, url: baseUrl, forwarded, connects };
  }

  it("平文 HTTP は proxy 経由で送られ、許可リストは proxy ではなく最終的な宛先に対して判定する", async () => {
    const proxy = await startProxy();
    const target = await startHttp((_req, res) => res.end("direct"));
    const flow = flowOf([get(`${target.baseUrl}/p`)]);
    const { result } = await run(flow, {
      http: { proxy: proxy.url },
      guard: { allowedHosts: [`127.0.0.1:${target.port}`] },
    });
    expect(result.steps[0]?.response?.body).toBe("via-proxy");
    expect(proxy.forwarded[0]?.url).toBe(`${target.baseUrl}/p`);
    expect(target.requests).toHaveLength(0);
  });

  it("平文 HTTP: 許可リストにない宛先は proxy に何も送らず拒否する(proxy 自身が許可されていても)", async () => {
    const proxy = await startProxy();
    const target = await startHttp((_req, res) => res.end("direct"));
    const { result } = await run(flowOf([get(`${target.baseUrl}/p`)]), {
      http: { proxy: proxy.url },
      guard: { allowedHosts: [`127.0.0.1:${proxy.port}`] },
    });
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("not in guard.allowedHosts");
    expect(proxy.forwarded).toHaveLength(0);
  });

  describe("CONNECT トンネル(https の宛先)", () => {
    let cert: TestCert;
    beforeAll(async () => {
      cert = await generateTestCert();
      certDirs.push(cert.dir);
    });

    async function startHttps(handler: Handler) {
      const server = createHttpsServer({ key: cert.key, cert: cert.cert }, (req, res) => {
        handler(req, res, "");
      });
      servers.push(server);
      const { port } = await listenEphemeral(server);
      return { server, port, baseUrl: `https://127.0.0.1:${port}` };
    }

    it("許可された宛先には CONNECT で到達し、許可リストにない宛先は CONNECT を張る前に拒否する", async () => {
      const proxy = await startProxy();
      const target = await startHttps((_req, res) => res.end("tunnel-ok"));
      const http: HttpConfig = { proxy: proxy.url, tls: { ca: cert.certPath } };

      const allowed = await run(flowOf([get(`${target.baseUrl}/`)]), {
        http,
        guard: { allowedHosts: [`127.0.0.1:${target.port}`] },
      });
      expect(allowed.result.steps[0]?.response?.body).toBe("tunnel-ok");
      expect(proxy.connects).toEqual([`127.0.0.1:${target.port}`]);

      proxy.connects.length = 0;
      const refused = await run(flowOf([get(`${target.baseUrl}/`)]), {
        http,
        guard: { allowedHosts: [`127.0.0.1:${proxy.port}`] },
      });
      expect(refused.result.steps[0]?.status).toBe("error");
      expect(proxy.connects).toHaveLength(0);
    });
  });

  it("認証情報つきの proxy URL は Basic として送られ、userinfo と派生値は出力のどこにも出ない", async () => {
    const proxy = await startProxy();
    const target = await startHttp((_req, res) => res.end("direct"));
    const proxyUrl = `http://proxy-user:p%40ss-word-9@127.0.0.1:${proxy.port}`;
    const { result, entries } = await run(flowOf([get(`${target.baseUrl}/p`)]), {
      http: { proxy: proxyUrl },
    });
    const expected = `Basic ${Buffer.from("proxy-user:p@ss-word-9").toString("base64")}`;
    expect(proxy.forwarded[0]?.proxyAuthorization).toBe(expected);
    const secrets: string[] = [];
    await run(flowOf([get(`${target.baseUrl}/p`)]), {
      http: { proxy: proxyUrl },
      onSecrets: (values) => secrets.push(...values),
    });
    // パスワードとその派生値は秘密値として登録する。ユーザー名は秘密値にしない(表示してよい)
    expect(secrets).toEqual(expect.arrayContaining(["p@ss-word-9", "p%40ss-word-9"]));
    expect(secrets).not.toContain("proxy-user");
    const text = JSON.stringify({ result, entries });
    expect(text).not.toContain("p@ss-word-9");
    expect(text).not.toContain("p%40ss-word-9");
  });

  it("proxy 設定時、フローが付けた Proxy-Authorization ヘッダーは破棄する", async () => {
    const proxy = await startProxy();
    const target = await startHttp((_req, res) => res.end("direct"));
    await run(
      flowOf([
        get(`${target.baseUrl}/p`, { headers: { "Proxy-Authorization": "Basic Zm9vOmJhcg==" } }),
      ]),
      { http: { proxy: proxy.url } },
    );
    expect(proxy.forwarded[0]?.proxyAuthorization).toBeUndefined();
  });

  it("proxy のテンプレートで使えるのは {{env.X}} だけで、フローの変数・capture は参照できない", async () => {
    const proxy = await startProxy();
    const target = await startHttp((_req, res) => res.end("direct"));
    process.env.KLAUS_TEST_PROXY_URL = proxy.url;
    try {
      const viaEnv = await run(flowOf([get(`${target.baseUrl}/p`)]), {
        http: { proxy: "{{env.KLAUS_TEST_PROXY_URL}}" },
      });
      expect(viaEnv.result.steps[0]?.response?.body).toBe("via-proxy");
    } finally {
      delete process.env.KLAUS_TEST_PROXY_URL;
    }
    // フローの環境変数(--var)にあっても展開できない = フロー側から proxy を差し込めない
    const viaVar = await run(flowOf([get(`${target.baseUrl}/p`)]), {
      http: { proxy: "{{flowProxy}}" },
      variables: { flowProxy: proxy.url },
    });
    expect(viaVar.result.steps[0]?.status).toBe("error");
    expect(proxy.forwarded.filter((f) => f.url.includes("/p"))).toHaveLength(1);
  });

  it("グローバル dispatcher が環境変数の proxy を読む設定でも、設定ファイルに proxy が無ければ使わない", async () => {
    const proxy = await startProxy();
    const target = await startHttp((_req, res) => res.end("direct"));
    const original = getGlobalDispatcher();
    setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy: proxy.url }));
    try {
      const { result } = await run(flowOf([get(`${target.baseUrl}/p`)]));
      expect(result.steps[0]?.response?.body).toBe("direct");
      expect(proxy.forwarded).toHaveLength(0);
    } finally {
      setGlobalDispatcher(original);
    }
  });

  it("flow の http に proxy / tls を書くと検証エラーになり、config 側で指定するよう案内する", () => {
    const proxyResult = flowSchema.safeParse({
      name: "f",
      http: { proxy: "http://evil.example:3128" },
      steps: [get("http://x.test/")],
    });
    expect(proxyResult.success).toBe(false);
    expect(JSON.stringify(proxyResult.error?.issues)).toContain("klaus.config.yaml");
    for (const tls of [{ insecure: true }, { ca: "ca.pem" }, { cert: "c", key: "k" }]) {
      const result = flowSchema.safeParse({
        name: "f",
        http: { tls },
        steps: [get("http://x.test/")],
      });
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain("klaus.config.yaml");
    }
    expect(
      flowSchema.safeParse({
        name: "f",
        http: { followRedirects: true, maxRedirects: 3, cookies: true },
        steps: [get("http://x.test/")],
      }).success,
    ).toBe(true);
  });
});

describe("TLS(設定ファイル由来の http.tls のみ)", () => {
  let cert: TestCert;
  beforeAll(async () => {
    cert = await generateTestCert();
    certDirs.push(cert.dir);
  });

  async function startHttps(handler: Handler, options: Record<string, unknown> = {}) {
    const server = createHttpsServer({ key: cert.key, cert: cert.cert, ...options }, (req, res) =>
      handler(req, res, ""),
    );
    servers.push(server);
    const { port } = await listenEphemeral(server);
    return { server, port, baseUrl: `https://127.0.0.1:${port}` };
  }

  it("既定では自己署名証明書を拒否し、tls.ca で信頼すると通る", async () => {
    const server = await startHttps((_req, res) => res.end("secure"));
    const flow = flowOf([get(`${server.baseUrl}/`)]);
    const rejected = await run(flow);
    expect(rejected.result.steps[0]?.status).toBe("error");
    const trusted = await run(flow, { http: { tls: { ca: cert.certPath } } });
    expect(trusted.result.steps[0]?.response?.body).toBe("secure");
  });

  it("tls.insecure: true は検証を無効にし、警告を通知する(onWarning)", async () => {
    const server = await startHttps((_req, res) => res.end("secure"));
    const { result, warnings } = await run(flowOf([get(`${server.baseUrl}/`)]), {
      http: { tls: { insecure: true } },
    });
    expect(result.steps[0]?.response?.body).toBe("secure");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("insecure");
    const none = await run(flowOf([get(`${server.baseUrl}/`)]), {
      http: { tls: { ca: cert.certPath } },
    });
    expect(none.warnings).toEqual([]);
  });

  it("クライアント証明書(mTLS)を提示し、鍵の内容は結果にも履歴にも出ない", async () => {
    const server = await startHttps(
      (req, res) => {
        const socket = req.socket as unknown as { authorized: boolean };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ authorized: socket.authorized }));
      },
      { requestCert: true, rejectUnauthorized: false, ca: [cert.cert] },
    );
    const { result, entries } = await run(flowOf([get(`${server.baseUrl}/`)]), {
      http: { tls: { ca: cert.certPath, cert: cert.certPath, key: cert.keyPath } },
    });
    expect(result.steps[0]?.response?.body).toEqual({ authorized: true });
    const text = JSON.stringify({ result, entries });
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain(cert.key.split("\n")[1] as string);
  });

  it("読めない tls ファイルは、パスだけを示して鍵の中身には触れずに error になる", async () => {
    const dir = await makeTmp();
    const badKey = join(dir, "missing.pem");
    const server = await startHttps((_req, res) => res.end("x"));
    const { result } = await run(flowOf([get(`${server.baseUrl}/`)]), {
      http: { tls: { cert: cert.certPath, key: badKey } },
    });
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("http.tls.key");
    await writeFile(join(dir, "empty"), "");
  });

  it("https から http へのリダイレクトでは別オリジン扱いで Authorization を落とす", async () => {
    const plain = await startHttp((_req, res) => res.end("plain"));
    const secure = await startHttps((_req, res) => {
      res.writeHead(302, { Location: `${plain.baseUrl}/down` });
      res.end();
    });
    await run(
      flowOf(
        [get(`${secure.baseUrl}/`, { headers: { Authorization: "Bearer downgrade-token" } })],
        { followRedirects: true },
      ),
      { http: { tls: { ca: cert.certPath } } },
    );
    expect(plain.requests[0]?.headers.authorization).toBeUndefined();
  });
});

describe("設定のマージと cert/key の検証", () => {
  it("フローの http は followRedirects / maxRedirects / cookies だけを設定ファイル側に上書きし、proxy・tls は設定ファイルのまま", () => {
    const base: HttpConfig = {
      followRedirects: false,
      maxRedirects: 3,
      proxy: "http://p:1",
      tls: { insecure: true },
    };
    expect(mergeHttpConfig(base, { followRedirects: true, cookies: true })).toEqual({
      followRedirects: true,
      maxRedirects: 3,
      cookies: true,
      proxy: "http://p:1",
      tls: { insecure: true },
    });
    expect(mergeHttpConfig(base, undefined)).toBe(base);
    expect(mergeHttpConfig(undefined, { cookies: true })).toEqual({ cookies: true });
  });

  it("config の http は proxy / tls を受け付け、cert と key は両方必要", () => {
    expect(
      configSchema.safeParse({
        http: { proxy: "http://p:1", tls: { ca: "ca.pem", insecure: false } },
      }).success,
    ).toBe(true);
    expect(configSchema.safeParse({ http: { tls: { cert: "c.pem" } } }).success).toBe(false);
    expect(configSchema.safeParse({ http: { tls: { key: "k.pem" } } }).success).toBe(false);
    expect(configSchema.safeParse({ http: { unknown: true } }).success).toBe(false);
  });
});
