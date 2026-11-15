import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendHistory, readAllHistoryEntries } from "../../src/core/index.js";
import {
  MAX_RESULT_BYTES,
  serializeOutcome,
  type ToolFailure,
  type ToolOutcome,
} from "../../src/mcp/result.js";
import { resolveMcpActor, TOOL_DEFINITIONS, type ToolContext } from "../../src/mcp/tools.js";
import { closeServer, listenEphemeral } from "../support/net.js";

/**
 * klaus mcp のツールハンドラを、node:http のローカル fixture に対して直接呼ぶ。
 * SDK を介さない(SDK への登録・直列化は tests/cli/integration.test.ts がビルド済みバイナリで検証する)。
 * SDK と同様に、ハンドラへ渡す前に入力スキーマで引数を検証・整形する。
 */

const tmpRoot = join(process.cwd(), "tmp");
const TOKEN = "tok-mcp-secret-9f8e7d6c";

interface Received {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** 300 KiB 超のテキスト本文。位置ごとに内容が違い、2 バイト文字・サロゲートペア(U+1D4B3)・引用符・改行を含む */
const BIG_TEXT = Array.from(
  { length: 30000 },
  (_, i) => `${i.toString(36).padStart(4, "0")}|é"\n${String.fromCodePoint(0x1d4b3)}|`,
).join("");

let fixture: Server;
let baseUrl = "";
let received: Received[] = [];
/** /snap が返す本文(スナップショットのテストが差し替える) */
let snapBody: unknown = { id: 1, name: "alice" };

let base = "";
let cwd = "";
const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  cwd,
  readOnly: false,
  clientName: "test-agent",
  ...overrides,
});

async function call(
  name: string,
  args: Record<string, unknown> = {},
  context: ToolContext = ctx(),
): Promise<ToolOutcome> {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
  if (definition === undefined) throw new Error(`unknown tool ${name}`);
  return definition.handler(definition.inputSchema.parse(args), context);
}

// biome-ignore lint/suspicious/noExplicitAny: 結果の形はテストごとに異なるため、アサーションの簡潔さを優先する
function data(outcome: ToolOutcome): any {
  if (!outcome.ok) throw new Error(`expected success but got: ${JSON.stringify(outcome)}`);
  return outcome.data;
}

function failure(outcome: ToolOutcome): ToolFailure {
  if (outcome.ok) throw new Error(`expected failure but got: ${JSON.stringify(outcome.data)}`);
  return outcome;
}

async function writeProjectFile(relPath: string, content: string): Promise<void> {
  await mkdir(dirname(join(cwd, relPath)), { recursive: true });
  await writeFile(join(cwd, relPath), content, "utf-8");
}

/** GET を 1 ステップだけ行うフロー */
function getFlow(name: string, path: string, extra = ""): string {
  return `name: ${name}\nsteps:\n  - name: get\n    request:\n      method: GET\n      url: "${baseUrl}${path}"\n${extra}`;
}

beforeAll(async () => {
  fixture = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.url === "/echo-auth") return json(200, { authorization: req.headers.authorization });
      if (req.url === "/snap") return json(200, snapBody);
      if (req.url === "/deep") {
        // 深さ 5000 の JSON をテキストとして返す(深い値を JSON.stringify しない: Node 22.19 でスタックが溢れるため)
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(`${"[".repeat(5000)}${"]".repeat(5000)}`);
        return;
      }
      if (req.url === "/big") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(BIG_TEXT);
        return;
      }
      if (req.url === "/items" && req.method === "POST") return json(201, { id: 1, name: "a" });
      return json(200, { ok: true });
    });
  });
  ({ baseUrl } = await listenEphemeral(fixture));
  await mkdir(tmpRoot, { recursive: true });
  process.env.MCP_TEST_TOKEN = TOKEN;
});

afterAll(async () => {
  await closeServer(fixture);
  delete process.env.MCP_TEST_TOKEN;
});

