import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { HistoryEntry } from "../src/core/history.js";
import { historyFilePath } from "../src/core/history.js";
import { readAllHistoryEntries } from "../src/core/history-query.js";
import type { LoadedFlowEntry, StepCompleteContext, StepStartContext } from "../src/core/runner.js";
import { executeFlow, runFlows, runLoadedFlows } from "../src/core/runner.js";
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

    // UTC 日付をまたいでも全件を拾えるよう全履歴ファイルを読み、
    // startedAt 降順で返るため reverse して実行順(昇順)に戻す
    const entries = (await readAllHistoryEntries(cwd)).reverse();
    expect(entries).toHaveLength(2);

    const failedEntry = entries[0] as HistoryEntry;
    expect(failedEntry.step).toBe("login-wrong-password");
    expect(failedEntry.status).toBe("failed");

    const skippedEntry = entries[1] as HistoryEntry;
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

    it.each([
      ["cli", "Pass --allow-protected to run"],
      [undefined, "Pass --allow-protected to run"],
      ["ui", "klaus ui cannot override environment protection"],
      ["library", "Pass allowProtected: true"],
      ["mcp", "klaus mcp cannot override environment protection"],
    ] as const)(
      "entryPoint=%s の拒否メッセージは対応する案内を含む",
      async (entryPoint, expected) => {
        cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
        const flow = await buildProtectedFlow(cwd);

        const result = await executeFlow(flow, "protected-flow.yaml", {
          cwd,
          history: false,
          entryPoint,
        });

        expect(result.steps[0]?.error).toContain(expected);
      },
    );

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

