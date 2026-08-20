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
import { closeServer, listenEphemeral, reserveClosedPort } from "./support/net.js";

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

  const { baseUrl } = await listenEphemeral(server);
  return { server, baseUrl };
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
    await closeServer(ctx.server);
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

  it("onSecrets はステップ単位で発火し、そのステップの onStepComplete より前に新規解決した secrets を通知する(同じ値は重複通知しない)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const SECRET_KEY = "KLAUS_TEST_ONSECRETS_TIMING";
    const SECRET_VALUE = "onsecrets-timing-value-999";
    process.env[SECRET_KEY] = SECRET_VALUE;
    try {
      const flow = flowSchema.parse({
        name: "onSecrets timing flow",
        steps: [
          {
            name: "step1",
            request: {
              method: "GET",
              url: `${ctx.baseUrl}/me`,
              headers: { Authorization: `Bearer {{env.${SECRET_KEY}}}` },
            },
          },
          {
            // step2 でも同じ secret を再度参照する(重複通知が起きないことを確認する)
            name: "step2",
            request: {
              method: "GET",
              url: `${ctx.baseUrl}/me`,
              headers: { Authorization: `Bearer {{env.${SECRET_KEY}}}` },
            },
          },
        ],
      });

      const events: string[] = [];
      const secretsCalls: string[][] = [];
      await executeFlow(flow, "onsecrets-timing-flow.yaml", {
        cwd,
        history: false,
        onStepComplete: (context) => {
          events.push(`complete:${context.result.name}`);
        },
        onSecrets: (secrets) => {
          secretsCalls.push([...secrets]);
          events.push(`secrets:${secrets.join(",")}`);
        },
      });

      // step1 が解決した secret の通知は、step1 の onStepComplete より前に届く
      // (フロー完了後の一括通知ではなく、ステップ単位で即時発火することの検証)
      expect(events).toEqual([`secrets:${SECRET_VALUE}`, "complete:step1", "complete:step2"]);
      // step2 で同じ値が再解決されても、既に通知済みのため再通知はしない
      expect(secretsCalls).toEqual([[SECRET_VALUE]]);
    } finally {
      delete process.env[SECRET_KEY];
    }
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

  it("キャプチャ失敗(JSONPath の構文自体が不正で評価が例外を投げる)でステップが error になる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const flow = flowSchema.parse({
      name: "capture syntax error flow",
      steps: [
        {
          name: "login",
          request: {
            method: "POST",
            url: `${ctx.baseUrl}/login`,
            headers: { "Content-Type": "application/json" },
            body: { email: "user@example.com", password: "secret" },
          },
          // 閉じ括弧が無い不正な JSONPath 式(マッチなしではなく評価自体が例外を投げるケース)
          capture: { broken: "$[?(unterminated" },
        },
      ],
    });

    const result = await executeFlow(flow, "capture-syntax-error-flow.yaml", {
      cwd,
      history: false,
    });

    expect(result.status).toBe("error");
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("broken");
    expect(result.steps[0]?.error).toContain("failed to evaluate JSONPath");
  });

  it("capture はネストしたフィールド・配列インデックスの JSONPath を指定でき、後続ステップのテンプレートで使える", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));

    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: { user: { id: "u-1" } }, items: [{ id: "i-1" }] }));
    });
    const { port } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "nested capture flow",
        steps: [
          {
            name: "fetch",
            request: { method: "GET", url: `http://127.0.0.1:${port}/resource` },
            capture: { userId: "$.data.user.id", firstId: "$.items[0].id" },
            assert: { status: 200 },
          },
          {
            name: "use-captured",
            request: {
              method: "GET",
              url: `http://127.0.0.1:${port}/users/{{userId}}/items/{{firstId}}`,
            },
            assert: { status: 200 },
          },
        ],
      });

      const result = await executeFlow(flow, "nested-capture-flow.yaml", { cwd, history: false });

      expect(result.status).toBe("passed");
      expect(result.steps[1]?.status).toBe("passed");
      expect(result.steps[1]?.request?.url).toBe(`http://127.0.0.1:${port}/users/u-1/items/i-1`);
    } finally {
      await closeServer(server);
    }
  });

  it("request も ws も持たないステップは(schema の superRefine を bypass した場合でも)明確な RuntimeError で error になる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    // 通常は flowSchema の superRefine が「request か ws のどちらかが必須」を検証するため
    // 到達しないが、executeFlow は Flow 型を受け取るだけで実行時のスキーマ再検証はしないため、
    // プログラム的に schema を経由しない呼び出し元(スキーマ検証を bypass した不正な入力)に対する
    // 防御コードが正しく機能することを直接確認する
    const flow = flowSchema.parse({
      name: "neither request nor ws flow",
      steps: [{ name: "broken-step", request: { method: "GET", url: `${ctx.baseUrl}/me` } }],
    });
    // biome-ignore lint/suspicious/noExplicitAny: schema 検証を意図的に bypass するためのテスト専用キャスト
    (flow.steps[0] as any).request = undefined;

    const result = await executeFlow(flow, "neither-request-nor-ws-flow.yaml", {
      cwd,
      history: false,
    });

    expect(result.status).toBe("error");
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("neither request nor ws");
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

  /** SSE イベントを1件だけ送ってすぐ終了する最小限のテストサーバー(以下2つの it で共通利用) */
  async function startSseFixtureServer() {
    const sseServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write('event: message\ndata: {"foo":"bar"}\n\n');
      res.end();
    });
    const { port } = await listenEphemeral(sseServer);
    return { sseServer, ssePort: port };
  }

  it("SSE ステップを含むフローの通し実行: events が格納され response.body は undefined、capture は無視される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));

    const { sseServer, ssePort } = await startSseFixtureServer();

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
      await closeServer(sseServer);
    }
  });

  it("SSE ステップの履歴エントリには events が記録され、response.body は undefined のままになる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));

    const { sseServer, ssePort } = await startSseFixtureServer();

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
      await closeServer(sseServer);
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
      const { baseUrl } = await listenEphemeral(server);
      return { server, baseUrl };
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
        await closeServer(server);
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
        await closeServer(server);
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
        await closeServer(server);
      }
    });

    it("request.query の {{env.X}} が URL 上でパーセントエンコードされても *** にマスクされる(生形・エンコード形とも履歴に残らない)", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
      const QUERY_SECRET_KEY = "KLAUS_TEST_MASK_QUERY_SECRET";
      // + と = を含む base64 風の値。URLSearchParams.set() 経由で組むとパーセントエンコードされ、
      // 生の値のままでは maskString の単純な部分一致に失敗する(F1 の再現条件)
      const QUERY_SECRET_VALUE = "aB+cd/Ef==";
      process.env[QUERY_SECRET_KEY] = QUERY_SECRET_VALUE;

      const server = createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ url: req.url }));
      });
      const { baseUrl } = await listenEphemeral(server);

      try {
        const flow = flowSchema.parse({
          name: "masking flow (query)",
          steps: [
            {
              name: "step1",
              request: {
                method: "GET",
                url: `${baseUrl}/ok`,
                query: { token: `{{env.${QUERY_SECRET_KEY}}}` },
              },
              assert: { status: 200 },
            },
          ],
        });

        const captured: HistoryEntry[] = [];
        await executeFlow(flow, "masking-flow-query.yaml", {
          cwd,
          history: (entry) => {
            captured.push(entry);
          },
        });

        expect(captured).toHaveLength(1);
        const url = captured[0]?.request?.url ?? "";
        expect(url).toBe(`${baseUrl}/ok?token=***`);
        expect(url).not.toContain(QUERY_SECRET_VALUE);
        expect(url).not.toContain(encodeURIComponent(QUERY_SECRET_VALUE));

        // fixture がレスポンス本文にエコーした req.url(パーセントエンコード済みシークレットを含む)にも
        // url フィールドと同じ展開済みバリアントが効くことを確認する(url だけを特別扱いしていない裏付け)
        const responseBody = captured[0]?.response?.body as { url: string };
        expect(responseBody.url).toBe("/ok?token=***");
        expect(responseBody.url).not.toContain(QUERY_SECRET_VALUE);
        expect(responseBody.url).not.toContain(encodeURIComponent(QUERY_SECRET_VALUE));
      } finally {
        delete process.env[QUERY_SECRET_KEY];
        await closeServer(server);
      }
    });
  });

  describe("$protected 環境", () => {
    async function buildProtectedFlow(cwd: string) {
      await mkdir(join(cwd, "environments"), { recursive: true });
      await writeFile(join(cwd, "environments", "prod.yaml"), "$protected: true\nbaseUrl: x\n");
      return flowSchema.parse({
        name: "protected flow",
        env: "prod",
        steps: [
          {
            name: "get-me",
            request: { method: "GET", url: `${ctx.baseUrl}/me` },
          },
        ],
      });
    }

    it("allowProtected 未指定だと RuntimeError でステップ error になり、--allow-protected の案内を含む", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
      const flow = await buildProtectedFlow(cwd);

      const result = await executeFlow(flow, "protected-flow.yaml", { cwd, history: false });

      expect(result.status).toBe("error");
      expect(result.steps[0]?.status).toBe("error");
      expect(result.steps[0]?.error).toContain("prod");
      expect(result.steps[0]?.error).toContain("--allow-protected");
    });

    it("allowProtected: true を指定すると実行される", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
      const flow = await buildProtectedFlow(cwd);

      const result = await executeFlow(flow, "protected-flow.yaml", {
        cwd,
        history: false,
        allowProtected: true,
      });

      expect(result.status).toBe("passed");
      expect(result.steps[0]?.status).toBe("passed");
    });

    it("$protected の無い環境ファイルは従来どおり実行される(回帰)", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
      await mkdir(join(cwd, "environments"), { recursive: true });
      await writeFile(join(cwd, "environments", "local.yaml"), "baseUrl: x\n");
      const flow = flowSchema.parse({
        name: "unprotected flow",
        env: "local",
        steps: [{ name: "get-me", request: { method: "GET", url: `${ctx.baseUrl}/me` } }],
      });

      const result = await executeFlow(flow, "unprotected-flow.yaml", { cwd, history: false });

      expect(result.status).toBe("passed");
    });
  });
});