beforeEach(async () => {
  received = [];
  snapBody = { id: 1, name: "alice" };
  base = await mkdtemp(join(tmpRoot, "klaus-mcp-"));
  cwd = join(base, "proj");
  await mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("参照系のツール", () => {
  it("klaus_list_flows: フローの名前とステップ数を返し、検証に失敗するものは error つきで載せる", async () => {
    await writeProjectFile("api/ok.yaml", getFlow("ok flow", "/ok"));
    await writeProjectFile("api/broken.yaml", "name: broken\nsteps: []\n");

    const { flows } = data(await call("klaus_list_flows"));

    expect(flows).toHaveLength(2);
    expect(flows[0]).toMatchObject({ path: "api/broken.yaml" });
    expect(flows[0].error).toEqual(expect.any(String));
    expect(flows[1]).toEqual({ path: "api/ok.yaml", name: "ok flow", stepCount: 1 });
  });

  it("klaus_validate_flow: 正しい定義は valid、誤りは行番号つきの errors。構文エラーでファイルの内容を漏らさない", async () => {
    await writeProjectFile("api/ok.yaml", getFlow("ok flow", "/ok"));
    await writeProjectFile("api/bad.yaml", "name: bad\nsteps: []\n");
    // YAML の構文エラーはソース行の抜粋を含むが、それをエージェントへ返してはいけない
    await writeProjectFile("api/notes.yaml", "API_KEY=hunter2-secret-value\nother: x: y\n");

    const valid = data(await call("klaus_validate_flow", { file: "api/ok.yaml" }));
    const invalid = data(await call("klaus_validate_flow", { file: "api/bad.yaml" }));
    const syntax = data(await call("klaus_validate_flow", { file: "api/notes.yaml" }));

    expect(valid).toEqual({ file: "api/ok.yaml", valid: true, name: "ok flow", steps: 1 });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors[0]).toMatchObject({ path: "steps" });
    expect(syntax.valid).toBe(false);
    expect(syntax.errors[0].message).toContain("YAML syntax error");
    expect(JSON.stringify(syntax)).not.toContain("hunter2-secret-value");
  });

  it("klaus_list_environments: 保護モードを返し、値は返さず、読めないファイルは unknown にする", async () => {
    await writeProjectFile("environments/dev.yaml", "baseUrl: http://dev.internal.example\n");
    await writeProjectFile(
      "environments/prod.yaml",
      "$protected: true\nbaseUrl: http://prod.internal.example\n",
    );
    await writeProjectFile(
      "environments/stg.yaml",
      "$protected: readonly\nbaseUrl: http://stg.internal.example\n",
    );
    await writeProjectFile("environments/broken.yaml", "baseUrl: [\n");

    const outcome = await call("klaus_list_environments");
    const { environments } = data(outcome);

    expect(
      environments.map((e: { name: string; protection: string }) => [e.name, e.protection]),
    ).toEqual([
      ["broken", "unknown"],
      ["dev", "none"],
      ["prod", "protected"],
      ["stg", "readonly"],
    ]);
    expect(JSON.stringify(outcome)).not.toContain("internal.example");
  });

  it("klaus_dry_run: 送らず・履歴も書かず、展開後のリクエストを秘密をマスクして返す", async () => {
    await writeProjectFile(
      "api/auth.yaml",
      `name: auth\nsteps:\n  - name: get\n    request:\n      method: GET\n      url: "${baseUrl}/echo-auth"\n      headers:\n        Authorization: "Bearer {{env.MCP_TEST_TOKEN}}"\n`,
    );

    const outcome = await call("klaus_dry_run", { file: "api/auth.yaml" });
    const result = data(outcome);

    expect(result.summary).toMatchObject({ steps: 1, allowed: 1, refused: 0 });
    expect(result.flows[0].file).toBe("api/auth.yaml");
    expect(result.flows[0].steps[0].request.headers.Authorization).toBe("Bearer ***");
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(received).toHaveLength(0);
    await expect(stat(join(cwd, ".klaus"))).rejects.toThrow();
  });

  it("klaus_dry_run: 許可リスト外のホストと保護環境は refused と errorCode で示す(mcp 向けの案内つき)", async () => {
    await writeProjectFile("api/ok.yaml", getFlow("ok flow", "/ok"));
    await writeProjectFile(
      "api/prod.yaml",
      `name: prod flow\nenv: prod\nsteps:\n  - name: get\n    request:\n      method: GET\n      url: "{{baseUrl}}/ok"\n`,
    );
    await writeProjectFile("environments/prod.yaml", `$protected: true\nbaseUrl: ${baseUrl}\n`);
    await writeProjectFile("klaus.config.yaml", "guard:\n  allowedHosts:\n    - example.com\n");

    const hosts = data(await call("klaus_dry_run", { file: "api/ok.yaml" }));
    const prod = data(await call("klaus_dry_run", { file: "api/prod.yaml" }));

    expect(hosts.flows[0].steps[0].guard).toMatchObject({
      status: "refused",
      errorCode: "guard.allowed-hosts",
    });
    expect(prod.flows[0].steps[0].guard.errorCode).toBe("guard.protected");
    expect(prod.flows[0].steps[0].guard.reason).toContain(
      "klaus mcp cannot override environment protection",
    );
  });
});

describe("klaus_dry_run の variables と環境の値の表示", () => {
  it("variables はテンプレートの変数として展開される(送らない)", async () => {
    await writeProjectFile(
      "api/vars.yaml",
      `name: vars\nsteps:\n  - name: get\n    request:\n      method: GET\n      url: "${baseUrl}/items/{{itemId}}"\n`,
    );

    const result = data(
      await call("klaus_dry_run", { file: "api/vars.yaml", variables: { itemId: "42" } }),
    );

    expect(result.flows[0].steps[0].request.url).toBe(`${baseUrl}/items/42`);
    expect(result.summary.expansionErrors).toBe(0);
    expect(received).toHaveLength(0);
  });

  it("保護された環境ファイルの値は、拒否された(refused)ステップでも展開されて表示される(マスクされるのは秘密として登録された値だけ)", async () => {
    await writeProjectFile(
      "api/prod.yaml",
      `name: prod flow\nenv: prod\nsteps:\n  - name: get\n    request:\n      method: GET\n      url: "${baseUrl}/ok"\n      headers:\n        X-Api-Key: "{{apiKey}}"\n`,
    );
    await writeProjectFile(
      "environments/prod.yaml",
      "$protected: true\napiKey: plain-env-file-value\n",
    );

    const prod = data(await call("klaus_dry_run", { file: "api/prod.yaml" }));

    const step = prod.flows[0].steps[0];
    expect(step.guard.errorCode).toBe("guard.protected");
    expect(step.request.headers["X-Api-Key"]).toBe("plain-env-file-value");
  });
});

describe("klaus_run_flow", () => {
  it("実行して要約を返し、履歴に agent とクライアント名で記録する(応答本文は含めない)", async () => {
    await writeProjectFile(
      "api/ok.yaml",
      getFlow("ok flow", "/ok", "    assert:\n      status: 200\n"),
    );

    const result = data(await call("klaus_run_flow", { file: "api/ok.yaml" }));

    expect(result).toMatchObject({
      status: "passed",
      flows: [{ name: "ok flow", file: "api/ok.yaml" }],
    });
    expect(result.flows[0].steps[0]).toMatchObject({
      name: "get",
      status: "passed",
      httpStatus: 200,
      method: "GET",
      assertions: { total: 1, failed: [] },
    });
    expect(JSON.stringify(result)).not.toContain('"ok":true');
    const history = await readAllHistoryEntries(cwd);
    expect(history).toHaveLength(1);
    expect(history[0]?.runId).toBe(result.runId);
    expect(history[0]?.actor).toEqual({ kind: "agent", name: "test-agent" });
  });

  it("履歴に記録されたステップにだけ historyRef を付け、記録されないエラー(キャプチャ失敗)のステップには付けない", async () => {
    await writeProjectFile(
      "api/capture.yaml",
      `name: capture flow
steps:
  - name: login
    request:
      method: GET
      url: "${baseUrl}/ok"
    capture:
      token: "$.does.not.exist"
  - name: after
    request:
      method: GET
      url: "${baseUrl}/ok"
`,
    );
    await writeProjectFile("api/ok.yaml", getFlow("ok flow", "/ok"));

    const failed = data(await call("klaus_run_flow", { file: "api/capture.yaml" }));
    const passed = data(await call("klaus_run_flow", { file: "api/ok.yaml" }));

    const [login, after] = failed.flows[0].steps;
    expect(login).toMatchObject({ name: "login", status: "error" });
    expect(login).not.toHaveProperty("historyRef");
    // 先行ステップの失敗でスキップされたステップは記録される
    expect(after).toMatchObject({ name: "after", status: "skipped" });
    expect(after.historyRef).toEqual({ runId: failed.runId, step: "after" });
    expect(passed.flows[0].steps[0].historyRef).toEqual({ runId: passed.runId, step: "get" });
    // historyRef が指すエントリは引け、無いステップは引けない
    expect(
      data(await call("klaus_history_show", { runId: failed.runId, step: "after" })).entries,
    ).toHaveLength(1);
    expect(
      failure(await call("klaus_history_show", { runId: failed.runId, step: "login" })).error,
    ).toContain("no history entries found");
  });

  it("入れ子が深すぎる JSON 応答(深さ 5000)でも実行が完了し、履歴に記録され、結果を返せる", async () => {
    await writeProjectFile(
      "api/deep.yaml",
      getFlow("deep flow", "/deep", "    assert:\n      status: 200\n"),
    );

    const result = data(await call("klaus_run_flow", { file: "api/deep.yaml" }));

    expect(result.status).toBe("passed");
    expect(result.flows[0].steps[0].historyRef).toEqual({ runId: result.runId, step: "get" });
    const history = await readAllHistoryEntries(cwd);
    expect(typeof history[0]?.response?.body).toBe("string");
  });

  it("失敗したアサーションは失敗のまま通常の結果として返し(ツールの失敗にしない)、秘密の値はマスクする", async () => {
    await writeProjectFile(
      "api/auth.yaml",
      `name: auth\nsteps:\n  - name: get\n    request:\n      method: GET\n      url: "${baseUrl}/echo-auth"\n      headers:\n        Authorization: "Bearer {{env.MCP_TEST_TOKEN}}"\n    assert:\n      body:\n        - path: "$.authorization"\n          equals: "something else"\n`,
    );

    const outcome = await call("klaus_run_flow", { file: "api/auth.yaml" });
    const result = data(outcome);

    expect(result.status).toBe("failed");
    const [assertion] = result.flows[0].steps[0].assertions.failed;
    expect(assertion.actual).toBe("Bearer ***");
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    const stored = await readFile(
      join(cwd, ".klaus", "history", (await readdir(join(cwd, ".klaus", "history")))[0] as string),
      "utf-8",
    );
    expect(stored).not.toContain(TOKEN);
  });

  it("variables を渡せる", async () => {
    await writeProjectFile(
      "api/vars.yaml",
      `name: vars\nsteps:\n  - name: get\n    request:\n      method: GET\n      url: "${baseUrl}/{{path}}"\n`,
    );

    const result = data(
      await call("klaus_run_flow", { file: "api/vars.yaml", variables: { path: "ok" } }),
    );

    expect(result.status).toBe("passed");
    expect(received[0]?.url).toBe("/ok");
  });

  it("guard.allowedHosts は klaus.config.yaml から呼び出しごとに読み直され、拒否は errorCode つきで報告される(送信しない)", async () => {
    await writeProjectFile("api/ok.yaml", getFlow("ok flow", "/ok"));

    const before = data(await call("klaus_run_flow", { file: "api/ok.yaml" }));
    // 再起動なしで設定の変更が効く
    await writeProjectFile("klaus.config.yaml", "guard:\n  allowedHosts:\n    - example.com\n");
    const after = data(await call("klaus_run_flow", { file: "api/ok.yaml" }));

    expect(before.status).toBe("passed");
    expect(after.status).toBe("error");
    expect(after.flows[0].steps[0]).toMatchObject({
      status: "error",
      errorCode: "guard.allowed-hosts",
    });
    expect(received).toHaveLength(1);
  });

  it("保護環境($protected: true)は拒否され、klaus mcp には上書きできない旨の案内が付く。readonly の環境では POST が拒否される", async () => {
    await writeProjectFile("environments/prod.yaml", `$protected: true\nbaseUrl: ${baseUrl}\n`);
    await writeProjectFile("environments/stg.yaml", `$protected: readonly\nbaseUrl: ${baseUrl}\n`);
    await writeProjectFile(
      "api/get.yaml",
      getFlow("get flow", "/ok").replace(baseUrl, "{{baseUrl}}"),
    );
    await writeProjectFile(
      "api/post.yaml",
      `name: post flow\nsteps:\n  - name: post\n    request:\n      method: POST\n      url: "{{baseUrl}}/items"\n`,
    );

    const prod = data(await call("klaus_run_flow", { file: "api/get.yaml", env: "prod" }));
    const stgPost = data(await call("klaus_run_flow", { file: "api/post.yaml", env: "stg" }));
    const stgGet = data(await call("klaus_run_flow", { file: "api/get.yaml", env: "stg" }));

    expect(prod.flows[0].steps[0]).toMatchObject({ status: "error", errorCode: "guard.protected" });
    expect(prod.flows[0].steps[0].error).toContain(
      "klaus mcp cannot override environment protection",
    );
    expect(prod.flows[0].steps[0].error).toContain("klaus run --allow-protected");
    expect(stgPost.flows[0].steps[0]).toMatchObject({
      status: "error",
      errorCode: "guard.readonly",
    });
    expect(stgGet.status).toBe("passed");
    expect(received.map((r) => r.method)).toEqual(["GET"]);
  });

  it("定義エラー・不正な設定・不正な env はツールの失敗になり、何も送らない", async () => {
    await writeProjectFile("api/bad.yaml", "name: bad\nsteps: []\n");
    await writeProjectFile("api/ok.yaml", getFlow("ok flow", "/ok"));

    const definition = failure(await call("klaus_run_flow", { file: "api/bad.yaml" }));
    const env = failure(await call("klaus_run_flow", { file: "api/ok.yaml", env: "../x" }));
    await writeProjectFile("klaus.config.yaml", "unknownKey: 1\n");
    const config = failure(await call("klaus_run_flow", { file: "api/ok.yaml" }));

    expect(definition.error).toContain("flow definition error");
    expect(env.error).toContain("env is invalid");
    expect(config.error).toContain("klaus.config.yaml");
    expect(received).toHaveLength(0);
  });

  it("スナップショット: 基準が無ければ書き、不一致は報告するだけで更新しない(ci も update も false)", async () => {
    await writeProjectFile(
      "api/snap.yaml",
      getFlow("snap flow", "/snap", "    assert:\n      snapshot: true\n"),
    );

    const first = data(await call("klaus_run_flow", { file: "api/snap.yaml" }));
    snapBody = { id: 1, name: "bob" };
    const second = data(await call("klaus_run_flow", { file: "api/snap.yaml" }));

    expect(first.flows[0].steps[0].snapshot).toMatchObject({ state: "written" });
    expect(second.status).toBe("failed");
    expect(second.flows[0].steps[0].snapshot).toMatchObject({
      state: "mismatch",
      differenceCount: 1,
    });
    expect(second.flows[0].steps[0].snapshot.differences[0]).toMatchObject({
      before: "alice",
      after: "bob",
    });
    expect(second.flows[0].steps[0].snapshot.candidate).toBeUndefined();
    const stored = await readFile(
      join(cwd, "api", "__snapshots__", "snap.yaml.snap.json"),
      "utf-8",
    );
    expect(stored).toContain("alice");
    expect(stored).not.toContain("bob");
  });
});

describe("klaus_request", () => {
  it("単発リクエストを送り、応答(ステータス・ヘッダー・本文)と runId を返す。JSON の body はそのまま送る", async () => {
    const result = data(
      await call("klaus_request", { method: "post", url: `${baseUrl}/items`, body: { name: "a" } }),
    );

    expect(result).toMatchObject({
      status: "passed",
      historyRecorded: true,
      request: { method: "POST", url: `${baseUrl}/items` },
      response: { status: 201, body: { id: 1, name: "a" } },
    });
    expect(received[0]?.body).toBe('{"name":"a"}');
    expect(received[0]?.headers["content-type"]).toContain("application/json");
    const history = await readAllHistoryEntries(cwd);
    expect(history[0]).toMatchObject({
      runId: result.runId,
      source: "single",
      actor: { kind: "agent", name: "test-agent" },
    });
  });

  it("展開した秘密の値は応答にエコーされてもマスクされる", async () => {
    const outcome = await call("klaus_request", {
      method: "GET",
      url: `${baseUrl}/echo-auth`,
      headers: { Authorization: "Bearer {{env.MCP_TEST_TOKEN}}" },
    });

    expect(data(outcome).response.body).toEqual({ authorization: "Bearer ***" });
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
  });

  it("入れ子が深すぎる JSON 応答(深さ 5000)は、シークレットの有無によらず通常の結果で返り、本文はテキストのまま履歴に残る", async () => {
    for (const headers of [undefined, { Authorization: "Bearer {{env.MCP_TEST_TOKEN}}" }]) {
      const outcome = await call("klaus_request", {
        method: "GET",
        url: `${baseUrl}/deep`,
        ...(headers !== undefined ? { headers } : {}),
      });

      const result = data(outcome);
      expect(result.status).toBe("passed");
      expect(typeof result.response.body).toBe("string");
      expect(result.response.body).toHaveLength(10000);
      expect(result.historyRecorded).toBe(true);
      expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    }
    const history = await readAllHistoryEntries(cwd);
    expect(history).toHaveLength(2);
    expect(history.every((entry) => typeof entry.response?.body === "string")).toBe(true);
  });

  it("入れ子が深すぎる object / array の body は、分かりやすいエラーで拒否して送らない(文字列なら送れる)", async () => {
    // 深い値は JSON.stringify せず、反復で組み立てる
    let deep: unknown = [];
    for (let i = 0; i < 300; i++) deep = [deep];

    const refused = failure(
      await call("klaus_request", { method: "POST", url: `${baseUrl}/items`, body: deep }),
    );

    expect(refused.error).toContain("nested deeper than 200 levels");
    expect(refused.hint).toContain("string");
    expect(received).toHaveLength(0);

    const asText = `${"[".repeat(300)}${"]".repeat(300)}`;
    const sent = data(
      await call("klaus_request", {
        method: "POST",
        url: `${baseUrl}/items`,
        headers: { "Content-Type": "application/json" },
        body: asText,
      }),
    );
    expect(sent.status).toBe("passed");
    expect(received[0]?.body).toBe(asText);
  });

  it("許可リスト外のホストは errorCode と案内つきのツールの失敗になり、送信しない", async () => {
    await writeProjectFile("klaus.config.yaml", "guard:\n  allowedHosts:\n    - example.com\n");

    const refused = failure(await call("klaus_request", { method: "GET", url: `${baseUrl}/ok` }));

    expect(refused.errorCode).toBe("guard.allowed-hosts");
    expect(refused.hint).toContain("guard.allowedHosts");
    expect(refused.runId).toEqual(expect.any(String));
    expect(received).toHaveLength(0);
  });

  it("保護環境は mcp 向けの案内で拒否され(上書きの手段は無い)、readonly の環境では GET だけ通る", async () => {
    await writeProjectFile("environments/prod.yaml", `$protected: true\nbaseUrl: ${baseUrl}\n`);
    await writeProjectFile("environments/stg.yaml", `$protected: readonly\nbaseUrl: ${baseUrl}\n`);

    const prod = failure(
      await call("klaus_request", { method: "GET", url: "{{baseUrl}}/ok", env: "prod" }),
    );
    const post = failure(
      await call("klaus_request", { method: "POST", url: "{{baseUrl}}/items", env: "stg" }),
    );
    const get = data(
      await call("klaus_request", { method: "GET", url: "{{baseUrl}}/ok", env: "stg" }),
    );

    expect(prod.errorCode).toBe("guard.protected");
    expect(prod.error).toContain("klaus mcp cannot override environment protection");
    expect(prod.hint).toContain("has no option to override");
    expect(post.errorCode).toBe("guard.readonly");
    expect(get.response.status).toBe(200);
    expect(received.map((r) => r.method)).toEqual(["GET"]);
  });
});

describe("フローのパスの検証", () => {
  it.each(["klaus_validate_flow", "klaus_dry_run", "klaus_run_flow"])(
    "%s: cwd の外・リンク経由・YAML 以外は拒否する",
    async (tool) => {
      await writeFile(join(base, "outside.yaml"), getFlow("outside", "/ok"), "utf-8");
      await symlink(join(base, "outside.yaml"), join(cwd, "link.yaml"));
      await writeProjectFile(".env", "SECRET=1\n");

      for (const file of ["../outside.yaml", join(base, "outside.yaml"), "link.yaml", ".env"]) {
        const refused = failure(await call(tool, { file }));
        expect(refused.errorCode, file).toBe("guard.path");
      }
      expect(received).toHaveLength(0);
    },
  );
});

describe("履歴・差分・スナップショットの参照", () => {
  it("klaus_history_list: 要約行だけを新しい順に返し、status と limit で絞れる(本文は含めない)", async () => {
    await writeProjectFile(
      "api/ok.yaml",
      getFlow("ok flow", "/ok", "    assert:\n      status: 200\n"),
    );
    await writeProjectFile(
      "api/ng.yaml",
      getFlow("ng flow", "/ok", "    assert:\n      status: 500\n"),
    );
    await call("klaus_run_flow", { file: "api/ok.yaml" });
    await call("klaus_run_flow", { file: "api/ng.yaml" });

    const all = data(await call("klaus_history_list"));
    const failed = data(await call("klaus_history_list", { statuses: ["failed"] }));
    const one = data(await call("klaus_history_list", { limit: 1, flow: "ok flow" }));

    expect(all.entries.map((e: { flow: string }) => e.flow)).toEqual(["ng flow", "ok flow"]);
    expect(all.entries[0]).toMatchObject({
      status: "failed",
      httpStatus: 200,
      failedAssertions: 1,
    });
    expect(all.entries[0].response).toBeUndefined();
    expect(all.entries[0].request).toBeUndefined();
    expect(failed.entries).toHaveLength(1);
    expect(one).toMatchObject({ hasMore: false, entries: [{ flow: "ok flow" }] });
    expect(failure(await call("klaus_history_list", { flow: "x\ny" })).error).toContain(
      "flow is invalid",
    );
  });

  it("klaus_history_show: run の全エントリを返し、不明な runId・不正な runId は失敗にする", async () => {
    const { runId } = data(await call("klaus_request", { method: "GET", url: `${baseUrl}/ok` }));

    const shown = data(await call("klaus_history_show", { runId }));

    expect(shown.entries).toHaveLength(1);
    expect(shown.entries[0].response.body).toEqual({ ok: true });
    expect(failure(await call("klaus_history_show", { runId: "no-such-run" })).error).toContain(
      "no history entries found",
    );
    expect(failure(await call("klaus_history_show", { runId: "bad id!" })).error).toContain(
      "not a valid run ID",
    );
  });

  it("klaus_history_show: path で履歴エントリの一部だけを返し、offset / length で 300 KiB 超の本文を窓に区切って完全に読み戻せる", async () => {
    const { runId } = data(await call("klaus_request", { method: "GET", url: `${baseUrl}/big` }));
    expect(Buffer.byteLength(BIG_TEXT, "utf8")).toBeGreaterThan(300 * 1024);

    // 全体を読むと切り詰められ、印は path・offset・length での読み方を示す
    const whole = await call("klaus_history_show", { runId, step: "request" });
    const wholeText = serializeOutcome(whole).text;
    expect(wholeText).toContain("klaus_history_show: pass step and path");
    expect(wholeText).toContain("offset and length");

    // path だけなら、選んだ値が(必要なら印つきで)返る
    const status = data(
      await call("klaus_history_show", { runId, step: "request", path: "$.response.status" }),
    );
    expect(status.entries).toEqual([{ matchCount: 1, matches: [200] }]);

    // 窓で読み進めて、元の本文に完全に一致することを確認する
    let text = "";
    let offset = 0;
    let windows = 0;
    for (;;) {
      const outcome = await call("klaus_history_show", {
        runId,
        step: "request",
        path: "$.response.body",
        offset,
        ...(windows === 0 ? {} : { length: 40000 }),
      });
      // 窓の結果は、結果の上限(256 KiB)に収まり、切り詰められない
      const serialized = serializeOutcome(outcome).text;
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES);
      expect(serialized).not.toContain("[truncated:");
      expect(serialized).not.toContain("resultTruncated");
      const window = data(outcome).entries[0].window;
      expect(window.totalLength).toBe(BIG_TEXT.length);
      text += window.text;
      windows += 1;
      if (window.nextOffset === undefined) break;
      expect(window.nextOffset).toBe(window.offset + window.length);
      offset = window.nextOffset;
    }
    expect(windows).toBeGreaterThan(1);
    expect(text).toBe(BIG_TEXT);
  });

  it("klaus_history_show: 最大の length の窓は、JSON のエスケープで 6 倍に膨らむ制御文字だけの本文でも結果の上限に収まる", async () => {
    await appendHistory(cwd, {
      v: 1,
      runId: "ctl-run",
      flow: "(single)",
      step: "request",
      startedAt: new Date().toISOString(),
      durationMs: 1,
      status: "passed",
      source: "single",
      request: { method: "GET", url: `${baseUrl}/x`, headers: {} },
      response: { status: 200, headers: {}, body: "\u0001".repeat(100_000) },
      assertions: [],
    });

    const outcome = await call("klaus_history_show", {
      runId: "ctl-run",
      step: "request",
      path: "$.response.body",
      offset: 0,
      length: 40000,
    });

    const text = serializeOutcome(outcome).text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(text).not.toContain("resultTruncated");
    expect(data(outcome).entries[0].window).toMatchObject({ length: 40000, nextOffset: 40000 });
  });

  it("klaus_history_show: offset / length / path の誤用は失敗にする(step なしの path、path なしの offset、文字列でない値、不正な path、範囲外の length)", async () => {
    const { runId } = data(await call("klaus_request", { method: "GET", url: `${baseUrl}/ok` }));

    expect(
      failure(await call("klaus_history_show", { runId, path: "$.response.body" })).error,
    ).toContain("path requires step");
    expect(
      failure(await call("klaus_history_show", { runId, step: "request", offset: 0 })).error,
    ).toContain("offset and length require path");
    // body は JSON のオブジェクトなので窓では読めない(path で絞る)
    const notString = failure(
      await call("klaus_history_show", {
        runId,
        step: "request",
        path: "$.response.body",
        offset: 0,
      }),
    );
    expect(notString.error).toContain("exactly one string value");
    expect(notString.hint).toContain("Narrow path");
    expect(
      failure(
        await call("klaus_history_show", { runId, step: "request", path: "$.nothing", offset: 0 }),
      ).error,
    ).toContain("matched 0 value(s)");
    expect(
      failure(await call("klaus_history_show", { runId, step: "request", path: "$[?(" })).error,
    ).toContain("invalid path");
    // length は上限を超えられない(スキーマで拒否される)
    expect(() =>
      TOOL_DEFINITIONS.find((tool) => tool.name === "klaus_history_show")?.inputSchema.parse({
        runId,
        step: "request",
        path: "$.response.body",
        length: 40001,
      }),
    ).toThrow();
    // 一致しない path は、空の matches で返る(失敗にしない)
    expect(
      data(await call("klaus_history_show", { runId, step: "request", path: "$.nothing" })).entries,
    ).toEqual([{ matchCount: 0, matches: [] }]);
  });

  it("klaus_diff_runs: 2 つの run の差分を返し、latest / previous は flow を要求する", async () => {
    await writeProjectFile("api/snap.yaml", getFlow("snap flow", "/snap"));
    await call("klaus_run_flow", { file: "api/snap.yaml" });
    snapBody = { id: 1, name: "bob" };
    await call("klaus_run_flow", { file: "api/snap.yaml" });

    const diff = data(
      await call("klaus_diff_runs", { a: "previous", b: "latest", flow: "snap flow" }),
    );
    const ignored = data(
      await call("klaus_diff_runs", {
        a: "previous",
        b: "latest",
        flow: "snap flow",
        ignorePaths: ["$.name"],
      }),
    );

    expect(diff.status).toBe("different");
    expect(diff.steps[0].body.differences[0]).toMatchObject({ before: "alice", after: "bob" });
    expect(ignored.status).toBe("same");
    expect(failure(await call("klaus_diff_runs", { a: "latest", b: "previous" })).error).toContain(
      "requires flow",
    );
    expect(
      failure(await call("klaus_diff_runs", { a: "x1", b: "x2", ignorePaths: ["not a path"] }))
        .error,
    ).toContain("invalid ignorePaths");
  });
});

