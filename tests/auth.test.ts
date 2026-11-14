import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dryRunFlow } from "../src/core/dry-run.js";
import type { HistoryEntry } from "../src/core/history.js";
import { executeFlow } from "../src/core/runner.js";
import { flowSchema, requestSchema } from "../src/core/schema.js";
import { closeServer, listenEphemeral } from "./support/net.js";

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}
interface TestServer {
  server: Server;
  port: number;
  baseUrl: string;
  requests: Recorded[];
}

const servers: Server[] = [];
const tmpDirs: string[] = [];

async function start(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      handler(req, res);
    });
  });
  servers.push(server);
  const { port, baseUrl } = await listenEphemeral(server);
  return { server, port, baseUrl, requests } satisfies TestServer;
}

/** 受け取った Authorization ヘッダーをそのまま返す API */
const authEcho = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
};

/** client credentials のトークンエンドポイント(発行するトークンと expires_in を指定できる) */
function tokenEndpoint(token: string, expiresIn: number | undefined = 3600) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        access_token: token,
        token_type: "bearer",
        ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
      }),
    );
  };
}

afterEach(async () => {
  for (const server of servers.splice(0)) await closeServer(server);
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env.KLAUS_AUTH_TEST_PASSWORD;
  delete process.env.KLAUS_AUTH_TEST_SECRET;
});

