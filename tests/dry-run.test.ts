import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dryRunFlow, dryRunLoadedFlows } from "../src/core/dry-run.js";
import { ParseError } from "../src/core/errors.js";
import { historyFilePath } from "../src/core/history.js";
import { parseFlowYaml } from "../src/core/loader.js";
import { executeFlow } from "../src/core/runner.js";
import type { Flow } from "../src/core/schema.js";
import { closeServer, listenEphemeral } from "./support/net.js";

/** 受信したリクエスト数だけを数える fixture(dry-run が何も送信しないことの確認用) */
async function startCountingServer() {
  let requestCount = 0;
  const server = createServer((_req, res) => {
    requestCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const { baseUrl } = await listenEphemeral(server);
  return { server, baseUrl, count: () => requestCount };
}

function flowOf(yaml: string): Flow {
  return parseFlowYaml(yaml, "test.yaml");
}

describe("dryRunFlow", () => {
  let fixture: Awaited<ReturnType<typeof startCountingServer>>;
  const tmpRoot = join(process.cwd(), "tmp");
  let cwd: string;

  beforeAll(async () => {
    fixture = await startCountingServer();
    await mkdir(tmpRoot, { recursive: true });
  });

  afterAll(async () => {
    await closeServer(fixture.server);
  });

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-dryrun-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("送信せず、履歴・.klaus も作らずに、展開後のメソッド・URL(query マージ)・ヘッダー・ボディを返す", async () => {
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(
      join(cwd, "environments", "local.yaml"),
      `baseUrl: ${fixture.baseUrl}\ntenant: acme\n`,
      "utf-8",
    );
    const flow = flowOf(`
name: expand
env: local
steps:
  - name: create
    request:
      method: post
      url: "{{baseUrl}}/items?page=1"
      query: { page: "2", t: "{{tenant}}" }
      headers: { X-Tenant: "{{tenant}}" }
      body: { name: "{{tenant}}-item", n: 3 }
`);

    const result = await dryRunFlow(flow, "expand.yaml", { cwd });

    expect(fixture.count()).toBe(0);
    await expect(readFile(historyFilePath(cwd))).rejects.toThrow();
    const [step] = result.steps;
    expect(step).toMatchObject({
      name: "create",
      kind: "http",
      unresolved: [],
      conditional: false,
      guard: { status: "allowed" },
    });
    expect(step?.request).toEqual({
      method: "POST",
      url: `${fixture.baseUrl}/items?page=2&t=acme`,
      headers: { "X-Tenant": "acme" },
      body: { name: "acme-item", n: 3 },
    });
    expect(step).not.toHaveProperty("error");
  });

  it("graphql ステップは method 省略時に POST、body は { query, variables } に展開する", async () => {
    const flow = flowOf(`
name: gql
steps:
  - name: q
    request:
      url: "${fixture.baseUrl}/graphql"
      graphql:
        query: "query { user(id: \\"{{id}}\\") { name } }"
        variables: { id: "{{id}}" }
`);

    const result = await dryRunFlow(flow, "gql.yaml", { cwd, variables: { id: "7" } });

    expect(result.steps[0]?.request).toMatchObject({
      method: "POST",
      body: { query: 'query { user(id: "7") { name } }', variables: { id: "7" } },
    });
  });

  it("--var(variables)は環境ファイルの同名の値を上書きする", async () => {
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(join(cwd, "environments", "e.yaml"), "baseUrl: http://old.invalid\n", "utf-8");
    const flow = flowOf(`
name: v
env: e
steps:
  - name: s
    request: { method: GET, url: "{{baseUrl}}/x" }
`);

    const result = await dryRunFlow(flow, "v.yaml", {
      cwd,
      variables: { baseUrl: "http://new.invalid" },
    });

    expect(result.steps[0]?.request?.url).toBe("http://new.invalid/x");
  });

  describe("前段の capture に依存する変数", () => {
    const TWO_STEP = `
name: chain
steps:
  - name: login
    request: { method: POST, url: "{{baseUrl}}/login" }
    capture: { token: "$.token", userId: "$.user.id" }
  - name: me
    request:
      method: GET
      url: "{{baseUrl}}/users/{{userId}}"
      headers: { Authorization: "Bearer {{token}}" }
`;

    it("{{name}} のまま残し、unresolved に列挙する(エラーにしない)", async () => {
      const result = await dryRunFlow(flowOf(TWO_STEP), "chain.yaml", {
        cwd,
        variables: { baseUrl: fixture.baseUrl },
      });

      const [login, me] = result.steps;
      expect(login?.unresolved).toEqual([]);
      expect(me?.request).toMatchObject({
        url: `${fixture.baseUrl}/users/{{userId}}`,
        headers: { Authorization: "Bearer {{token}}" },
      });
      expect(me?.unresolved).toEqual(["userId", "token"]);
      expect(me).not.toHaveProperty("error");
    });

    it("環境に同名の値があっても、前段が capture する名前は未解決として扱う(実行時は capture が優先されるため)", async () => {
      const result = await dryRunFlow(flowOf(TWO_STEP), "chain.yaml", {
        cwd,
        variables: { baseUrl: fixture.baseUrl, token: "from-env" },
      });

      expect(result.steps[1]?.request?.headers).toEqual({ Authorization: "Bearer {{token}}" });
      expect(result.steps[1]?.unresolved).toContain("token");
    });

    it("capture 名と無関係な未解決変数は、実行時と同じメッセージのエラーとして報告する", async () => {
      const flow = flowOf(`
name: missing
steps:
  - name: a
    request: { method: GET, url: "${fixture.baseUrl}/{{nope}}" }
`);

      const dry = await dryRunFlow(flow, "missing.yaml", { cwd });
      const real = await executeFlow(flow, "missing.yaml", { cwd, history: false });

      expect(dry.steps[0]?.error).toContain('template variable "nope" could not be resolved');
      expect(dry.steps[0]?.error).toBe(real.steps[0]?.error);
      expect(dry.steps[0]).not.toHaveProperty("request");
      expect(dry.steps[0]?.guard.status).toBe("undetermined");
    });

    it("前段の capture がある場合も、未解決変数のエラーは実行時と同じメッセージ((available: ...) の一覧を含む)", async () => {
      const capturing = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token: "t-1" }));
      });
      const { baseUrl } = await listenEphemeral(capturing);
      try {
        const flow = flowOf(`
name: missing-after-capture
steps:
  - name: login
    request: { method: GET, url: "${baseUrl}/login" }
    capture: { token: "$.token" }
  - name: use
    request: { method: GET, url: "${baseUrl}/{{nope}}" }
`);

        const dry = await dryRunFlow(flow, "mc.yaml", { cwd, variables: { region: "eu" } });
        const real = await executeFlow(flow, "mc.yaml", {
          cwd,
          history: false,
          variables: { region: "eu" },
        });

        expect(real.steps[1]?.error).toContain("(available: env: region; captures: token)");
        expect(dry.steps[1]?.error).toBe(real.steps[1]?.error);
      } finally {
        await closeServer(capturing);
      }
    });

    it("後ろのステップや自分自身が capture する名前は、前段の capture とは見なさない", async () => {
      const flow = flowOf(`
name: order
steps:
  - name: self
    request: { method: GET, url: "${fixture.baseUrl}/{{late}}" }
    capture: { late: "$.x" }
  - name: later
    request: { method: GET, url: "${fixture.baseUrl}/y" }
    capture: { late2: "$.y" }
`);

      const result = await dryRunFlow(flow, "order.yaml", { cwd });

      expect(result.steps[0]?.error).toContain('template variable "late" could not be resolved');
    });
  });

  describe("{{env.X}}(OS 環境変数)", () => {
    const KEY = "KLAUS_DRYRUN_TEST_ENV";

    afterEach(() => {
      delete process.env[KEY];
    });

    it("解決した値を onSecrets に渡す", async () => {
      process.env[KEY] = "dry-run-secret-value";
      const collected: string[] = [];
      const flow = flowOf(`
name: sec
steps:
  - name: s
    request:
      method: GET
      url: "${fixture.baseUrl}/x"
      headers: { X-Key: "{{env.${KEY}}}" }
`);

      const result = await dryRunFlow(flow, "sec.yaml", {
        cwd,
        onSecrets: (secrets) => collected.push(...secrets),
      });

      expect(result.steps[0]?.request?.headers).toEqual({ "X-Key": "dry-run-secret-value" });
      expect(collected).toEqual(["dry-run-secret-value"]);
    });

    it("未定義なら実行時と同じメッセージのエラーとして報告する", async () => {
      const flow = flowOf(`
name: sec
steps:
  - name: s
    request:
      method: GET
      url: "${fixture.baseUrl}/x"
      headers: { X-Key: "{{env.${KEY}}}" }
`);

      const dry = await dryRunFlow(flow, "sec.yaml", { cwd });
      const real = await executeFlow(flow, "sec.yaml", { cwd, history: false });

      expect(dry.steps[0]?.error).toBe(`OS environment variable "${KEY}" is not defined`);
      expect(dry.steps[0]?.error).toBe(real.steps[0]?.error);
    });
  });

  it("if 条件つきのステップは conditional: true と条件式を返し、評価はせず展開結果も返す", async () => {
    const flow = flowOf(`
name: cond
steps:
  - name: first
    request: { method: GET, url: "${fixture.baseUrl}/a" }
  - name: second
    if: 'steps.first.status == "passed"'
    request: { method: GET, url: "${fixture.baseUrl}/b" }
`);

    const result = await dryRunFlow(flow, "cond.yaml", { cwd });

    expect(result.steps[0]).toMatchObject({ conditional: false });
    expect(result.steps[0]).not.toHaveProperty("if");
    expect(result.steps[1]).toMatchObject({
      conditional: true,
      if: 'steps.first.status == "passed"',
      request: { url: `${fixture.baseUrl}/b` },
    });
  });

  it("retry・assert・capture があっても評価せず、到達不能なホストへのステップでも接続しない", async () => {
    const flow = flowOf(`
name: noexec
steps:
  - name: dead
    request: { method: GET, url: "http://127.0.0.1:1/never", timeoutMs: 100 }
    retry: { count: 3, intervalMs: 1000 }
    assert: { status: 200 }
    capture: { x: "$.x" }
`);

    const started = Date.now();
    const result = await dryRunFlow(flow, "noexec.yaml", { cwd });

    expect(Date.now() - started).toBeLessThan(500);
    expect(result.steps[0]).toMatchObject({ guard: { status: "allowed" } });
    expect(result.steps[0]).not.toHaveProperty("error");
  });

  it("SSE ステップは kind: sse、WebSocket ステップは method: WS・送信メッセージ列つきの kind: ws で返す", async () => {
    const flow = flowOf(`
name: protocols
steps:
  - name: events
    request:
      method: GET
      url: "${fixture.baseUrl}/events"
      headers: { Accept: text/event-stream }
  - name: socket
    ws:
      url: "ws://127.0.0.1:9/ws"
      headers: { X-A: b }
      send: ["hello", { type: ping }]
`);

    const result = await dryRunFlow(flow, "protocols.yaml", { cwd });

    expect(result.steps[0]).toMatchObject({ kind: "sse" });
    expect(result.steps[1]).toMatchObject({
      kind: "ws",
      request: {
        method: "WS",
        url: "ws://127.0.0.1:9/ws",
        headers: { "X-A": "b" },
        body: ["hello", { type: "ping" }],
      },
    });
  });

  it("存在しない環境ファイルは executeFlow と同じく ParseError を投げる", async () => {
    const flow = flowOf(`
name: noenv
env: nope
steps:
  - name: s
    request: { method: GET, url: "${fixture.baseUrl}/x" }
`);

    await expect(dryRunFlow(flow, "noenv.yaml", { cwd })).rejects.toThrow(ParseError);
  });

  describe("安全柵の判定(実行時と同じ経路)", () => {
    const GET_FLOW = (url: string) =>
      flowOf(`
name: guarded
steps:
  - name: s
    request: { method: GET, url: "${url}" }
`);

    it("guard.allowedHosts に無いホストは refused で、理由は実行時のエラーメッセージと同じ", async () => {
      const flow = GET_FLOW(`${fixture.baseUrl}/x`);
      const guard = { allowedHosts: ["api.example.com"] };

      const dry = await dryRunFlow(flow, "g.yaml", { cwd, guard });
      const real = await executeFlow(flow, "g.yaml", { cwd, history: false, guard });

      expect(dry.steps[0]?.guard.status).toBe("refused");
      expect(dry.steps[0]?.guard.reason).toContain("guard.allowedHosts");
      expect(dry.steps[0]?.guard.errorCode).toBe("guard.allowed-hosts");
      expect(dry.steps[0]?.guard.reason).toBe(real.steps[0]?.error);
      expect(fixture.count()).toBe(0);
    });

    it("許可リストに一致するホストは allowed", async () => {
      const dry = await dryRunFlow(GET_FLOW(`${fixture.baseUrl}/x`), "g.yaml", {
        cwd,
        guard: { allowedHosts: [new URL(fixture.baseUrl).host] },
      });

      expect(dry.steps[0]?.guard).toEqual({ status: "allowed" });
    });

    it("下線を含むホスト名(Docker のネットワーク名など)は、許可リストと Host ヘッダーが同じなら allowed", async () => {
      const flow = flowOf(`
name: underscore
steps:
  - name: ok
    request:
      method: GET
      url: "http://my_service:8080/x"
      headers: { Host: "my_service:8080" }
`);
      const dry = await dryRunFlow(flow, "u.yaml", {
        cwd,
        guard: { allowedHosts: ["my_service:8080"] },
      });
      expect(dry.steps[0]?.guard).toEqual({ status: "allowed" });
    });

    it("文法に合わない Host は refused で、理由は「URL と違う」ではなく使えない文字を含むと伝える", async () => {
      const flow = flowOf(`
name: bad-host
steps:
  - name: bad
    request:
      method: GET
      url: "http://my_service:8080/x"
      headers: { Host: "my_service:8080#evil" }
`);
      const dry = await dryRunFlow(flow, "u.yaml", {
        cwd,
        guard: { allowedHosts: ["my_service:8080"] },
      });
      expect(dry.steps[0]?.guard.status).toBe("refused");
      expect(dry.steps[0]?.guard.reason).toContain("contains characters that are not allowed");
      expect(dry.steps[0]?.guard.reason).not.toContain("differs");
    });

    it("ホストが前段の capture に依存する場合は undetermined(refused ではない)", async () => {
      const flow = flowOf(`
name: late-host
steps:
  - name: discover
    request: { method: GET, url: "${fixture.baseUrl}/d" }
    capture: { base: "$.base" }
  - name: use
    request: { method: GET, url: "{{base}}/x" }
  - name: use2
    request: { method: GET, url: "http://{{base}}/x" }
`);

      const dry = await dryRunFlow(flow, "late.yaml", {
        cwd,
        guard: { allowedHosts: [new URL(fixture.baseUrl).host] },
      });

      expect(dry.steps[1]?.guard.status).toBe("undetermined");
      expect(dry.steps[1]?.guard.reason).toContain("depends on a variable");
      expect(dry.steps[2]?.guard.status).toBe("undetermined");
      expect(dry.steps[1]).not.toHaveProperty("error");
    });

    it("パスやクエリだけが未解決でホストが確定していれば、許可リストを判定できる", async () => {
      const flow = flowOf(`
name: late-path
steps:
  - name: discover
    request: { method: GET, url: "${fixture.baseUrl}/d" }
    capture: { id: "$.id" }
  - name: ok
    request: { method: GET, url: "${fixture.baseUrl}/items/{{id}}?q={{id}}" }
  - name: bad
    request: { method: GET, url: "http://other.example.com/items/{{id}}" }
`);

      const dry = await dryRunFlow(flow, "lp.yaml", {
        cwd,
        guard: { allowedHosts: [new URL(fixture.baseUrl).host] },
      });

      expect(dry.steps[1]?.guard.status).toBe("allowed");
      expect(dry.steps[1]?.unresolved).toEqual(["id"]);
      expect(dry.steps[2]?.guard.status).toBe("refused");
    });

    it("ホスト名が確定していれば、ポート・ユーザー情報・パスが未解決でも許可リストを判定する(refused / allowed)", async () => {
      const flow = flowOf(`
name: late-parts
steps:
  - name: discover
    request: { method: GET, url: "${fixture.baseUrl}/d" }
    capture: { port: "$.port", u: "$.u" }
  - name: bad-port
    request: { method: GET, url: "http://evil.com:{{port}}/" }
  - name: bad-userinfo
    request: { method: GET, url: "http://{{u}}@evil.com/" }
  - name: ok-userinfo
    request: { method: GET, url: "http://{{u}}@${new URL(fixture.baseUrl).host}/" }
`);

      const dry = await dryRunFlow(flow, "lp2.yaml", {
        cwd,
        guard: { allowedHosts: [new URL(fixture.baseUrl).host] },
      });

      expect(dry.steps[1]?.guard.status).toBe("refused");
      expect(dry.steps[1]?.guard.reason).toContain('host "evil.com"');
      expect(dry.steps[2]?.guard.status).toBe("refused");
      expect(dry.steps[3]?.guard.status).toBe("allowed");
      expect(dry.steps[3]?.unresolved).toEqual(["u"]);
    });

    it("ポートだけが未解決で、そのホストの許可エントリがすべてポート指定つきなら undetermined(ポート指定なしのエントリがあれば allowed)", async () => {
      const flow = flowOf(`
name: late-port
steps:
  - name: discover
    request: { method: GET, url: "${fixture.baseUrl}/d" }
    capture: { port: "$.port" }
  - name: use
    request: { method: GET, url: "http://api.example.com:{{port}}/" }
`);

      const withPort = await dryRunFlow(flow, "p.yaml", {
        cwd,
        guard: { allowedHosts: ["api.example.com:8443"] },
      });
      const anyPort = await dryRunFlow(flow, "p.yaml", {
        cwd,
        guard: { allowedHosts: ["api.example.com", "api.example.com:8443"] },
      });
      const otherHost = await dryRunFlow(flow, "p.yaml", {
        cwd,
        guard: { allowedHosts: ["other.example.com:8443"] },
      });

      expect(withPort.steps[1]?.guard.status).toBe("undetermined");
      expect(withPort.steps[1]?.guard.reason).toContain("port");
      expect(anyPort.steps[1]?.guard.status).toBe("allowed");
      expect(otherHost.steps[1]?.guard.status).toBe("refused");
    });

    it("ホストが未解決でも、許可リストが無ければ allowed(判定すべきホスト制限が無い)", async () => {
      const flow = flowOf(`
name: no-allowlist
steps:
  - name: discover
    request: { method: GET, url: "${fixture.baseUrl}/d" }
    capture: { base: "$.base" }
  - name: use
    request: { method: GET, url: "{{base}}/x" }
`);

      const dry = await dryRunFlow(flow, "na.yaml", { cwd });

      expect(dry.steps[1]?.guard).toEqual({ status: "allowed" });
    });

    describe("保護環境", () => {
      async function writeEnv(name: string, protectedValue: string) {
        await mkdir(join(cwd, "environments"), { recursive: true });
        await writeFile(
          join(cwd, "environments", `${name}.yaml`),
          `$protected: ${protectedValue}\nbaseUrl: ${fixture.baseUrl}\n`,
          "utf-8",
        );
      }

      it("$protected: true はすべてのステップが refused で、--allow-protected 相当(allowProtected)なら allowed", async () => {
        await writeEnv("prod", "true");
        const flow = flowOf(`
name: p
env: prod
steps:
  - name: s
    request: { method: GET, url: "{{baseUrl}}/x" }
`);

        const refused = await dryRunFlow(flow, "p.yaml", { cwd });
        const allowed = await dryRunFlow(flow, "p.yaml", { cwd, allowProtected: true });

        expect(refused.steps[0]?.guard.status).toBe("refused");
        expect(refused.steps[0]?.guard.reason).toContain("$protected: true");
        expect(refused.steps[0]?.guard.errorCode).toBe("guard.protected");
        expect(allowed.steps[0]?.guard.status).toBe("allowed");
        expect(allowed.steps[0]?.guard.errorCode).toBeUndefined();
      });

      it("entryPoint が mcp の dry-run の拒否理由は、klaus mcp が上書きできない旨の案内になる", async () => {
        await writeEnv("prod", "true");
        const flow = flowOf(`
name: p
env: prod
steps:
  - name: s
    request: { method: GET, url: "{{baseUrl}}/x" }
`);

        const refused = await dryRunFlow(flow, "p.yaml", { cwd, entryPoint: "mcp" });

        expect(refused.steps[0]?.guard.status).toBe("refused");
        expect(refused.steps[0]?.guard.errorCode).toBe("guard.protected");
        expect(refused.steps[0]?.guard.reason).toContain(
          "klaus mcp cannot override environment protection",
        );
      });

      it('$protected: "readonly" は GET が allowed、POST・WebSocket・メソッド上書きヘッダーつきの GET が refused', async () => {
        await writeEnv("stg", "readonly");
        const flow = flowOf(`
name: ro
env: stg
steps:
  - name: get
    request: { method: GET, url: "{{baseUrl}}/x" }
  - name: post
    request: { method: POST, url: "{{baseUrl}}/x" }
  - name: override
    request:
      method: GET
      url: "{{baseUrl}}/x"
      headers: { X-HTTP-Method-Override: DELETE }
  - name: ws
    ws: { url: "ws://127.0.0.1:9/ws" }
`);

        const result = await dryRunFlow(flow, "ro.yaml", { cwd });

        expect(result.steps.map((s) => s.guard.status)).toEqual([
          "allowed",
          "refused",
          "refused",
          "refused",
        ]);
        expect(result.steps[1]?.guard.reason).toContain("refusing POST");
        expect(result.steps.map((s) => s.guard.errorCode)).toEqual([
          undefined,
          "guard.readonly",
          "guard.method-override",
          "guard.readonly",
        ]);
      });

      it("ホストが未解決でも、ホストに依存しない拒否(readonly の POST)は refused のまま", async () => {
        await writeEnv("stg", "readonly");
        const flow = flowOf(`
name: ro-late
env: stg
steps:
  - name: discover
    request: { method: GET, url: "{{baseUrl}}/d" }
    capture: { base: "$.base" }
  - name: post
    request: { method: POST, url: "{{base}}/x" }
  - name: get
    request: { method: GET, url: "{{base}}/x" }
`);

        const result = await dryRunFlow(flow, "rl.yaml", {
          cwd,
          guard: { allowedHosts: ["example.com"] },
        });

        expect(result.steps[1]?.guard.status).toBe("refused");
        expect(result.steps[2]?.guard.status).toBe("undetermined");
      });
    });
  });
});