describe("スナップショットの承認", () => {
  async function runMismatch(): Promise<{ runId: string; snapshotFile: string; key: string }> {
    await writeProjectFile(
      "api/snap.yaml",
      getFlow("snap flow", "/snap", "    assert:\n      snapshot: true\n"),
    );
    await call("klaus_run_flow", { file: "api/snap.yaml" });
    snapBody = { id: 1, name: "bob" };
    const run = data(await call("klaus_run_flow", { file: "api/snap.yaml" }));
    const snapshot = run.flows[0].steps[0].snapshot;
    return { runId: run.runId, snapshotFile: snapshot.file, key: snapshot.key };
  }

  it("承認待ちを一覧し、その組だけを承認して基準を更新できる。candidate は step を指定したときだけ履歴に含まれる", async () => {
    const pair = await runMismatch();

    const listed = data(await call("klaus_snapshot_list", { runId: pair.runId }));
    const withoutStep = data(await call("klaus_history_show", { runId: pair.runId }));
    const withStep = data(await call("klaus_history_show", { runId: pair.runId, step: "get" }));
    const wrongKey = failure(await call("klaus_snapshot_accept", { ...pair, key: "other" }));
    const accepted = data(await call("klaus_snapshot_accept", pair));
    const rerun = data(await call("klaus_run_flow", { file: "api/snap.yaml" }));

    expect(listed.mismatches).toHaveLength(1);
    expect(listed.mismatches[0]).toMatchObject({ ...pair, state: "mismatch", differenceCount: 1 });
    expect(listed.acceptRefusal).toBeUndefined();
    expect(JSON.stringify(withoutStep)).not.toContain("candidate");
    expect(withStep.entries[0].assertions[0].snapshot.candidate).toBeDefined();
    expect(wrongKey.error).toContain("has no pending snapshot");
    expect(accepted).toMatchObject({ accepted: true, state: "updated" });
    expect(rerun.flows[0].steps[0].snapshot.state).toBe("matched");
  });

  it("保護環境で実行された run と、他のアサーションが失敗したステップの承認は拒否される", async () => {
    await writeProjectFile("environments/stg.yaml", `$protected: readonly\nbaseUrl: ${baseUrl}\n`);
    await writeProjectFile(
      "api/stg.yaml",
      'name: stg flow\nsteps:\n  - name: get\n    request:\n      method: GET\n      url: "{{baseUrl}}/snap"\n    assert:\n      snapshot: true\n',
    );
    await writeProjectFile(
      "api/failed.yaml",
      getFlow("failed flow", "/snap", "    assert:\n      status: 201\n      snapshot: true\n"),
    );
    const stg = data(await call("klaus_run_flow", { file: "api/stg.yaml", env: "stg" }));
    const failed = data(await call("klaus_run_flow", { file: "api/failed.yaml" }));
    const stgPair = {
      runId: stg.runId,
      snapshotFile: stg.flows[0].steps[0].snapshot.file,
      key: stg.flows[0].steps[0].snapshot.key,
    };
    const failedPair = {
      runId: failed.runId,
      snapshotFile: failed.flows[0].steps[0].snapshot.file,
      key: failed.flows[0].steps[0].snapshot.key,
    };

    const listed = data(await call("klaus_snapshot_list", { runId: stgPair.runId }));
    const protectedRefusal = failure(await call("klaus_snapshot_accept", stgPair));
    const failedStep = failure(await call("klaus_snapshot_accept", failedPair));

    expect(stg.flows[0].steps[0].snapshot.state).toBe("missing");
    expect(listed.acceptRefusal).toContain("is protected");
    expect(protectedRefusal.error).toContain("is protected");
    expect(protectedRefusal.hint).toContain("klaus snapshot accept");
    expect(failedStep.error).toContain("other assertions failed");
  });
});