describe("request.query", () => {
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

  it("request.query は URL のクエリ文字列にマージされ、同名キーは query 側が優先され、値はテンプレート展開される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-query-"));
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(join(cwd, "environments", "local.yaml"), "keyword: hello world\n");

    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: req.url }));
    });
    const { port } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "query flow",
        env: "local",
        steps: [
          {
            name: "step1",
            request: {
              method: "GET",
              url: `http://127.0.0.1:${port}/search?page=1`,
              query: { page: "2", q: "{{keyword}}" },
            },
            assert: { status: 200 },
          },
        ],
      });

      const result = await executeFlow(flow, "query-flow.yaml", { cwd, history: false });

      expect(result.steps[0]?.status).toBe("passed");
      // requestSnapshot.url に query 側でマージされた結果が反映される(page は 1 -> 2 に上書き)
      const mergedUrl = new URL(result.steps[0]?.request?.url ?? "");
      expect(mergedUrl.searchParams.get("page")).toBe("2");
      expect(mergedUrl.searchParams.get("q")).toBe("hello world");

      // サーバーが実際に受信した URL にもマージ結果が反映されている
      const body = result.steps[0]?.response?.body as { url: string };
      const receivedUrl = new URL(body.url, "http://127.0.0.1");
      expect(receivedUrl.searchParams.get("page")).toBe("2");
      expect(receivedUrl.searchParams.get("q")).toBe("hello world");
    } finally {
      await closeServer(server);
    }
  });

  it("query 未指定の場合は url をそのまま使う(既存挙動に影響しない)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-query-"));

    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: req.url }));
    });
    const { port } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "no query flow",
        steps: [
          {
            name: "step1",
            request: { method: "GET", url: `http://127.0.0.1:${port}/search?page=1` },
            assert: { status: 200 },
          },
        ],
      });

      const result = await executeFlow(flow, "no-query-flow.yaml", { cwd, history: false });

      expect(result.steps[0]?.request?.url).toBe(`http://127.0.0.1:${port}/search?page=1`);
    } finally {
      await closeServer(server);
    }
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
    await closeServer(ctx.server);
  });

  afterEach(async () => {
    if (cwd) {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("failed のフローと error のフローが混在すると RunResult.status は error になる(error > failed 優先)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));

    const closedPort = await reserveClosedPort();

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
      await closeServer(wss);
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
      await closeServer(wss);
    }
  });
});