describe("dryRunLoadedFlows", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let cwd: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    cwd = await mkdtemp(join(tmpRoot, "klaus-dryrun-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("--data の行ごとに、行(外側) × フロー(内側)の順で iteration つきのユニットへ展開し、行の値が --var を上書きする", async () => {
    const a = flowOf(`
name: a
steps:
  - name: s
    request: { method: GET, url: "http://h.example/{{id}}/{{common}}" }
`);
    const b = flowOf(`
name: b
steps:
  - name: s
    request: { method: GET, url: "http://h.example/b/{{id}}" }
`);

    const result = await dryRunLoadedFlows(
      [
        { filePath: "a.yaml", flow: a },
        { filePath: "b.yaml", flow: b },
      ],
      { cwd, variables: { id: "var", common: "c" }, dataRows: [{ id: "r1" }, { id: "r2" }] },
    );

    expect(result.flows.map((f) => [f.name, f.iteration])).toEqual([
      ["a", 1],
      ["b", 1],
      ["a", 2],
      ["b", 2],
    ]);
    expect(result.flows.map((f) => f.steps[0]?.request?.url)).toEqual([
      "http://h.example/r1/c",
      "http://h.example/b/r1",
      "http://h.example/r2/c",
      "http://h.example/b/r2",
    ]);
  });

  it("--data が無ければ iteration を持たず、入力順のまま返す", async () => {
    const a = flowOf(`
name: a
steps:
  - name: s
    request: { method: GET, url: "http://h.example/a" }
`);

    const result = await dryRunLoadedFlows([{ filePath: "a.yaml", flow: a }], { cwd });

    expect(result.flows).toHaveLength(1);
    expect(result.flows[0]).not.toHaveProperty("iteration");
  });
});