describe("klaus_promote", () => {
  async function recordRequest(): Promise<string> {
    const result = data(
      await call("klaus_request", {
        method: "POST",
        url: `${baseUrl}/items`,
        headers: { Authorization: "Bearer abcdefghijklmnop1234567890" },
        body: { name: "a" },
      }),
    );
    return result.runId as string;
  }

  it("履歴の run から新しいフローを書き、ユーザーが埋める TODO_* のプレースホルダーを返す。同じ出力先への 2 回目は拒否する", async () => {
    const runId = await recordRequest();

    const written = data(await call("klaus_promote", { runIds: [runId], out: "flows/items.yaml" }));
    const content = await readFile(join(cwd, "flows", "items.yaml"), "utf-8");
    const again = failure(
      await call("klaus_promote", { runIds: [runId], out: "flows/items.yaml" }),
    );

    expect(written).toMatchObject({
      written: true,
      file: "flows/items.yaml",
      validation: { valid: true },
    });
    expect(written.placeholders[0].name).toMatch(/^TODO_/);
    expect(written.yaml).toBe(content);
    expect(content).not.toContain("abcdefghijklmnop1234567890");
    const validated = data(await call("klaus_validate_flow", { file: "flows/items.yaml" }));
    expect(validated.valid).toBe(true);
    expect(again.error).toContain("never overwrites");
    expect(await readFile(join(cwd, "flows", "items.yaml"), "utf-8")).toBe(content);
  });

  it("出力先は api/・flows/・既にフローがあるディレクトリの .yaml/.yml に限る", async () => {
    const runId = await recordRequest();
    await writeProjectFile("custom/seed.yaml", getFlow("seed", "/ok"));

    for (const out of [
      "docs/x.yaml",
      "environments/x.yaml",
      "../x.yaml",
      join(base, "x.yaml"),
      "flows/x.txt",
      "klaus.config.yaml",
      "flows/.hidden/x.yaml",
      "flows\\x.yaml",
    ]) {
      const refused = failure(await call("klaus_promote", { runIds: [runId], out }));
      expect(refused.errorCode, out).toBe("guard.path");
    }
    const allowed = data(await call("klaus_promote", { runIds: [runId], out: "custom/new.yml" }));

    expect(allowed.file).toBe("custom/new.yml");
    expect(await readdir(join(cwd, "custom"))).toEqual(["new.yml", "seed.yaml"]);
    await expect(stat(join(cwd, "docs"))).rejects.toThrow();
  });

  it("記録された値にリテラルの {{ が含まれる run は、許可する手段が無く拒否される", async () => {
    await appendHistory(cwd, {
      v: 1,
      runId: "tl-run",
      flow: "(single)",
      step: "request",
      startedAt: new Date().toISOString(),
      durationMs: 1,
      status: "passed",
      source: "single",
      request: { method: "GET", url: `${baseUrl}/x?q={{oops}}`, headers: {} },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { ok: true },
      },
      assertions: [],
    });

    const refused = failure(
      await call("klaus_promote", { runIds: ["tl-run"], out: "flows/tl.yaml" }),
    );

    expect(refused.error).toContain('literal "{{"');
    expect(refused.hint).toContain("cannot be promoted through klaus mcp");
    await expect(stat(join(cwd, "flows", "tl.yaml"))).rejects.toThrow();
  });
});