describe("step.retry", () => {
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

  it("failed が2回続いた後 3 回目で passed になる: attempts=3、後続ステップは通常通り実行される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-retry-"));
    let hitCount = 0;
    const server = createServer((req, res) => {
      if (req.url === "/flaky") {
        hitCount++;
        if (hitCount < 3) {
          res.writeHead(500);
          res.end();
          return;
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "retry flow",
        steps: [
          {
            name: "flaky-step",
            request: { method: "GET", url: `${baseUrl}/flaky` },
            assert: { status: 200 },
            retry: { count: 2, intervalMs: 0 },
          },
          {
            name: "next-step",
            request: { method: "GET", url: `${baseUrl}/ok` },
            assert: { status: 200 },
          },
        ],
      });

      const result = await executeFlow(flow, "retry-flow.yaml", { cwd, history: false });

      expect(result.status).toBe("passed");
      expect(result.steps[0]?.status).toBe("passed");
      expect(result.steps[0]?.attempts).toBe(3);
      expect(hitCount).toBe(3);
      expect(result.steps[1]?.status).toBe("passed");
    } finally {
      await closeServer(server);
    }
  });

  it("リトライ回数を使い切ると failed のまま確定し、以降のステップは skipped になる。履歴にも attempts が記録される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-retry-"));
    let hitCount = 0;
    const server = createServer((_req, res) => {
      hitCount++;
      res.writeHead(500);
      res.end();
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "retry exhausted flow",
        steps: [
          {
            name: "always-fail",
            request: { method: "GET", url: `${baseUrl}/always500` },
            assert: { status: 200 },
            retry: { count: 2, intervalMs: 0 },
          },
          {
            name: "next-step",
            request: { method: "GET", url: `${baseUrl}/ok` },
          },
        ],
      });

      const captured: HistoryEntry[] = [];
      const result = await executeFlow(flow, "retry-exhausted-flow.yaml", {
        cwd,
        history: (entry) => {
          captured.push(entry);
        },
      });

      expect(result.steps[0]?.status).toBe("failed");
      expect(result.steps[0]?.attempts).toBe(3);
      expect(hitCount).toBe(3);
      expect(result.steps[1]?.status).toBe("skipped");

      const entry = captured.find((e) => e.step === "always-fail");
      expect(entry?.attempts).toBe(3);
    } finally {
      await closeServer(server);
    }
  });

  it("error(接続不能)も再試行の対象になる: count=1 で attempts=2", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-retry-"));
    const closedPort = await reserveClosedPort();

    const flow = flowSchema.parse({
      name: "retry error flow",
      steps: [
        {
          name: "unreachable",
          request: { method: "GET", url: `http://127.0.0.1:${closedPort}/` },
          retry: { count: 1, intervalMs: 0 },
        },
      ],
    });

    const result = await executeFlow(flow, "retry-error-flow.yaml", { cwd, history: false });

    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.attempts).toBe(2);
  });

  it("retry 未指定の場合 attempts は undefined のまま(既存挙動に影響しない)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-retry-"));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "no retry flow",
        steps: [
          { name: "step1", request: { method: "GET", url: baseUrl }, assert: { status: 200 } },
        ],
      });

      const result = await executeFlow(flow, "no-retry-flow.yaml", { cwd, history: false });

      expect(result.steps[0]?.status).toBe("passed");
      expect(result.steps[0]?.attempts).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });
});

