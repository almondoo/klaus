import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { HistoryEntry } from "../src/core/history.js";
import { historyFilePath } from "../src/core/history.js";
import { executeFlow, runFlows } from "../src/core/runner.js";
import { flowSchema } from "../src/core/schema.js";

async function startAuthServer() {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/login" && req.method === "POST") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        if (body.password === "secret") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ token: `tok-${body.email}` }));
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid credentials" }));
        }
        return;
      }
      if (req.url === "/me" && req.method === "GET") {
        const auth = req.headers.authorization ?? "";
        const token = auth.replace("Bearer ", "");
        if (token.startsWith("tok-")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ email: token.slice("tok-".length) }));
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unauthorized" }));
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("executeFlow", () => {
  let ctx: Awaited<ReturnType<typeof startAuthServer>>;
  const tmpRoot = join(process.cwd(), "tmp");
  let cwd: string;

  beforeAll(async () => {
    ctx = await startAuthServer();
    await mkdir(tmpRoot, { recursive: true });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  });

  afterEach(async () => {
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  function buildAuthFlow() {
    return flowSchema.parse({
      name: "auth flow",
      steps: [
        {
          name: "login",
          request: {
            method: "POST",
            url: `${ctx.baseUrl}/login`,
            headers: { "Content-Type": "application/json" },
            body: { email: "user@example.com", password: "secret" },
          },
          capture: { token: "$.token" },
          assert: { status: 200, body: [{ path: "$.token", exists: true }] },
        },
        {
          name: "get-me",
          request: {
            method: "GET",
            url: `${ctx.baseUrl}/me`,
            headers: { Authorization: "Bearer {{token}}" },
          },
          assert: { status: 200, body: [{ path: "$.email", equals: "user@example.com" }] },
        },
      ],
    });
  }

  it("キャプチャした変数を後続ステップへチェーンし、全ステップ成功する", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const flow = buildAuthFlow();

    const result = await executeFlow(flow, "auth-flow.yaml", { cwd, history: false });

    expect(result.status).toBe("passed");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.status).toBe("passed");
    expect(result.steps[1]?.status).toBe("passed");
    expect(result.steps[1]?.response?.body).toEqual({ email: "user@example.com" });
  });

  it("アサーションの期待値もテンプレート展開される(equals: {{var}})", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(join(cwd, "environments", "local.yaml"), "testEmail: user@example.com\n");
    const flow = flowSchema.parse({
      name: "assert template flow",
      env: "local",
      steps: [
        {
          name: "login",
          request: {
            method: "POST",
            url: `${ctx.baseUrl}/login`,
            body: { email: "user@example.com", password: "secret" },
          },
          capture: { token: "$.token" },
        },
        {
          name: "get-me",
          request: {
            method: "GET",
            url: `${ctx.baseUrl}/me`,
            headers: { Authorization: "Bearer {{token}}" },
          },
          assert: { status: 200, body: [{ path: "$.email", equals: "{{testEmail}}" }] },
        },
      ],
    });

    const result = await executeFlow(flow, "assert-template.yaml", { cwd, history: false });

    expect(result.status).toBe("passed");
    expect(result.steps[1]?.status).toBe("passed");
  });

  it("ステップがアサーション失敗すると以降のステップは skipped になる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const flow = flowSchema.parse({
      name: "failing flow",
      steps: [
        {
          name: "login-wrong-password",
          request: {
            method: "POST",
            url: `${ctx.baseUrl}/login`,
            body: { email: "user@example.com", password: "wrong" },
          },
          assert: { status: 200 },
        },
        {
          name: "get-me",
          request: { method: "GET", url: `${ctx.baseUrl}/me` },
          assert: { status: 200 },
        },
      ],
    });

    const result = await executeFlow(flow, "failing-flow.yaml", { cwd, history: false });

    expect(result.status).toBe("failed");
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[1]?.status).toBe("skipped");
    expect(result.steps[1]?.error).toContain("skipped");
  });

  it("失敗により後続ステップが skip されると、履歴にも status: skipped のエントリが記録される(request/response 省略、assertions は空)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const flow = flowSchema.parse({
      name: "failing flow",
      steps: [
        {
          name: "login-wrong-password",
          request: {
            method: "POST",
            url: `${ctx.baseUrl}/login`,
            body: { email: "user@example.com", password: "wrong" },
          },
          assert: { status: 200 },
        },
        {
          name: "get-me",
          request: { method: "GET", url: `${ctx.baseUrl}/me` },
        },
      ],
    });

    await executeFlow(flow, "failing-flow.yaml", { cwd });

    const filePath = historyFilePath(cwd);
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const failedEntry = JSON.parse(lines[0] as string);
    expect(failedEntry.step).toBe("login-wrong-password");
    expect(failedEntry.status).toBe("failed");

    const skippedEntry = JSON.parse(lines[1] as string);
    expect(skippedEntry.step).toBe("get-me");
    expect(skippedEntry.status).toBe("skipped");
    expect(skippedEntry.request).toBeUndefined();
    expect(skippedEntry.response).toBeUndefined();
    expect(skippedEntry.assertions).toEqual([]);
  });

  it("onStepStart / onStepComplete がステップごとに正しい順序で呼ばれる(skipped も含む)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const flow = flowSchema.parse({
      name: "failing flow",
      steps: [
        {
          name: "login-wrong-password",
          request: { method: "POST", url: `${ctx.baseUrl}/login`, body: { password: "wrong" } },
          assert: { status: 200 },
        },
        { name: "get-me", request: { method: "GET", url: `${ctx.baseUrl}/me` } },
      ],
    });

    const events: string[] = [];
    await executeFlow(flow, "failing-flow.yaml", {
      cwd,
      history: false,
      onStepStart: (context) => {
        events.push(`start:${context.step}`);
      },
      onStepComplete: (context) => {
        events.push(`complete:${context.result.name}:${context.result.status}`);
      },
    });

    expect(events).toEqual([
      "start:login-wrong-password",
      "complete:login-wrong-password:failed",
      "start:get-me",
      "complete:get-me:skipped",
    ]);
  });

  it("history: true(デフォルト)で .klaus/history/*.jsonl に実行したステップ数だけ追記される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const flow = buildAuthFlow();

    await executeFlow(flow, "auth-flow.yaml", { cwd });

    const filePath = historyFilePath(cwd);
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] as string);
    expect(first.flow).toBe("auth flow");
    expect(first.step).toBe("login");
    expect(first.status).toBe("passed");
  });

  it("history に関数を渡すとカスタムシンクへ渡され、ディスクには書かれない", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const flow = buildAuthFlow();
    const captured: unknown[] = [];

    await executeFlow(flow, "auth-flow.yaml", {
      cwd,
      history: (entry) => {
        captured.push(entry);
      },
    });

    expect(captured).toHaveLength(2);
    await expect(readFile(historyFilePath(cwd), "utf-8")).rejects.toThrow();
  });

  it("history: false 実行後は .klaus/history ディレクトリが作られない", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const flow = buildAuthFlow();

    await executeFlow(flow, "auth-flow.yaml", { cwd, history: false });

    await expect(access(join(cwd, ".klaus", "history"))).rejects.toThrow();
  });

  it("キャプチャ失敗(JSONPath がマッチしない)でステップが error になり、後続ステップは skipped になる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const flow = flowSchema.parse({
      name: "capture failure flow",
      steps: [
        {
          name: "login",
          request: {
            method: "POST",
            url: `${ctx.baseUrl}/login`,
            headers: { "Content-Type": "application/json" },
            body: { email: "user@example.com", password: "secret" },
          },
          capture: { missing: "$.does.not.exist" },
        },
        {
          name: "get-me",
          request: { method: "GET", url: `${ctx.baseUrl}/me` },
        },
      ],
    });

    const result = await executeFlow(flow, "capture-failure-flow.yaml", { cwd, history: false });

    expect(result.status).toBe("error");
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("missing");
    expect(result.steps[1]?.status).toBe("skipped");
  });

  it("履歴シンクが例外を投げてもステップの status は passed のままで、onWarning が呼ばれる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const flow = flowSchema.parse({
      name: "history warning flow",
      steps: [
        {
          name: "ok",
          request: {
            method: "GET",
            url: `${ctx.baseUrl}/me`,
            headers: { Authorization: "Bearer tok-user@example.com" },
          },
          assert: { status: 200 },
        },
      ],
    });

    const warnings: string[] = [];
    const result = await executeFlow(flow, "history-warning-flow.yaml", {
      cwd,
      history: () => {
        throw new Error("boom");
      },
      onWarning: (message) => warnings.push(message),
    });

    expect(result.steps[0]?.status).toBe("passed");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("boom");
  });

  it("SSE ステップを含むフローの通し実行: events が格納され response.body は undefined、capture は無視される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));

    const sseServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('event: message\ndata: {"foo":"bar"}\n\n');
      res.end();
    });
    await new Promise<void>((resolve) => sseServer.listen(0, "127.0.0.1", resolve));
    const ssePort = (sseServer.address() as AddressInfo).port;

    try {
      const flow = flowSchema.parse({
        name: "sse flow",
        steps: [
          {
            name: "stream",
            request: {
              method: "GET",
              url: `http://127.0.0.1:${ssePort}/`,
              headers: { Accept: "text/event-stream" },
            },
            capture: { ignored: "$.foo" },
            assert: { status: 200 },
          },
          {
            name: "use-captured",
            request: {
              method: "GET",
              url: `http://127.0.0.1:${ssePort}/`,
              headers: { "X-Test": "{{ignored}}" },
            },
          },
        ],
      });

      const result = await executeFlow(flow, "sse-flow.yaml", { cwd, history: false });

      expect(result.steps[0]?.status).toBe("passed");
      expect(result.steps[0]?.events).toEqual([
        { event: "message", id: undefined, data: '{"foo":"bar"}' },
      ]);
      expect(result.steps[0]?.response?.body).toBeUndefined();
      // capture は SSE ステップでは無視されるため、後続ステップで {{ignored}} は未解決のまま error になる
      expect(result.steps[1]?.status).toBe("error");
      expect(result.steps[1]?.error).toContain("ignored");
    } finally {
      await new Promise<void>((resolve) => sseServer.close(() => resolve()));
    }
  });

  it("SSE ステップの履歴エントリには events が記録され、response.body は undefined のままになる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));

    const sseServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('event: message\ndata: {"foo":"bar"}\n\n');
      res.end();
    });
    await new Promise<void>((resolve) => sseServer.listen(0, "127.0.0.1", resolve));
    const ssePort = (sseServer.address() as AddressInfo).port;

    try {
      const flow = flowSchema.parse({
        name: "sse history flow",
        steps: [
          {
            name: "stream",
            request: {
              method: "GET",
              url: `http://127.0.0.1:${ssePort}/`,
              headers: { Accept: "text/event-stream" },
            },
            assert: { status: 200 },
          },
        ],
      });

      const captured: HistoryEntry[] = [];
      await executeFlow(flow, "sse-history-flow.yaml", {
        cwd,
        history: (entry) => {
          captured.push(entry);
        },
      });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.status).toBe("passed");
      expect(captured[0]?.events).toEqual([
        { event: "message", id: undefined, data: '{"foo":"bar"}' },
      ]);
      expect(captured[0]?.response?.body).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => sseServer.close(() => resolve()));
    }
  });

  describe("履歴のシークレットマスク", () => {
    const SECRET_KEY = "KLAUS_TEST_MASK_SECRET";
    const SHORT_KEY = "KLAUS_TEST_MASK_SHORT";
    const SECRET_VALUE = "supersecret-value-123";
    const SHORT_VALUE = "abc"; // 4文字未満 -> マスク対象外

    beforeEach(() => {
      process.env[SECRET_KEY] = SECRET_VALUE;
      process.env[SHORT_KEY] = SHORT_VALUE;
    });

    afterEach(() => {
      delete process.env[SECRET_KEY];
      delete process.env[SHORT_KEY];
    });

    /** リクエストヘッダー/ボディをそのまま JSON で返す echo サーバーと、受信ヘッダーを SSE イベントとして送り返すサーバー */
    async function startEchoAndSseServer() {
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          if (req.url === "/echo" && req.method === "POST") {
            const bodyText = Buffer.concat(chunks).toString("utf-8");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                receivedSecret: req.headers["x-secret"],
                receivedShort: req.headers["x-short"],
                body: bodyText ? JSON.parse(bodyText) : null,
              }),
            );
            return;
          }
          if (req.url === "/sse" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write(
              `event: message\ndata: ${JSON.stringify({ echoed: req.headers["x-secret"] })}\n\n`,
            );
            res.end();
            return;
          }
          res.writeHead(404);
          res.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      return { server, baseUrl: `http://127.0.0.1:${port}` };
    }

    it("{{env.X}} で解決した値は request/response/SSE events から *** にマスクされ、4文字未満の値はマスクされない。カスタムシンクにもマスク済みで渡る(一方、実行結果 (FlowResult) はライブ値のまま保持される)", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
      const { server, baseUrl } = await startEchoAndSseServer();

      try {
        const flow = flowSchema.parse({
          name: "masking flow",
          steps: [
            {
              name: "echo",
              request: {
                method: "POST",
                url: `${baseUrl}/echo`,
                headers: {
                  "X-Secret": `{{env.${SECRET_KEY}}}`,
                  "X-Short": `{{env.${SHORT_KEY}}}`,
                },
                body: { secret: `{{env.${SECRET_KEY}}}`, short: `{{env.${SHORT_KEY}}}` },
              },
              // bodyText.contains は response の生テキストに対する assert なので、
              // レスポンスに秘密情報がそのまま含まれる状況(= 実運用で起こりうる状況)を再現する
              assert: { status: 200, bodyText: { contains: `{{env.${SECRET_KEY}}}` } },
            },
            {
              name: "stream",
              request: {
                method: "GET",
                url: `${baseUrl}/sse`,
                headers: {
                  Accept: "text/event-stream",
                  "X-Secret": `{{env.${SECRET_KEY}}}`,
                },
              },
              assert: { status: 200 },
            },
          ],
        });

        const captured: HistoryEntry[] = [];
        const flowResult = await executeFlow(flow, "masking-flow.yaml", {
          cwd,
          history: (entry) => {
            captured.push(entry);
          },
        });

        expect(captured).toHaveLength(2);

        const echoEntry = captured[0];
        expect(echoEntry?.request?.headers["X-Secret"]).toBe("***");
        expect(echoEntry?.request?.headers["X-Short"]).toBe(SHORT_VALUE);
        expect(echoEntry?.request?.body).toEqual({ secret: "***", short: SHORT_VALUE });
        expect(echoEntry?.response?.body).toEqual({
          receivedSecret: "***",
          receivedShort: SHORT_VALUE,
          body: { secret: "***", short: SHORT_VALUE },
        });
        // sink 側の assertions もマスクされている(expected に秘密情報のテンプレート解決値が入るため)
        const echoSinkAssertion = echoEntry?.assertions.find((a) => a.kind === "bodyText.contains");
        expect(echoSinkAssertion?.expected).toBe("***");
        expect(echoSinkAssertion?.message).not.toContain(SECRET_VALUE);

        const sseEntry = captured[1];
        expect(sseEntry?.request?.headers["X-Secret"]).toBe("***");
        expect(sseEntry?.events?.[0]?.data).toBe(JSON.stringify({ echoed: "***" }));

        // 実行結果 (FlowResult) は履歴書き込み用にマスクした別オブジェクトとは独立しており、
        // ライブの StepResult 側は秘密情報を含んだ生の値のまま保持される
        const echoStep = flowResult.steps[0];
        expect(echoStep?.request?.headers["X-Secret"]).toBe(SECRET_VALUE);
        expect(echoStep?.request?.body).toEqual({ secret: SECRET_VALUE, short: SHORT_VALUE });
        expect(echoStep?.response?.body).toEqual({
          receivedSecret: SECRET_VALUE,
          receivedShort: SHORT_VALUE,
          body: { secret: SECRET_VALUE, short: SHORT_VALUE },
        });
        const echoLiveAssertion = echoStep?.assertions.find((a) => a.kind === "bodyText.contains");
        expect(echoLiveAssertion?.expected).toBe(SECRET_VALUE);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("assert 内の {{env.X}} で解決した値も sink エントリでは *** にマスクされ、実行結果 (FlowResult) では生の値のまま保持される", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
      const { server, baseUrl } = await startEchoAndSseServer();

      try {
        const flow = flowSchema.parse({
          name: "masking flow (assert block)",
          steps: [
            {
              name: "echo",
              request: {
                method: "POST",
                url: `${baseUrl}/echo`,
                headers: { "X-Secret": `{{env.${SECRET_KEY}}}` },
              },
              // assert 定義自体にテンプレートで秘密情報を埋め込むケース
              // (例: `headers: [{ name: X, equals: "{{env.X}}" }]` のような認証トークン検証)
              assert: {
                status: 200,
                headers: [{ name: "X-Secret-Echo-Missing", equals: `{{env.${SECRET_KEY}}}` }],
              },
            },
          ],
        });

        const captured: HistoryEntry[] = [];
        const flowResult = await executeFlow(flow, "masking-flow-assert.yaml", {
          cwd,
          history: (entry) => {
            captured.push(entry);
          },
        });

        expect(captured).toHaveLength(1);

        const sinkAssertion = captured[0]?.assertions.find((a) => a.kind === "header.equals");
        expect(sinkAssertion?.expected).toBe("***");
        expect(sinkAssertion?.message).not.toContain(SECRET_VALUE);
        expect(JSON.stringify(captured[0])).not.toContain(SECRET_VALUE);

        const liveAssertion = flowResult.steps[0]?.assertions.find(
          (a) => a.kind === "header.equals",
        );
        expect(liveAssertion?.expected).toBe(SECRET_VALUE);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("ディスクに書く既定シンク(appendHistory)にもマスク済みエントリが渡る", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
      const { server, baseUrl } = await startEchoAndSseServer();

      try {
        const flow = flowSchema.parse({
          name: "masking flow (default sink)",
          steps: [
            {
              name: "echo",
              request: {
                method: "POST",
                url: `${baseUrl}/echo`,
                headers: { "X-Secret": `{{env.${SECRET_KEY}}}` },
                body: { secret: `{{env.${SECRET_KEY}}}` },
              },
              assert: { status: 200 },
            },
          ],
        });

        // history 未指定 = 既定のファイルシンク(appendHistory)を使う
        await executeFlow(flow, "masking-flow-default.yaml", { cwd });

        const filePath = historyFilePath(cwd);
        const content = await readFile(filePath, "utf-8");
        expect(content).not.toContain(SECRET_VALUE);
        const entry = JSON.parse(content.trim());
        expect(entry.request.headers["X-Secret"]).toBe("***");
        expect(entry.response.body.receivedSecret).toBe("***");
        expect(entry.response.body.body).toEqual({ secret: "***" });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});

describe("runFlows", () => {
  let ctx: Awaited<ReturnType<typeof startAuthServer>>;
  const tmpRoot = join(process.cwd(), "tmp");
  let cwd: string;

  beforeAll(async () => {
    ctx = await startAuthServer();
    await mkdir(tmpRoot, { recursive: true });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  });

  afterEach(async () => {
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("failed のフローと error のフローが混在すると RunResult.status は error になる(error > failed 優先)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));

    // 誰も listen していない、確実に接続不能なポートを1つ確保する
    const portServer = createServer();
    await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    const closedPort = (portServer.address() as AddressInfo).port;
    await new Promise<void>((resolve) => portServer.close(() => resolve()));

    const failingFlowPath = join(cwd, "failing.yaml");
    await writeFile(
      failingFlowPath,
      `name: failing flow\nsteps:\n  - name: wrong-status\n    request:\n      method: GET\n      url: "${ctx.baseUrl}/me"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const errorFlowPath = join(cwd, "error.yaml");
    await writeFile(
      errorFlowPath,
      `name: error flow\nsteps:\n  - name: unreachable\n    request:\n      method: GET\n      url: "http://127.0.0.1:${closedPort}/"\n`,
      "utf-8",
    );

    const result = await runFlows([failingFlowPath, errorFlowPath], { cwd, history: false });

    expect(result.status).toBe("error");
    expect(result.flows[0]?.status).toBe("failed");
    expect(result.flows[1]?.status).toBe("error");
  });
});

describe("ws steps", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let cwd: string;

  beforeAll(async () => {
    await mkdir(tmpRoot, { recursive: true });
  });

  afterEach(async () => {
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  /** 受信したメッセージをそのまま送り返すエコーサーバー */
  async function startEchoWsServer() {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (socket) => {
      socket.on("message", (data) => socket.send(data.toString()));
    });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const port = (wss.address() as AddressInfo).port;
    return { wss, url: `ws://127.0.0.1:${port}` };
  }

  it("WS ステップの通し実行: wsMessages が格納され、capture は無視され、履歴に1行記録される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-ws-"));
    const { wss, url } = await startEchoWsServer();

    try {
      const flow = flowSchema.parse({
        name: "ws flow",
        steps: [
          {
            name: "echo",
            ws: { url, send: ["ping"], maxMessages: 1, maxDurationMs: 5000 },
            capture: { ignored: "$.foo" },
            assert: { messageCount: { equals: 1 } },
          },
          {
            name: "use-captured",
            request: {
              method: "GET",
              url: "http://127.0.0.1:1/unused",
              headers: { "X-Test": "{{ignored}}" },
            },
          },
        ],
      });

      const result = await executeFlow(flow, "ws-flow.yaml", { cwd });

      expect(result.steps[0]?.status).toBe("passed");
      expect(result.steps[0]?.wsMessages).toEqual([{ data: "ping" }]);
      expect(result.steps[0]?.response).toBeUndefined();
      // capture は WS ステップでは無視されるため、後続ステップで {{ignored}} は未解決のまま error になる
      expect(result.steps[1]?.status).toBe("error");
      expect(result.steps[1]?.error).toContain("ignored");

      const filePath = historyFilePath(cwd);
      const content = await readFile(filePath, "utf-8");
      const lines = content.trim().split("\n");
      // error になった use-captured ステップは historyEntry を持たないため書き込まれない
      expect(lines).toHaveLength(1);

      const entry = JSON.parse(lines[0] as string);
      expect(entry.step).toBe("echo");
      expect(entry.request.url).toBe(url);
      expect(entry.request.body).toEqual(["ping"]);
      expect(entry.response.body).toEqual(["ping"]);
      expect(entry.response.status).toBe(101);
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it("assert.messageCount / assert.messages がステップの pass/fail を左右する", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-ws-"));
    const { wss, url } = await startEchoWsServer();

    try {
      const passingFlow = flowSchema.parse({
        name: "ws assertions passing",
        steps: [
          {
            name: "echo",
            ws: { url, send: ["a", "b"], maxMessages: 2, maxDurationMs: 5000 },
            assert: {
              messageCount: { equals: 2 },
              messages: [{ index: 0, equals: "a" }, { contains: "b" }],
            },
          },
        ],
      });
      const passingResult = await executeFlow(passingFlow, "ws-assert-pass.yaml", {
        cwd,
        history: false,
      });
      expect(passingResult.steps[0]?.status).toBe("passed");

      const failingFlow = flowSchema.parse({
        name: "ws assertions failing",
        steps: [
          {
            name: "echo",
            ws: { url, send: ["a", "b"], maxMessages: 2, maxDurationMs: 5000 },
            assert: { messageCount: { equals: 5 } },
          },
        ],
      });
      const failingResult = await executeFlow(failingFlow, "ws-assert-fail.yaml", {
        cwd,
        history: false,
      });
      expect(failingResult.steps[0]?.status).toBe("failed");
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