describe("書き込みツールと --read-only", () => {
  it("書き込みツールは klaus_promote と klaus_snapshot_accept だけで、readOnly の文脈ではハンドラも拒否する", async () => {
    const writeTools = TOOL_DEFINITIONS.filter((tool) => tool.write).map((tool) => tool.name);
    const runId = "any-run";

    const promote = failure(
      await call(
        "klaus_promote",
        { runIds: [runId], out: "flows/x.yaml" },
        ctx({ readOnly: true }),
      ),
    );
    const accept = failure(
      await call(
        "klaus_snapshot_accept",
        { runId, snapshotFile: "a/__snapshots__/b.snap.json", key: "k" },
        ctx({ readOnly: true }),
      ),
    );

    expect(writeTools).toEqual(["klaus_promote", "klaus_snapshot_accept"]);
    expect(promote.error).toContain("--read-only");
    expect(accept.error).toContain("--read-only");
  });
});

describe("resolveMcpActor", () => {
  it("kind は常に agent。名前は initialize のクライアント名 > 環境変数のマーカー > mcp の順で決める", () => {
    expect(resolveMcpActor("claude-code", { CLAUDECODE: "1" })).toEqual({
      kind: "agent",
      name: "claude-code",
    });
    expect(resolveMcpActor("Cursor", {})).toEqual({ kind: "agent", name: "Cursor" });
    expect(resolveMcpActor(undefined, { AI_AGENT: "some-agent" })).toEqual({
      kind: "agent",
      name: "some-agent",
    });
    expect(resolveMcpActor(undefined, {})).toEqual({ kind: "agent", name: "mcp" });
    // CI 環境でも kind は agent のまま(CI は agent の名前の根拠にしない)
    expect(resolveMcpActor(undefined, { CI: "true" })).toEqual({ kind: "agent", name: "mcp" });
  });

  it("クライアントが申告した名前の制御文字は除き、長さを制限する。空になれば無視する", () => {
    expect(resolveMcpActor("evil\nname\u0007", {}).name).toBe("evilname");
    expect(resolveMcpActor("x".repeat(500), {}).name).toHaveLength(100);
    expect(resolveMcpActor("  \n ", {}).name).toBe("mcp");
  });
});