describe("step.continueOnError", () => {
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

  it("continueOnError:true のステップが failed でも後続ステップは通常通り実行される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-continue-"));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "continue on error flow",
        steps: [
          {
            name: "step1",
            request: { method: "GET", url: baseUrl },
            assert: { status: 999 },
            continueOnError: true,
          },
          {
            name: "step2",
            request: { method: "GET", url: baseUrl },
            assert: { status: 200 },
          },
        ],
      });

      const result = await executeFlow(flow, "continue-on-error-flow.yaml", {
        cwd,
        history: false,
      });

      expect(result.status).toBe("failed");
      expect(result.steps[0]?.status).toBe("failed");
      expect(result.steps[1]?.status).toBe("passed");
      expect(result.steps[1]?.error).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it("continueOnError:true のステップが error(接続不能)でも後続ステップは通常通り実行される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-continue-"));
    const closedPort = await reserveClosedPort();
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "continue on error (error outcome) flow",
        steps: [
          {
            name: "unreachable",
            request: { method: "GET", url: `http://127.0.0.1:${closedPort}/` },
            continueOnError: true,
          },
          {
            name: "step2",
            request: { method: "GET", url: baseUrl },
            assert: { status: 200 },
          },
        ],
      });

      const result = await executeFlow(flow, "continue-on-error-error-flow.yaml", {
        cwd,
        history: false,
      });

      expect(result.status).toBe("error");
      expect(result.steps[0]?.status).toBe("error");
      expect(result.steps[1]?.status).toBe("passed");
    } finally {
      await closeServer(server);
    }
  });

  it("retry と併用した場合、retry を使い切ってから continueOnError が働く(attempts=2、後続ステップは実行される)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-continue-"));
    let hitCount = 0;
    const server = createServer((req, res) => {
      if (req.url === "/always500") {
        hitCount++;
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "continue on error with retry flow",
        steps: [
          {
            name: "always-fail",
            request: { method: "GET", url: `${baseUrl}/always500` },
            assert: { status: 200 },
            retry: { count: 1, intervalMs: 0 },
            continueOnError: true,
          },
          {
            name: "next-step",
            request: { method: "GET", url: `${baseUrl}/ok` },
            assert: { status: 200 },
          },
        ],
      });

      const result = await executeFlow(flow, "continue-on-error-with-retry-flow.yaml", {
        cwd,
        history: false,
      });

      expect(result.steps[0]?.status).toBe("failed");
      expect(result.steps[0]?.attempts).toBe(2);
      expect(hitCount).toBe(2);
      expect(result.steps[1]?.status).toBe("passed");
    } finally {
      await closeServer(server);
    }
  });

  it("後続ステップが continueOnError なしで failed の場合、そのさらに後は skipped になる(混在フロー)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-continue-"));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "mixed continue on error flow",
        steps: [
          {
            name: "step1",
            request: { method: "GET", url: baseUrl },
            assert: { status: 999 },
            continueOnError: true,
          },
          {
            name: "step2",
            request: { method: "GET", url: baseUrl },
            assert: { status: 999 },
          },
          {
            name: "step3",
            request: { method: "GET", url: baseUrl },
            assert: { status: 200 },
          },
        ],
      });

      const result = await executeFlow(flow, "mixed-continue-on-error-flow.yaml", {
        cwd,
        history: false,
      });

      expect(result.steps[0]?.status).toBe("failed");
      expect(result.steps[1]?.status).toBe("failed");
      expect(result.steps[2]?.status).toBe("skipped");
    } finally {
      await closeServer(server);
    }
  });
});