describe("runLoadedFlows", () => {
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

  /**
   * assert 未指定のステップは、リクエストが接続レベルで成功しさえすれば(ステータスは問わず)
   * passed になる(evaluateAssertions が空配列を返し every() が true になるため)。
   * このファイルの他の describe と同様、テンプレート解決自体の検証は目的ではないため、
   * ここでは行の値を直接テンプレートに使わず単に options.dataRows の要素数だけを利用する。
   */
  function buildTrivialFlow(name: string) {
    return flowSchema.parse({
      name,
      steps: [{ name: "step", request: { method: "GET", url: `${ctx.baseUrl}/nonexistent` } }],
    });
  }

  it("警告は onWarning へ転送しつつ、重複を除いて RunResult.warnings に残す(無ければ省略)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const entries: LoadedFlowEntry[] = [
      { filePath: "flow-a.yaml", flow: buildTrivialFlow("flow a") },
    ];
    const forwarded: string[] = [];

    // 2 行 = 同じフロー・同じステップが 2 回走り、同一文言の警告が 2 回上がる
    const result = await runLoadedFlows(entries, {
      cwd,
      dataRows: [{ row: 1 }, { row: 2 }],
      history: () => {
        throw new Error("sink down");
      },
      onWarning: (message) => forwarded.push(message),
    });
    expect(forwarded).toHaveLength(2);
    expect(result.warnings).toEqual([forwarded[0]]);

    const quiet = await runLoadedFlows(entries, { cwd, history: false });
    expect(Object.hasOwn(quiet, "warnings")).toBe(false);
  });

  it("dataRows 指定時、行(外側) × フロー(内側)のイテレーション優先順で実行し、flows[].iteration が 1,1,2,2 になる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const entries: LoadedFlowEntry[] = [
      { filePath: "flow-a.yaml", flow: buildTrivialFlow("flow a") },
      { filePath: "flow-b.yaml", flow: buildTrivialFlow("flow b") },
    ];

    const result = await runLoadedFlows(entries, {
      cwd,
      history: false,
      dataRows: [{ row: 1 }, { row: 2 }],
    });

    // flowA(it1), flowB(it1), flowA(it2), flowB(it2) の順(行が外側・フローが内側)
    expect(result.flows.map((f) => f.name)).toEqual(["flow a", "flow b", "flow a", "flow b"]);
    expect(result.flows.map((f) => f.iteration)).toEqual([1, 1, 2, 2]);
    expect(result.status).toBe("passed");
  });

  it("dataRows 指定時、options.iteration が runId 共有のまま onStepStart/onStepComplete/履歴コールバックへ伝播する", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
    const entries: LoadedFlowEntry[] = [
      { filePath: "flow-a.yaml", flow: buildTrivialFlow("flow a") },
    ];

    const startContexts: StepStartContext[] = [];
    const completeContexts: StepCompleteContext[] = [];
    const historyEntries: HistoryEntry[] = [];

    const result = await runLoadedFlows(entries, {
      cwd,
      dataRows: [{ row: 1 }, { row: 2 }],
      onStepStart: (context) => {
        startContexts.push(context);
      },
      onStepComplete: (context) => {
        completeContexts.push(context);
      },
      history: (entry) => {
        historyEntries.push(entry);
      },
    });

    expect(startContexts.map((c) => c.iteration)).toEqual([1, 2]);
    expect(completeContexts.map((c) => c.iteration)).toEqual([1, 2]);
    expect(historyEntries.map((e) => e.iteration)).toEqual([1, 2]);

    // runId は runLoadedFlows が1回だけ生成し、全イテレーション・全フローの executeFlow 呼び出しで共有される
    expect(new Set(historyEntries.map((e) => e.runId)).size).toBe(1);
    expect(historyEntries[0]?.runId).toBe(result.runId);
  });

  describe("options.jobs(--jobs による並列実行)", () => {
    /**
     * requiredConcurrent 件のリクエストが同時に in-flight になるまで、全リクエストの応答を保留するゲートサーバー。
     * sleep に頼らず「実際に requiredConcurrent 件が重なった」ことを決定的に証明するための仕掛け
     * (in-flight 件数が閾値に達した瞬間にゲートを開き、以降に届いたリクエストも含め全て応答を返す)。
     */
    async function startConcurrencyGateServer(requiredConcurrent: number) {
      let inFlight = 0;
      let maxObserved = 0;
      let releaseGate: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const server = createServer((_req, res) => {
        inFlight++;
        maxObserved = Math.max(maxObserved, inFlight);
        if (inFlight >= requiredConcurrent) releaseGate?.();
        gate.then(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      const { baseUrl } = await listenEphemeral(server);
      return { server, baseUrl, getMaxObserved: () => maxObserved };
    }

    it("jobs: 3 で3フローを並列実行すると、少なくとも2ユニットが同時に in-flight になる(ゲートサーバーで検証)", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
      const gate = await startConcurrencyGateServer(2);

      try {
        const entries: LoadedFlowEntry[] = [
          {
            filePath: "gate-a.yaml",
            flow: flowSchema.parse({
              name: "gate a",
              steps: [{ name: "step", request: { method: "GET", url: `${gate.baseUrl}/gate` } }],
            }),
          },
          {
            filePath: "gate-b.yaml",
            flow: flowSchema.parse({
              name: "gate b",
              steps: [{ name: "step", request: { method: "GET", url: `${gate.baseUrl}/gate` } }],
            }),
          },
          {
            filePath: "gate-c.yaml",
            flow: flowSchema.parse({
              name: "gate c",
              steps: [{ name: "step", request: { method: "GET", url: `${gate.baseUrl}/gate` } }],
            }),
          },
        ];

        const result = await runLoadedFlows(entries, { cwd, history: false, jobs: 3 });

        expect(result.status).toBe("passed");
        expect(result.flows).toHaveLength(3);
        expect(gate.getMaxObserved()).toBeGreaterThanOrEqual(2);
      } finally {
        await closeServer(gate.server);
      }
    });

    it("jobs>1 でも RunResult.flows は完了順ではなく常に入力順を保つ(先頭フローを最も遅くする)", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));

      // /order-slow は /order-fast が2回呼ばれるまで応答を保留する(先頭ユニットが最後に完了することを保証する)
      let fastCount = 0;
      let releaseSlow: (() => void) | undefined;
      const slowGate = new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
      const completionOrder: string[] = [];
      const server = createServer((req, res) => {
        if (req.url === "/order-fast") {
          fastCount++;
          completionOrder.push("fast");
          if (fastCount >= 2) releaseSlow?.();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.url === "/order-slow") {
          slowGate.then(() => {
            completionOrder.push("slow");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });
      const { baseUrl } = await listenEphemeral(server);

      try {
        const entries: LoadedFlowEntry[] = [
          {
            filePath: "order-slow.yaml",
            flow: flowSchema.parse({
              name: "flow slow",
              steps: [{ name: "step", request: { method: "GET", url: `${baseUrl}/order-slow` } }],
            }),
          },
          {
            filePath: "order-fast-1.yaml",
            flow: flowSchema.parse({
              name: "flow fast 1",
              steps: [{ name: "step", request: { method: "GET", url: `${baseUrl}/order-fast` } }],
            }),
          },
          {
            filePath: "order-fast-2.yaml",
            flow: flowSchema.parse({
              name: "flow fast 2",
              steps: [{ name: "step", request: { method: "GET", url: `${baseUrl}/order-fast` } }],
            }),
          },
        ];

        const result = await runLoadedFlows(entries, { cwd, history: false, jobs: 3 });

        // サーバー側で観測した完了順は fast, fast, slow(先頭ユニットが最後に完了した)
        expect(completionOrder).toEqual(["fast", "fast", "slow"]);
        // にも関わらず RunResult.flows は入力順(slow, fast1, fast2)のまま
        expect(result.flows.map((f) => f.name)).toEqual([
          "flow slow",
          "flow fast 1",
          "flow fast 2",
        ]);
        expect(result.status).toBe("passed");
      } finally {
        await closeServer(server);
      }
    });

    it("--data 指定 + jobs>1 でも行(外側) × フロー(内側)のイテレーション優先順を保つ", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-runner-"));
      const entries: LoadedFlowEntry[] = [
        { filePath: "flow-a.yaml", flow: buildTrivialFlow("flow a") },
        { filePath: "flow-b.yaml", flow: buildTrivialFlow("flow b") },
      ];

      const result = await runLoadedFlows(entries, {
        cwd,
        history: false,
        dataRows: [{ row: 1 }, { row: 2 }],
        jobs: 2,
      });

      expect(result.flows.map((f) => f.name)).toEqual(["flow a", "flow b", "flow a", "flow b"]);
      expect(result.flows.map((f) => f.iteration)).toEqual([1, 1, 2, 2]);
      expect(result.status).toBe("passed");
      // runId は jobs>1 でも1回だけ生成され、全ユニットで共有される
      expect(result.runId).toBeTruthy();
    });
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

describe("step.if", () => {
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

  it("条件が true の場合、ステップは通常通り実行される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-if-"));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "if true flow",
        steps: [
          { name: "step1", request: { method: "GET", url: baseUrl }, assert: { status: 200 } },
          {
            name: "step2",
            request: { method: "GET", url: baseUrl },
            if: "steps.step1.status == 'passed'",
            assert: { status: 200 },
          },
        ],
      });

      const result = await executeFlow(flow, "if-true-flow.yaml", { cwd, history: false });

      expect(result.steps[0]?.status).toBe("passed");
      expect(result.steps[1]?.status).toBe("passed");
    } finally {
      await closeServer(server);
    }
  });

  it("条件が false の場合、リクエストを送らず skipped になる(exact message)。後続ステップは通常通り実行され、履歴にも記録される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-if-"));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "if false flow",
        steps: [
          { name: "step1", request: { method: "GET", url: baseUrl }, assert: { status: 200 } },
          {
            name: "step2",
            request: { method: "GET", url: baseUrl },
            if: "steps.step1.status == 'failed'",
            assert: { status: 200 },
          },
          { name: "step3", request: { method: "GET", url: baseUrl }, assert: { status: 200 } },
        ],
      });

      const captured: HistoryEntry[] = [];
      const result = await executeFlow(flow, "if-false-flow.yaml", {
        cwd,
        history: (entry) => {
          captured.push(entry);
        },
      });

      expect(result.steps[0]?.status).toBe("passed");
      expect(result.steps[1]?.status).toBe("skipped");
      expect(result.steps[1]?.error).toBe(
        "skipped because condition not met: steps.step1.status == 'failed'",
      );
      expect(result.steps[1]?.attempts).toBeUndefined();
      expect(result.steps[2]?.status).toBe("passed");

      const entry = captured.find((e) => e.step === "step2");
      expect(entry?.status).toBe("skipped");
    } finally {
      await closeServer(server);
    }
  });

  it("captures.<name> を条件式に使える(== の一致・!= の不一致をどちらも判定できる)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-if-"));
    const server = createServer((req, res) => {
      if (req.url === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ state: "active" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "if capture flow",
        steps: [
          {
            name: "check-status",
            request: { method: "GET", url: `${baseUrl}/status` },
            capture: { state: "$.state" },
          },
          {
            name: "when-active",
            request: { method: "GET", url: baseUrl },
            if: "captures.state == 'active'",
          },
          {
            name: "when-not-inactive",
            request: { method: "GET", url: baseUrl },
            if: "captures.state != 'inactive'",
          },
        ],
      });

      const result = await executeFlow(flow, "if-capture-flow.yaml", { cwd, history: false });

      expect(result.steps[0]?.status).toBe("passed");
      expect(result.steps[1]?.status).toBe("passed");
      expect(result.steps[2]?.status).toBe("passed");
    } finally {
      await closeServer(server);
    }
  });

  it("continueOnError で failed のまま継続した前段ステップの実ステータスを条件式が参照できる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-if-"));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "if continueOnError flow",
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
            if: "steps.step1.status == 'failed'",
          },
          {
            name: "step3",
            request: { method: "GET", url: baseUrl },
            if: "steps.step1.status == 'passed'",
          },
        ],
      });

      const result = await executeFlow(flow, "if-continue-on-error-flow.yaml", {
        cwd,
        history: false,
      });

      expect(result.steps[0]?.status).toBe("failed");
      expect(result.steps[1]?.status).toBe("passed");
      expect(result.steps[2]?.status).toBe("skipped");
    } finally {
      await closeServer(server);
    }
  });

  it("未知のステップ名を参照する条件式は error になり(利用可能なステップ名一覧つき)、後続ステップは skipped になる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-if-"));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "if unknown step flow",
        steps: [
          { name: "step1", request: { method: "GET", url: baseUrl }, assert: { status: 200 } },
          {
            name: "step2",
            request: { method: "GET", url: baseUrl },
            if: "steps.nonexistent.status == 'passed'",
          },
          { name: "step3", request: { method: "GET", url: baseUrl } },
        ],
      });

      // 条件式エラーのステップは履歴に書かれない(executeStep の catch と同じ挙動)ことも検証する
      const captured: HistoryEntry[] = [];
      const result = await executeFlow(flow, "if-unknown-step-flow.yaml", {
        cwd,
        history: (entry) => {
          captured.push(entry);
        },
      });

      expect(result.steps[0]?.status).toBe("passed");
      expect(result.steps[1]?.status).toBe("error");
      expect(result.steps[1]?.error).toMatch(
        /unknown step "nonexistent" in condition \(available steps: step1\)/,
      );
      expect(result.steps[2]?.status).toBe("skipped");
      expect(captured.find((entry) => entry.step === "step2")).toBeUndefined();
      expect(captured.find((entry) => entry.step === "step1")?.status).toBe("passed");
    } finally {
      await closeServer(server);
    }
  });

  it("文法に合わない条件式は error になる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-if-"));
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const flow = flowSchema.parse({
        name: "if malformed flow",
        steps: [
          { name: "step1", request: { method: "GET", url: baseUrl }, if: "not a valid condition" },
        ],
      });

      const result = await executeFlow(flow, "if-malformed-flow.yaml", { cwd, history: false });

      expect(result.steps[0]?.status).toBe("error");
    } finally {
      await closeServer(server);
    }
  });
});