async function makeTmp(): Promise<string> {
  const root = join(process.cwd(), "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "auth-"));
  tmpDirs.push(dir);
  return dir;
}

const flowOf = (steps: unknown[], http?: unknown) =>
  flowSchema.parse({ name: "f", ...(http ? { http } : {}), steps });

async function run(
  flow: ReturnType<typeof flowOf>,
  options: Parameters<typeof executeFlow>[2] = {},
) {
  const entries: HistoryEntry[] = [];
  const result = await executeFlow(flow, "flow.yaml", {
    history: (entry) => {
      entries.push(entry);
    },
    ...options,
  });
  // 履歴は常にマスク済み(StepResult は CLI が出力時にマスクするため、ここでは履歴だけを見る)
  return { result, entries, text: () => JSON.stringify(entries) };
}

const get = (url: string, extra: Record<string, unknown> = {}, name = "s") => ({
  name,
  request: { method: "GET", url, ...extra },
});

describe("basic / bearer", () => {
  it("basic: Authorization を送り、パスワード・base64・ヘッダー値は結果と履歴でマスクされる", async () => {
    process.env.KLAUS_AUTH_TEST_PASSWORD = "p@ss-word/9";
    const api = await start(authEcho);
    const { result, entries, text } = await run(
      flowOf([
        get(`${api.baseUrl}/x`, {
          auth: { basic: { username: "alice", password: "{{env.KLAUS_AUTH_TEST_PASSWORD}}" } },
        }),
      ]),
    );

    const expected = `Basic ${Buffer.from("alice:p@ss-word/9").toString("base64")}`;
    expect(api.requests[0]?.headers.authorization).toBe(expected);
    expect(result.steps[0]?.status).toBe("passed");
    expect(entries[0]?.request?.headers.Authorization).toBe("Basic ***");
    const serialized = text();
    expect(serialized).not.toContain("p@ss-word/9");
    expect(serialized).not.toContain(Buffer.from("alice:p@ss-word/9").toString("base64"));
  });

  it("bearer: トークンを Bearer で送り、履歴ではマスクされる", async () => {
    process.env.KLAUS_AUTH_TEST_SECRET = "bearer-token-abcdef";
    const api = await start(authEcho);
    const { entries } = await run(
      flowOf([
        get(`${api.baseUrl}/x`, { auth: { bearer: { token: "{{env.KLAUS_AUTH_TEST_SECRET}}" } } }),
      ]),
    );
    expect(api.requests[0]?.headers.authorization).toBe("Bearer bearer-token-abcdef");
    expect(JSON.stringify(entries)).not.toContain("bearer-token-abcdef");
  });

  it("http.auth は全ステップの既定で、ステップの request.auth が優先し、auth: none で無効化できる", async () => {
    const api = await start(authEcho);
    const { result } = await run(
      flowOf(
        [
          get(`${api.baseUrl}/default`, {}, "default"),
          get(`${api.baseUrl}/step`, { auth: { bearer: { token: "step-token-1234" } } }, "step"),
          get(`${api.baseUrl}/none`, { auth: "none" }, "none"),
        ],
        { auth: { bearer: { token: "flow-token-1234" } } },
      ),
    );
    expect(result.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed"]);
    expect(api.requests.map((r) => r.headers.authorization)).toEqual([
      "Bearer flow-token-1234",
      "Bearer step-token-1234",
      undefined,
    ]);
  });

  it("設定ファイル由来の http.auth(options.http)をフローの http.auth が上書きする", async () => {
    const api = await start(authEcho);
    await run(flowOf([get(`${api.baseUrl}/a`)]), {
      http: { auth: { bearer: { token: "config-token-1234" } } },
    });
    await run(
      flowOf([get(`${api.baseUrl}/b`)], { auth: { bearer: { token: "flow-token-1234" } } }),
      {
        http: { auth: { bearer: { token: "config-token-1234" } } },
      },
    );
    expect(api.requests.map((r) => r.headers.authorization)).toEqual([
      "Bearer config-token-1234",
      "Bearer flow-token-1234",
    ]);
  });

  it("ステップが自分で Authorization ヘッダーも指定している場合はエラーにして送信しない", async () => {
    const api = await start(authEcho);
    const { result } = await run(
      flowOf([
        get(`${api.baseUrl}/x`, {
          headers: { authorization: "Bearer manual" },
          auth: { bearer: { token: "helper-token-1234" } },
        }),
      ]),
    );
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("both an Authorization header and an auth helper");
    expect(api.requests).toHaveLength(0);
  });

  it("別オリジンへのリダイレクトでは認証ヘルパーのヘッダーを落とし、落としたヘッダー名を記録する", async () => {
    const other = await start(authEcho);
    const api = await start((_req, res) => {
      res.writeHead(302, { Location: `${other.baseUrl}/landing` });
      res.end();
    });
    const { result } = await run(
      flowOf(
        [get(`${api.baseUrl}/x`, { auth: { basic: { username: "u", password: "pw-1234" } } })],
        {
          followRedirects: true,
        },
      ),
    );
    expect(api.requests[0]?.headers.authorization).toBeDefined();
    expect(other.requests[0]?.headers.authorization).toBeUndefined();
    expect(result.steps[0]?.droppedHeaders).toEqual([{ hop: 1, headers: ["Authorization"] }]);
  });
});

describe("oauth2 client credentials", () => {
  const oauth = (tokenUrl: string, extra: Record<string, unknown> = {}) => ({
    oauth2: {
      grant: "client_credentials",
      tokenUrl,
      clientId: "my-client",
      clientSecret: "{{env.KLAUS_AUTH_TEST_SECRET}}",
      ...extra,
    },
  });

  it("トークンを取得して Bearer で送り、実行単位でキャッシュし、トークンとシークレットはマスクされる", async () => {
    process.env.KLAUS_AUTH_TEST_SECRET = "client-secret-xyz987";
    const token = await start(tokenEndpoint("access-token-QWERTY"));
    const api = await start(authEcho);
    const { result, entries, text } = await run(
      flowOf([
        get(`${api.baseUrl}/1`, {
          auth: oauth(`${token.baseUrl}/token`, { scope: "read write", audience: "https://api" }),
        }),
        get(
          `${api.baseUrl}/2`,
          {
            auth: oauth(`${token.baseUrl}/token`, { scope: "read write", audience: "https://api" }),
          },
          "s2",
        ),
      ]),
    );

    expect(result.steps.map((s) => s.status)).toEqual(["passed", "passed"]);
    // トークンエンドポイントへは 1 回だけ(キャッシュ)。ボディは form-urlencoded の client_secret_post
    expect(token.requests).toHaveLength(1);
    expect(token.requests[0]?.method).toBe("POST");
    expect(token.requests[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(token.requests[0]?.body))).toEqual({
      grant_type: "client_credentials",
      client_id: "my-client",
      client_secret: "client-secret-xyz987",
      scope: "read write",
      audience: "https://api",
    });
    expect(api.requests.map((r) => r.headers.authorization)).toEqual([
      "Bearer access-token-QWERTY",
      "Bearer access-token-QWERTY",
    ]);
    expect(entries[0]?.request?.headers.Authorization).toBe("Bearer ***");
    const serialized = text();
    expect(serialized).not.toContain("access-token-QWERTY");
    expect(serialized).not.toContain("client-secret-xyz987");
  });

  it("期限が切れたら取り直す(expires_in が短ければステップごとに取得)", async () => {
    process.env.KLAUS_AUTH_TEST_SECRET = "client-secret-xyz987";
    const token = await start(tokenEndpoint("short-lived-token", 1));
    const api = await start(authEcho);
    const auth = oauth(`${token.baseUrl}/token`);
    await run(
      flowOf([get(`${api.baseUrl}/1`, { auth }, "a"), get(`${api.baseUrl}/2`, { auth }, "b")]),
    );
    expect(token.requests).toHaveLength(2);
  });

  it("送信先ホストが許可リストにない場合、トークンエンドポイントへは何も送らず拒否する(履歴に記録)", async () => {
    process.env.KLAUS_AUTH_TEST_SECRET = "client-secret-xyz987";
    const token = await start(tokenEndpoint("t"));
    const api = await start(authEcho);
    const { result, entries } = await run(
      flowOf([get(`${api.baseUrl}/x`, { auth: oauth(`${token.baseUrl}/token`) })]),
      { guard: { allowedHosts: [`127.0.0.1:${token.port}`] } },
    );
    expect(result.steps[0]?.status).toBe("error");
    expect(token.requests).toHaveLength(0);
    expect(api.requests).toHaveLength(0);
    expect(entries[0]?.status).toBe("error");
  });

  it("トークンエンドポイントのホストが許可リストにない場合も、トークン取得を拒否して API へ送らない", async () => {
    process.env.KLAUS_AUTH_TEST_SECRET = "client-secret-xyz987";
    const token = await start(tokenEndpoint("t"));
    const api = await start(authEcho);
    const { result, entries } = await run(
      flowOf([get(`${api.baseUrl}/x`, { auth: oauth(`${token.baseUrl}/token`) })]),
      { guard: { allowedHosts: [`127.0.0.1:${api.port}`] } },
    );
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("oauth2 token request refused");
    expect(result.steps[0]?.error).toContain("guard.allowedHosts");
    expect(token.requests).toHaveLength(0);
    expect(api.requests).toHaveLength(0);
    expect(entries).toHaveLength(1);
  });

  it("$protected: readonly の環境ではトークン取得(POST)も安全柵で拒否される", async () => {
    process.env.KLAUS_AUTH_TEST_SECRET = "client-secret-xyz987";
    const cwd = await makeTmp();
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(join(cwd, "environments", "stg.yaml"), "$protected: readonly\n");
    const token = await start(tokenEndpoint("t"));
    const api = await start(authEcho);
    const flow = flowSchema.parse({
      name: "f",
      env: "stg",
      steps: [get(`${api.baseUrl}/x`, { auth: oauth(`${token.baseUrl}/token`) })],
    });
    const { result } = await run(flow, { cwd });
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("oauth2 token request refused");
    expect(result.steps[0]?.error).toContain("refusing POST");
    expect(token.requests).toHaveLength(0);
  });

  it("トークン取得の失敗(401)は error になり、メッセージにシークレットを含めない", async () => {
    process.env.KLAUS_AUTH_TEST_SECRET = "client-secret-xyz987";
    const token = await start((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_client", echo: "client-secret-xyz987" }));
    });
    const api = await start(authEcho);
    const { result } = await run(
      flowOf([get(`${api.baseUrl}/x`, { auth: oauth(`${token.baseUrl}/token`) })]),
    );
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toBe(
      "oauth2 token request failed with status 401: invalid_client",
    );
    expect(api.requests).toHaveLength(0);
  });

  it("トークンエンドポイントのリダイレクトは追わない(ボディのシークレットを別の宛先へ転送しない)", async () => {
    process.env.KLAUS_AUTH_TEST_SECRET = "client-secret-xyz987";
    const sink = await start((_req, res) => res.end("sink"));
    const token = await start((_req, res) => {
      res.writeHead(307, { Location: `${sink.baseUrl}/steal` });
      res.end();
    });
    const api = await start(authEcho);
    const { result } = await run(
      flowOf([get(`${api.baseUrl}/x`, { auth: oauth(`${token.baseUrl}/token`) })], {
        followRedirects: true,
      }),
    );
    expect(result.steps[0]?.error).toContain("status 307");
    expect(sink.requests).toHaveLength(0);
  });

  it("record / replay: カセットにトークンは平文で残らず、replay はサーバーなしで通る", async () => {
    process.env.KLAUS_AUTH_TEST_SECRET = "client-secret-xyz987";
    const dir = await makeTmp();
    const token = await start(tokenEndpoint("recorded-token-ZZZ"));
    const api = await start(authEcho);
    const flow = flowOf([get(`${api.baseUrl}/x`, { auth: oauth(`${token.baseUrl}/token`) })]);
    const recorded = await run(flow, { recording: { mode: "record", dir } });
    expect(recorded.result.steps[0]?.status).toBe("passed");
    const cassette = await readFile(join(dir, "cassette.jsonl"), "utf-8");
    expect(cassette).not.toContain("recorded-token-ZZZ");
    expect(cassette.trim().split("\n")).toHaveLength(2);

    for (const server of servers.splice(0)) await closeServer(server);
    const replayed = await run(flow, { recording: { mode: "replay", dir } });
    expect(replayed.result.steps[0]?.status).toBe("passed");
  });
});

describe("dry-run", () => {
  it("トークンを取得せず、Authorization はプレースホルダー/マスク対象として表示する", async () => {
    process.env.KLAUS_AUTH_TEST_SECRET = "client-secret-xyz987";
    process.env.KLAUS_AUTH_TEST_PASSWORD = "dry-pass-5678";
    const token = await start(tokenEndpoint("never-fetched"));
    const api = await start(authEcho);
    const flow = flowOf([
      get(
        `${api.baseUrl}/oauth`,
        {
          auth: {
            oauth2: {
              grant: "client_credentials",
              tokenUrl: `${token.baseUrl}/token`,
              clientId: "c",
              clientSecret: "{{env.KLAUS_AUTH_TEST_SECRET}}",
            },
          },
        },
        "oauth",
      ),
      get(
        `${api.baseUrl}/basic`,
        { auth: { basic: { username: "alice", password: "{{env.KLAUS_AUTH_TEST_PASSWORD}}" } } },
        "basic",
      ),
      get(`${api.baseUrl}/inherited`, {}, "inherited"),
    ]);
    const secrets: string[] = [];
    const dry = await dryRunFlow(flow, "f.yaml", {
      http: { auth: { bearer: { token: "config-default-token" } } },
      onSecrets: (values) => secrets.push(...values),
    });

    expect(token.requests).toHaveLength(0);
    expect(api.requests).toHaveLength(0);
    expect(dry.steps[0]?.request?.headers.Authorization).toContain("oauth2 access token");
    expect(dry.steps[1]?.request?.headers.Authorization).toBe(
      `Basic ${Buffer.from("alice:dry-pass-5678").toString("base64")}`,
    );
    expect(dry.steps[2]?.request?.headers.Authorization).toBe("Bearer config-default-token");
    // 呼び出し元がマスクできるよう、パスワード・base64・クライアントシークレット・トークンが秘密値として渡る
    expect(secrets).toEqual(
      expect.arrayContaining([
        "dry-pass-5678",
        Buffer.from("alice:dry-pass-5678").toString("base64"),
        "client-secret-xyz987",
        "config-default-token",
      ]),
    );
  });

  it("前段の capture に依存する認証値は、base64 化せずその旨を表示する", async () => {
    const flow = flowOf([
      {
        name: "login",
        request: { method: "GET", url: "http://127.0.0.1:9/l" },
        capture: { pw: "$.pw" },
      },
      get(
        "http://127.0.0.1:9/x",
        { auth: { basic: { username: "u", password: "{{pw}}" } } },
        "use",
      ),
      get("http://127.0.0.1:9/y", { auth: { bearer: { token: "{{pw}}" } } }, "bearer"),
    ]);
    const dry = await dryRunFlow(flow, "f.yaml", {});
    expect(dry.steps[1]?.request?.headers.Authorization).toContain("depends on a variable");
    expect(dry.steps[1]?.unresolved).toEqual(["pw"]);
    expect(dry.steps[2]?.request?.headers.Authorization).toBe("Bearer {{pw}}");
  });
});

describe("スキーマ", () => {
  it("auth は none / basic / bearer / oauth2 のいずれか 1 つで、複数指定や未知の grant は拒否する", () => {
    const base = { method: "GET", url: "http://x.test/" };
    const ok = (auth: unknown) => requestSchema.safeParse({ ...base, auth }).success;
    expect(ok("none")).toBe(true);
    expect(ok({ basic: { username: "u", password: "p" } })).toBe(true);
    expect(ok({ bearer: { token: "t" } })).toBe(true);
    expect(
      ok({
        oauth2: { grant: "client_credentials", tokenUrl: "u", clientId: "c", clientSecret: "s" },
      }),
    ).toBe(true);
    expect(ok({ basic: { username: "u", password: "p" }, bearer: { token: "t" } })).toBe(false);
    expect(ok({ basic: { username: "u" } })).toBe(false);
    expect(
      ok({ oauth2: { grant: "password", tokenUrl: "u", clientId: "c", clientSecret: "s" } }),
    ).toBe(false);
    expect(ok("basic")).toBe(false);
  });
});