describe("安全柵(guard.allowedHosts / $protected: readonly)と履歴の監査項目", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let cwd: string;
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let hostPort: string;
  /** fixture サーバーが実際に受信したリクエスト("METHOD /path")。拒否されたステップが送信されていないことの検証に使う */
  let received: string[];

  beforeAll(async () => {
    await mkdir(tmpRoot, { recursive: true });
  });

  beforeEach(async () => {
    received = [];
    server = createServer((req, res) => {
      received.push(`${req.method} ${req.url}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const listened = await listenEphemeral(server);
    baseUrl = listened.baseUrl;
    hostPort = `127.0.0.1:${listened.port}`;
    cwd = await mkdtemp(join(tmpRoot, "klaus-runner-guard-"));
  });

  afterEach(async () => {
    await closeServer(server);
    await rm(cwd, { recursive: true, force: true });
  });

  function singleStepFlow(request: Record<string, unknown>, env?: string) {
    return flowSchema.parse({
      name: "guard flow",
      ...(env ? { env } : {}),
      steps: [{ name: "call", request }],
    });
  }

  async function writeEnv(name: string, content: string) {
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(join(cwd, "environments", `${name}.yaml`), content, "utf-8");
  }

  describe("guard.allowedHosts", () => {
    it("許可リストに一致するホスト(ポート付き)への送信は通常どおり実行される", async () => {
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/a` });

      const result = await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        guard: { allowedHosts: [hostPort] },
      });

      expect(result.steps[0]?.status).toBe("passed");
      expect(received).toEqual(["GET /a"]);
    });

    it("許可リストに無いホストへの HTTP ステップは送信されずステップ error になる", async () => {
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/a` });

      const result = await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        guard: { allowedHosts: ["api.example.com"] },
      });

      expect(result.status).toBe("error");
      expect(result.steps[0]?.status).toBe("error");
      expect(result.steps[0]?.error).toContain('host "127.0.0.1"');
      expect(result.steps[0]?.error).toContain("guard.allowedHosts");
      expect(result.steps[0]?.errorCode).toBe("guard.allowed-hosts");
      expect(received).toEqual([]);
    });

    it("テンプレート展開後の URL で判定する(変数で組み立てたホストも拒否される)", async () => {
      const flow = singleStepFlow({ method: "GET", url: "{{TARGET}}/a" });

      const result = await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        variables: { TARGET: baseUrl },
        guard: { allowedHosts: ["api.example.com"] },
      });

      expect(result.steps[0]?.status).toBe("error");
      expect(result.steps[0]?.error).toContain("guard.allowedHosts");
      expect(received).toEqual([]);
    });

    it("request.query を含む展開後の URL でも、許可リストに無いホストは拒否される", async () => {
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/a`, query: { q: "1" } });

      const result = await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        guard: { allowedHosts: ["other.example.com"] },
      });

      expect(result.steps[0]?.status).toBe("error");
      expect(received).toEqual([]);
    });

    it("SSE ステップも送信前に判定される", async () => {
      const flow = flowSchema.parse({
        name: "sse flow",
        steps: [
          {
            name: "stream",
            request: { method: "GET", url: `${baseUrl}/events` },
            sse: { maxEvents: 1 },
          },
        ],
      });

      const result = await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        guard: { allowedHosts: ["api.example.com"] },
      });

      expect(result.steps[0]?.status).toBe("error");
      expect(result.steps[0]?.error).toContain("guard.allowedHosts");
      expect(received).toEqual([]);
    });

    it("WebSocket ステップも接続前に判定される(拒否時は接続を試みない)", async () => {
      const flow = flowSchema.parse({
        name: "ws flow",
        steps: [{ name: "socket", ws: { url: `ws://${hostPort}/ws` } }],
      });

      const result = await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        guard: { allowedHosts: ["api.example.com"] },
      });

      expect(result.steps[0]?.status).toBe("error");
      expect(result.steps[0]?.error).toContain("guard.allowedHosts");
      // 接続を試みていれば upgrade 要求が fixture に届くため、何も受信していないことで確認する
      expect(received).toEqual([]);
    });

    it("record モードでは判定される(拒否時はカセットも作られない)", async () => {
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/a` });
      const dir = join(cwd, "cassette");

      const result = await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        recording: { mode: "record", dir },
        guard: { allowedHosts: ["api.example.com"] },
      });

      expect(result.steps[0]?.status).toBe("error");
      expect(received).toEqual([]);
      await expect(access(join(dir, "cassette.jsonl"))).rejects.toThrow();
    });

    it("replay モードでは実送信がないため判定しない", async () => {
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/a` });
      const dir = join(cwd, "cassette");
      // 許可リストなしで record してカセットを作る
      await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        recording: { mode: "record", dir },
      });
      received.length = 0;

      const result = await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        recording: { mode: "replay", dir },
        guard: { allowedHosts: ["api.example.com"] },
      });

      expect(result.steps[0]?.status).toBe("passed");
      expect(received).toEqual([]);
    });

    it("guard 未指定なら従来どおり任意のホストへ送信できる(回帰)", async () => {
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/a` });

      const result = await executeFlow(flow, "f.yaml", { cwd, history: false });

      expect(result.steps[0]?.status).toBe("passed");
    });
  });

  describe("$protected: readonly", () => {
    it("GET / HEAD / OPTIONS は --allow-protected なしで送信できる", async () => {
      await writeEnv("stg", "$protected: readonly\nbaseUrl: x\n");
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        const flow = singleStepFlow({ method, url: `${baseUrl}/r` }, "stg");

        const result = await executeFlow(flow, "f.yaml", { cwd, history: false });

        expect(result.steps[0]?.status).toBe("passed");
      }
      expect(received).toEqual(["GET /r", "HEAD /r", "OPTIONS /r"]);
    });

    it("POST などの書き込み系メソッドは送信されずステップ error になり、--allow-protected の案内を含む", async () => {
      await writeEnv("stg", "$protected: readonly\nbaseUrl: x\n");
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const flow = singleStepFlow({ method, url: `${baseUrl}/w` }, "stg");

        const result = await executeFlow(flow, "f.yaml", { cwd, history: false });

        expect(result.steps[0]?.status).toBe("error");
        expect(result.steps[0]?.error).toContain('environment "stg"');
        expect(result.steps[0]?.error).toContain(`refusing ${method}`);
        expect(result.steps[0]?.error).toContain("--allow-protected");
        expect(result.steps[0]?.errorCode).toBe("guard.readonly");
      }
      expect(received).toEqual([]);
    });

    it("graphql ステップ(メソッド省略時は POST)は拒否される", async () => {
      await writeEnv("stg", "$protected: readonly\nbaseUrl: x\n");
      const flow = singleStepFlow(
        { url: `${baseUrl}/graphql`, graphql: { query: "{ me }" } },
        "stg",
      );

      const result = await executeFlow(flow, "f.yaml", { cwd, history: false });

      expect(result.steps[0]?.error).toContain("refusing POST");
      expect(received).toEqual([]);
    });

    it("WebSocket ステップは拒否される", async () => {
      await writeEnv("stg", "$protected: readonly\nbaseUrl: x\n");
      const flow = flowSchema.parse({
        name: "ws flow",
        env: "stg",
        steps: [{ name: "socket", ws: { url: `ws://${hostPort}/ws` } }],
      });

      const result = await executeFlow(flow, "f.yaml", { cwd, history: false });

      expect(result.steps[0]?.status).toBe("error");
      expect(result.steps[0]?.error).toContain("refusing WebSocket");
      expect(received).toEqual([]);
    });

    it("SSE ステップは HTTP メソッドに従う(POST の SSE は拒否される)", async () => {
      await writeEnv("stg", "$protected: readonly\nbaseUrl: x\n");
      const flow = flowSchema.parse({
        name: "sse flow",
        env: "stg",
        steps: [
          {
            name: "stream",
            request: { method: "POST", url: `${baseUrl}/events` },
            sse: { maxEvents: 1 },
          },
        ],
      });

      const result = await executeFlow(flow, "f.yaml", { cwd, history: false });

      expect(result.steps[0]?.error).toContain("refusing POST");
      expect(received).toEqual([]);
    });

    it("allowProtected: true なら書き込み系メソッドも送信できる", async () => {
      await writeEnv("stg", "$protected: readonly\nbaseUrl: x\n");
      const flow = singleStepFlow({ method: "POST", url: `${baseUrl}/w` }, "stg");

      const result = await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        allowProtected: true,
      });

      expect(result.steps[0]?.status).toBe("passed");
      expect(received).toEqual(["POST /w"]);
    });

    it("$protected: true は従来どおり GET も拒否される(回帰)", async () => {
      await writeEnv("prod", "$protected: true\nbaseUrl: x\n");
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/r` }, "prod");

      const result = await executeFlow(flow, "f.yaml", { cwd, history: false });

      expect(result.steps[0]?.status).toBe("error");
      expect(result.steps[0]?.error).toContain("($protected: true)");
      expect(result.steps[0]?.errorCode).toBe("guard.protected");
      expect(received).toEqual([]);
    });

    it("readonly でも許可リストは別途効く(安全メソッドでも許可外ホストは拒否される)", async () => {
      await writeEnv("stg", "$protected: readonly\nbaseUrl: x\n");
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/r` }, "stg");

      const result = await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        guard: { allowedHosts: ["api.example.com"] },
      });

      expect(result.steps[0]?.error).toContain("guard.allowedHosts");
      expect(received).toEqual([]);
    });
  });

  describe("履歴の監査項目", () => {
    async function runCollecting(
      flow: ReturnType<typeof singleStepFlow>,
      filePath: string,
      options: Parameters<typeof executeFlow>[2] = {},
    ): Promise<HistoryEntry[]> {
      const entries: HistoryEntry[] = [];
      await executeFlow(flow, filePath, {
        cwd,
        history: (entry) => {
          entries.push(entry);
        },
        ...options,
      });
      return entries;
    }

    it("env / file / actor / git を履歴エントリに記録する(file は cwd 相対の POSIX パス)", async () => {
      await writeEnv("local", "baseUrl: x\n");
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/a` });

      const entries = await runCollecting(flow, join(cwd, "flows", "sub", "f.yaml"), {
        envNameOverride: "local",
        actor: { kind: "agent", name: "claude-code" },
        git: { commit: "abc123", dirty: true },
      });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        env: "local",
        file: "flows/sub/f.yaml",
        actor: { kind: "agent", name: "claude-code" },
        git: { commit: "abc123", dirty: true },
      });
    });

    it("フロー定義の env を記録し、cwd 相対で渡されたパスはそのまま相対 POSIX で記録する", async () => {
      await writeEnv("local", "baseUrl: x\n");
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/a` }, "local");

      const entries = await runCollecting(flow, "flows/f.yaml");

      expect(entries[0]?.env).toBe("local");
      expect(entries[0]?.file).toBe("flows/f.yaml");
    });

    it("--env-file 指定時の env は絶対パスではなくファイル名のみを記録する", async () => {
      const envFile = join(cwd, "secrets-dir", "custom.yaml");
      await mkdir(join(cwd, "secrets-dir"), { recursive: true });
      await writeFile(envFile, "baseUrl: x\n", "utf-8");
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/a` });

      const entries = await runCollecting(flow, "f.yaml", { envFilePath: envFile });

      expect(entries[0]?.env).toBe("custom.yaml");
    });

    it("skipped ステップのエントリにも監査項目が付く", async () => {
      // 1 ステップ目がアサーション失敗になり、2 ステップ目が skipped になる
      const flow = flowSchema.parse({
        name: "skip flow",
        steps: [
          {
            name: "fails",
            request: { method: "GET", url: `${baseUrl}/a` },
            assert: { status: 500 },
          },
          { name: "never", request: { method: "GET", url: `${baseUrl}/b` } },
        ],
      });

      const entries = await runCollecting(flow, "f.yaml", { actor: { kind: "human" } });

      const skipped = entries.find((entry) => entry.step === "never");
      expect(skipped?.status).toBe("skipped");
      expect(skipped?.file).toBe("f.yaml");
      expect(skipped?.actor).toEqual({ kind: "human" });
    });

    it("env・actor・git を使わない実行では該当フィールドを書かない(後方互換)", async () => {
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/a` });

      const entries = await runCollecting(flow, "f.yaml");

      expect(entries[0]).not.toHaveProperty("env");
      expect(entries[0]).not.toHaveProperty("actor");
      expect(entries[0]).not.toHaveProperty("git");
      expect(entries[0]?.v).toBe(1);
    });

    it("履歴に記録される file が絶対パスにならない(cwd 外のパスは .. 相対になる)", async () => {
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/a` });

      const entries = await runCollecting(flow, join(cwd, "..", "outside.yaml"));

      expect(entries[0]?.file).toBe("../outside.yaml");
    });

    it("監査項目の文字列にも秘密情報のマスクが適用される", async () => {
      const KEY = "KLAUS_TEST_AUDIT_SECRET";
      process.env[KEY] = "audit-secret-value-xyz";
      try {
        const flow = singleStepFlow({
          method: "GET",
          url: `${baseUrl}/a`,
          headers: { "X-Key": `{{env.${KEY}}}` },
        });

        const entries = await runCollecting(flow, "f.yaml", {
          actor: { kind: "human", name: "audit-secret-value-xyz" },
        });

        expect(JSON.stringify(entries[0])).not.toContain("audit-secret-value-xyz");
        expect(entries[0]?.actor?.name).toBe("***");
      } finally {
        delete process.env[KEY];
      }
    });
  });

  describe("メソッド上書きヘッダー($protected: readonly)", () => {
    it.each(["X-HTTP-Method-Override", "x-http-method", "X-METHOD-OVERRIDE"])(
      "GET に %s を付けると送信されず、ヘッダー名を含むメッセージで拒否される",
      async (header) => {
        await writeEnv("stg", "$protected: readonly\nbaseUrl: x\n");
        const flow = singleStepFlow(
          { method: "GET", url: `${baseUrl}/r`, headers: { [header]: "DELETE" } },
          "stg",
        );

        const result = await executeFlow(flow, "f.yaml", { cwd, history: false });

        expect(result.steps[0]?.status).toBe("error");
        expect(result.steps[0]?.error).toContain(header.toLowerCase());
        expect(result.steps[0]?.error).toContain("--allow-protected");
        expect(result.steps[0]?.errorCode).toBe("guard.method-override");
        expect(received).toEqual([]);
      },
    );

    it("allowProtected: true ならメソッド上書きヘッダー付きでも送信できる", async () => {
      await writeEnv("stg", "$protected: readonly\nbaseUrl: x\n");
      const flow = singleStepFlow(
        { method: "GET", url: `${baseUrl}/r`, headers: { "X-HTTP-Method-Override": "DELETE" } },
        "stg",
      );

      const result = await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        allowProtected: true,
      });

      expect(result.steps[0]?.status).toBe("passed");
    });

    it("保護環境でない場合はメソッド上書きヘッダーを拒否しない(回帰)", async () => {
      const flow = singleStepFlow({
        method: "GET",
        url: `${baseUrl}/r`,
        headers: { "X-HTTP-Method-Override": "DELETE" },
      });

      const result = await executeFlow(flow, "f.yaml", { cwd, history: false });

      expect(result.steps[0]?.status).toBe("passed");
    });
  });

  describe("guard の適用範囲", () => {
    it("--jobs > 1 の並列実行でも許可リストが効く", async () => {
      const flowA = singleStepFlow({ method: "GET", url: `${baseUrl}/a` });
      const flowB = singleStepFlow({ method: "GET", url: `${baseUrl}/b` });

      const result = await runLoadedFlows(
        [
          { filePath: "a.yaml", flow: flowA },
          { filePath: "b.yaml", flow: flowB },
        ],
        { cwd, history: false, jobs: 2, guard: { allowedHosts: ["api.example.com"] } },
      );

      expect(result.status).toBe("error");
      expect(result.flows.map((f) => f.steps[0]?.status)).toEqual(["error", "error"]);
      expect(received).toEqual([]);
    });

    it("--data の各イテレーションで許可リストが効く(行の値でホストを切り替えても拒否される)", async () => {
      const flow = singleStepFlow({ method: "GET", url: "{{target}}/a" });

      const result = await runLoadedFlows([{ filePath: "a.yaml", flow }], {
        cwd,
        history: false,
        dataRows: [{ target: baseUrl }, { target: "http://other.example.com" }],
        guard: { allowedHosts: [hostPort] },
      });

      // 1 行目(許可ホスト)は通り、2 行目(許可外ホスト)だけが拒否される
      expect(result.flows.map((f) => f.steps[0]?.status)).toEqual(["passed", "error"]);
      expect(received).toEqual(["GET /a"]);
    });

    it("$protected: readonly の判定も --jobs > 1 で効く", async () => {
      await writeEnv("stg", "$protected: readonly\nbaseUrl: x\n");
      const flow = singleStepFlow({ method: "POST", url: `${baseUrl}/w` }, "stg");

      const result = await runLoadedFlows(
        [
          { filePath: "a.yaml", flow },
          { filePath: "b.yaml", flow },
        ],
        { cwd, history: false, jobs: 2 },
      );

      expect(result.flows.map((f) => f.steps[0]?.status)).toEqual(["error", "error"]);
      expect(received).toEqual([]);
    });

    it("step.retry の全試行で guard が判定される(拒否は再試行しても送信されない)", async () => {
      const flow = flowSchema.parse({
        name: "retry guard flow",
        steps: [
          {
            name: "call",
            request: { method: "GET", url: `${baseUrl}/a` },
            retry: { count: 2, intervalMs: 0 },
          },
        ],
      });

      const result = await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        guard: { allowedHosts: ["api.example.com"] },
      });

      expect(result.steps[0]?.status).toBe("error");
      expect(result.steps[0]?.attempts).toBe(3);
      expect(received).toEqual([]);
    });
  });

  describe("安全柵の拒否の履歴記録", () => {
    async function collect(
      flow: ReturnType<typeof singleStepFlow>,
      options: Parameters<typeof executeFlow>[2] = {},
    ): Promise<HistoryEntry[]> {
      const entries: HistoryEntry[] = [];
      await executeFlow(flow, "flows/f.yaml", {
        cwd,
        history: (entry) => {
          entries.push(entry);
        },
        actor: { kind: "agent", name: "claude-code" },
        ...options,
      });
      return entries;
    }

    it("許可リストによる拒否は status: error・送信しようとしたリクエスト・理由・監査項目つきで記録される", async () => {
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/a` });

      const entries = await collect(flow, { guard: { allowedHosts: ["api.example.com"] } });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        v: 1,
        step: "call",
        status: "error",
        request: { method: "GET", url: `${baseUrl}/a` },
        assertions: [],
        file: "flows/f.yaml",
        actor: { kind: "agent", name: "claude-code" },
      });
      expect(entries[0]?.error).toContain("guard.allowedHosts");
      expect(entries[0]?.errorCode).toBe("guard.allowed-hosts");
      expect(entries[0]).not.toHaveProperty("response");
    });

    it("$protected: true と readonly の拒否も記録される(true でもリクエストを含む)", async () => {
      await writeEnv("prod", "$protected: true\nbaseUrl: x\n");
      await writeEnv("stg", "$protected: readonly\nbaseUrl: x\n");

      const blocked = await collect(singleStepFlow({ method: "GET", url: `${baseUrl}/a` }, "prod"));
      const readonly = await collect(
        singleStepFlow({ method: "POST", url: `${baseUrl}/w` }, "stg"),
      );

      expect(blocked[0]).toMatchObject({
        status: "error",
        env: "prod",
        request: { method: "GET" },
      });
      expect(blocked[0]?.error).toContain("$protected: true");
      expect(blocked[0]?.errorCode).toBe("guard.protected");
      expect(readonly[0]).toMatchObject({
        status: "error",
        env: "stg",
        request: { method: "POST" },
      });
      expect(readonly[0]?.error).toContain("refusing POST");
      expect(readonly[0]?.errorCode).toBe("guard.readonly");
      expect(received).toEqual([]);
    });

    it("記録される request・error は秘密情報がマスクされる", async () => {
      const KEY = "KLAUS_TEST_REFUSAL_SECRET";
      process.env[KEY] = "refusal-secret-value-123";
      try {
        const flow = singleStepFlow({
          method: "GET",
          url: `${baseUrl}/a`,
          headers: { "X-Key": `{{env.${KEY}}}` },
        });

        const entries = await collect(flow, { guard: { allowedHosts: ["api.example.com"] } });

        expect(JSON.stringify(entries[0])).not.toContain("refusal-secret-value-123");
        expect(entries[0]?.request?.headers["X-Key"]).toBe("***");
      } finally {
        delete process.env[KEY];
      }
    });

    it("history: false のときは拒否も記録しない", async () => {
      const flow = singleStepFlow({ method: "GET", url: `${baseUrl}/a` });

      const result = await executeFlow(flow, "f.yaml", {
        cwd,
        history: false,
        guard: { allowedHosts: ["api.example.com"] },
      });

      expect(result.steps[0]?.status).toBe("error");
      await expect(readAllHistoryEntries(cwd)).resolves.toEqual([]);
    });

    it("安全柵以外の実行時エラー(接続不能)は従来どおり履歴に記録しない", async () => {
      const port = await reserveClosedPort();
      const flow = singleStepFlow({ method: "GET", url: `http://127.0.0.1:${port}/a` });

      const entries = await collect(flow);

      expect(entries).toEqual([]);
    });
  });
});
