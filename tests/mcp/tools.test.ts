import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  appendHistory,
  executeSingleRequest,
  flowSchema,
  readAllHistoryEntries,
  runLoadedFlows,
} from "../../src/core/index.js";
import {
  MAX_RESULT_BYTES,
  serializeOutcome,
  type ToolFailure,
  type ToolOutcome,
} from "../../src/mcp/result.js";
import { resolveMcpActor, TOOL_DEFINITIONS, type ToolContext } from "../../src/mcp/tools.js";
import { closeServer, listenEphemeral, reserveClosedPort } from "../support/net.js";

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
});

const PROTECTED_SECRET = "s3cr3t-db-pass-7d2f";
const PROTECTED_USER = "db-admin-user-91";

/** ro(readonly)・prod(true)・dev(保護なし)の環境ファイルを書く。値には接続先(fixture のホスト)と資格情報を含める */
async function writeProtectedEnvironments(protectedHost = baseUrl): Promise<void> {
  await writeProjectFile(
    "environments/ro.yaml",
    `$protected: readonly\nbaseUrl: ${protectedHost}\ndbPassword: ${PROTECTED_SECRET}\ndbUser: ${PROTECTED_USER}\nshort: q9\n`,
  );
  await writeProjectFile(
    "environments/prod.yaml",
    `$protected: true\nbaseUrl: ${protectedHost}\ndbPassword: ${PROTECTED_SECRET}\ndbUser: ${PROTECTED_USER}\nshort: q9\n`,
  );
  await writeProjectFile(
    "environments/dev.yaml",
    `baseUrl: ${baseUrl}\ndbPassword: dev-visible-password\ndbUser: dev-visible-user\nshort: q9\n`,
  );
}

/** .klaus/history のファイルの内容を連結して返す */
async function historyText(): Promise<string> {
  const dir = join(cwd, ".klaus", "history");
  const names = await readdir(dir);
  return (await Promise.all(names.map((name) => readFile(join(dir, name), "utf-8")))).join("\n");
}

function expectNoProtectedValues(text: string): void {
  for (const value of [PROTECTED_SECRET, PROTECTED_USER, baseUrl, new URL(baseUrl).host]) {
    expect(text).not.toContain(value);
  }
}

describe("保護された環境の値の秘匿", () => {
  const flowWithEnv = (extraHeaders = "") =>
    `name: attack\nsteps:\n  - name: get\n    request:\n      method: GET\n      url: "{{baseUrl}}/echo-auth"\n      headers:\n        Authorization: "Bearer {{dbPassword}}"\n        X-Db: "{{dbUser}}"\n        X-Short: "{{short}}"\n${extraHeaders}`;

  it("klaus_dry_run {env: ro}: 展開後の URL(ホストも)と資格情報は *** になり、安全柵の判定と errorCode は残る。4 文字未満の値は隠れない", async () => {
    await writeProtectedEnvironments();
    await writeProjectFile("api/attack.yaml", flowWithEnv());
    await writeProjectFile("klaus.config.yaml", "guard:\n  allowedHosts:\n    - example.com\n");

    const outcome = await call("klaus_dry_run", { file: "api/attack.yaml", env: "ro" });

    const text = serializeOutcome(outcome).text;
    expectNoProtectedValues(text);
    const step = data(outcome).flows[0].steps[0];
    expect(step.request.url).toBe("***/echo-auth");
    expect(step.request.headers["X-Db"]).toBe("***");
    expect(step.guard).toMatchObject({ status: "refused", errorCode: "guard.allowed-hosts" });
    // 短すぎる値(4 文字未満)は、出力を壊さないよう置換されず、そのまま見える
    expect(step.request.headers["X-Short"]).toBe("q9");
    expect(received).toHaveLength(0);
  });

  it("klaus_dry_run {env: prod}: 保護(true)で拒否されたステップでも値は隠れ、errorCode は残る", async () => {
    await writeProtectedEnvironments();
    await writeProjectFile("api/attack.yaml", flowWithEnv());

    const outcome = await call("klaus_dry_run", { file: "api/attack.yaml", env: "prod" });

    expectNoProtectedValues(serializeOutcome(outcome).text);
    expect(data(outcome).flows[0].steps[0].guard.errorCode).toBe("guard.protected");
  });

  it("保護されていない環境(dev)の値は従来どおり展開されて表示される", async () => {
    await writeProtectedEnvironments("http://protected.example.invalid:1234");
    await writeProjectFile("api/attack.yaml", flowWithEnv());

    const step = data(await call("klaus_dry_run", { file: "api/attack.yaml", env: "dev" })).flows[0]
      .steps[0];

    expect(step.request.url).toBe(`${baseUrl}/echo-auth`);
    expect(step.request.headers.Authorization).toBe("Bearer dev-visible-password");
  });

  it("klaus_request {env: prod} の拒否は、結果にも .klaus/history にも環境の値を残さない", async () => {
    await writeProtectedEnvironments();

    const refused = await call("klaus_request", {
      method: "GET",
      url: "{{baseUrl}}/ok",
      headers: { "X-Db": "{{dbPassword}}" },
      env: "prod",
    });

    expect(failure(refused).errorCode).toBe("guard.protected");
    expectNoProtectedValues(serializeOutcome(refused).text);
    const history = await historyText();
    expect(history).toContain("guard.protected");
    expectNoProtectedValues(history);
    expect(received).toHaveLength(0);
  });

  it("許可リストによる拒否のメッセージ(ホスト名を含む)にも、保護された環境の値を残さない", async () => {
    await writeProtectedEnvironments();
    await writeProjectFile("klaus.config.yaml", "guard:\n  allowedHosts:\n    - example.com\n");

    const refused = await call("klaus_request", {
      method: "GET",
      url: "{{baseUrl}}/ok",
      env: "ro",
    });

    expect(failure(refused).errorCode).toBe("guard.allowed-hosts");
    expectNoProtectedValues(serializeOutcome(refused).text);
    expectNoProtectedValues(await historyText());
  });

  it("klaus_run_flow {env: ro}(GET は通る): 応答のエコー・要約・履歴のすべてで環境の値が隠れる", async () => {
    await writeProtectedEnvironments();
    await writeProjectFile("api/attack.yaml", flowWithEnv());

    const outcome = await call("klaus_run_flow", { file: "api/attack.yaml", env: "ro" });

    expect(received).toHaveLength(1);
    expect(data(outcome).flows[0].steps[0]).toMatchObject({ status: "passed" });
    expectNoProtectedValues(serializeOutcome(outcome).text);
    const history = await historyText();
    expect(history).toContain("***");
    expectNoProtectedValues(history);
    // 応答(Authorization のエコー)も、履歴から読んで隠れている
    const shown = await call("klaus_history_show", {
      runId: data(outcome).runId,
      step: "get",
    });
    expectNoProtectedValues(serializeOutcome(shown).text);
    expect(data(shown).entries[0].response.body).toEqual({ authorization: "Bearer ***" });
  });

  it("klaus_request {env: ro}: 結果の URL・応答・履歴で環境の値が隠れる", async () => {
    await writeProtectedEnvironments();

    const outcome = await call("klaus_request", {
      method: "GET",
      url: "{{baseUrl}}/echo-auth",
      headers: { Authorization: "Bearer {{dbPassword}}" },
      env: "ro",
    });

    const result = data(outcome);
    expect(result.request.url).toBe("***/echo-auth");
    expect(result.response.body).toEqual({ authorization: "Bearer ***" });
    expectNoProtectedValues(serializeOutcome(outcome).text);
    expectNoProtectedValues(await historyText());
  });

  describe("CLI などが先に記録した履歴の読み出し", () => {
    /** MCP の外(CLI と同じ、環境の値を秘密として登録しない経路)で、保護された環境に対する単発リクエストを記録する */
    async function recordLikeCli(envName: string): Promise<string> {
      const { runId } = await executeSingleRequest({
        request: {
          method: "GET",
          url: "{{baseUrl}}/echo-auth",
          headers: { Authorization: "Bearer {{dbPassword}}" },
        },
        cwd,
        envName,
        history: true,
      });
      return runId;
    }

    it("klaus_history_show / klaus_history_list / klaus_diff_runs の出力から、現在保護されている環境の値が隠れる(CLI が生の値で記録していても)", async () => {
      await writeProtectedEnvironments();
      // 保護を付ける前の環境で記録した、という状況を作る: dev で記録してから dev を保護に変える
      await writeProjectFile(
        "environments/dev.yaml",
        `baseUrl: ${baseUrl}\ndbPassword: ${PROTECTED_SECRET}\ndbUser: ${PROTECTED_USER}\n`,
      );
      const runA = await recordLikeCli("dev");
      const runB = await recordLikeCli("dev");
      expect(await historyText()).toContain(PROTECTED_SECRET.slice(0, 6));
      await writeProjectFile(
        "environments/dev.yaml",
        `$protected: true\nbaseUrl: ${baseUrl}\ndbPassword: ${PROTECTED_SECRET}\ndbUser: ${PROTECTED_USER}\n`,
      );

      const shown = await call("klaus_history_show", { runId: runA });
      const step = await call("klaus_history_show", { runId: runA, step: "request" });
      const window = await call("klaus_history_show", {
        runId: runA,
        step: "request",
        path: "$.request.url",
        offset: 0,
        length: 20,
      });
      const list = await call("klaus_history_list", {});
      const diff = await call("klaus_diff_runs", { a: runA, b: runB });

      for (const outcome of [shown, step, window, list, diff]) {
        expectNoProtectedValues(serializeOutcome(outcome).text);
      }
      expect(data(shown).entries[0].request.url).toBe("***/echo-auth");
      expect(data(window).entries[0].window.text).toBe("***/echo-auth");
    });

    it("保護されていない環境で記録した履歴は、そのまま読める(他の環境が保護されていても、その値と一致しない部分は隠れない)", async () => {
      await writeProtectedEnvironments("http://protected.example.invalid:1234");
      const runId = await recordLikeCli("dev");

      const shown = data(await call("klaus_history_show", { runId }));

      expect(shown.entries[0].request.url).toBe(`${baseUrl}/echo-auth`);
    });

    it("klaus_promote: 保護された環境に対して記録された run は拒否し、フロー自身の env で記録された run は値を TODO のプレースホルダーに置き換える", async () => {
      await writeProtectedEnvironments();
      const recorded = await recordLikeCli("ro");

      const refused = failure(
        await call("klaus_promote", { runIds: [recorded], out: "flows/from-ro.yaml" }),
      );

      expect(refused.errorCode).toBe("guard.protected");
      expect(refused.error).toContain('protected environment "ro"');
      await expect(stat(join(cwd, "flows", "from-ro.yaml"))).rejects.toThrow();

      // フロー自身の env: ro で実行した run も、履歴の env が ro なので拒否される
      const flowRun = await runLoadedFlows(
        [
          {
            filePath: join(cwd, "api", "own-env.yaml"),
            flow: flowSchema.parse({
              name: "own env",
              env: "ro",
              steps: [
                {
                  name: "get",
                  request: { method: "GET", url: "{{baseUrl}}/echo-auth" },
                },
              ],
            }),
          },
        ],
        { cwd, history: true },
      );
      const ownEnv = failure(
        await call("klaus_promote", { runIds: [flowRun.runId], out: "flows/from-own-env.yaml" }),
      );
      expect(ownEnv.errorCode).toBe("guard.protected");

      // env が記録されていない run(--var 相当で同じ値を渡した)でも、保護された環境の値は昇格の前に隠れ、
      // 生成物では TODO_* のプレースホルダーになる
      const { runId: varRun } = await executeSingleRequest({
        request: { method: "GET", url: "{{baseUrl}}/echo-auth" },
        cwd,
        variables: { baseUrl },
        history: true,
      });
      const promoted = await call("klaus_promote", {
        runIds: [varRun],
        out: "flows/from-vars.yaml",
      });

      expectNoProtectedValues(serializeOutcome(promoted).text);
      const yaml = await readFile(join(cwd, "flows", "from-vars.yaml"), "utf-8");
      expectNoProtectedValues(yaml);
      expect(yaml).toContain("TODO_");
    });
  });

  it("klaus_validate_flow に環境ファイルのパスを渡しても、値は返さない(キー名だけ)", async () => {
    await writeProtectedEnvironments();

    const outcome = await call("klaus_validate_flow", { file: "environments/ro.yaml" });

    const text = serializeOutcome(outcome).text;
    expectNoProtectedValues(text);
  });
});

describe("保護された環境で書かれた履歴の読み出し(値を隠せないときは中身を出さない)", () => {
  /** 環境ファイルを environments/ の外(secrets/)に置き、CLI と同じ経路(値を秘密として登録しない)で 1 回実行して run ID を返す */
  async function recordVault(): Promise<string> {
    await writeProjectFile(
      "secrets/vault.yaml",
      `$protected: true\nbaseUrl: ${baseUrl}\ndbPassword: ${PROTECTED_SECRET}\ndbUser: ${PROTECTED_USER}\n`,
    );
    const { runId } = await runLoadedFlows(
      [
        {
          filePath: join(cwd, "api", "vault.yaml"),
          flow: flowSchema.parse({
            name: "vault flow",
            steps: [
              {
                name: "get",
                request: {
                  method: "GET",
                  url: "{{baseUrl}}/echo-auth",
                  headers: { Authorization: "Bearer {{dbPassword}}" },
                },
              },
            ],
          }),
        },
      ],
      { cwd, envFilePath: join(cwd, "secrets", "vault.yaml"), allowProtected: true, history: true },
    );
    return runId;
  }

  function expectWithheld(outcome: ToolOutcome, marker = "withheld"): void {
    const text = serializeOutcome(outcome).text;
    expectNoProtectedValues(text);
    expect(text).not.toContain("echo-auth");
    expect(text).toContain(marker);
    expect(text).toContain("klaus history show");
  }

  it("environments/ の外の --env-file で記録された run: show・list・diff・snapshot_list は中身を出さず、promote は拒否する(CLI が記録した生の値は履歴に残る)", async () => {
    const runA = await recordVault();
    const runB = await recordVault();
    // CLI の経路で記録されているので、履歴ファイルには生の値が残っている(MCP が隠すのは返す出力)
    expect(await historyText()).toContain(PROTECTED_SECRET);
    await writeProjectFile(
      "api/snap.yaml",
      'name: snap flow\nsteps:\n  - name: get\n    request:\n      method: GET\n      url: "{{baseUrl}}/snap"\n    assert:\n      snapshot: true\n',
    );
    const snapRun = await runLoadedFlows(
      [
        {
          filePath: join(cwd, "api", "snap.yaml"),
          flow: flowSchema.parse({
            name: "snap flow",
            steps: [
              {
                name: "get",
                request: { method: "GET", url: "{{baseUrl}}/snap" },
                assert: { snapshot: true },
              },
            ],
          }),
        },
      ],
      {
        cwd,
        envFilePath: join(cwd, "secrets", "vault.yaml"),
        allowProtected: true,
        history: true,
      },
    );

    const shown = await call("klaus_history_show", { runId: runA });
    const shownStep = await call("klaus_history_show", { runId: runA, step: "get" });
    const shownPath = await call("klaus_history_show", {
      runId: runA,
      step: "get",
      path: "$.request.url",
    });
    const shownWindow = await call("klaus_history_show", {
      runId: runA,
      step: "get",
      path: "$.request.url",
      offset: 0,
      length: 10,
    });
    const list = await call("klaus_history_list", {});
    const diff = await call("klaus_diff_runs", { a: runA, b: runB });
    const snapshots = await call("klaus_snapshot_list", { runId: snapRun.runId });
    const promote = await call("klaus_promote", { runIds: [runA], out: "flows/vault.yaml" });

    for (const outcome of [shown, shownStep, shownPath, shownWindow, list, snapshots]) {
      expectWithheld(outcome);
    }
    expectWithheld(diff, "notComparable");
    expect(data(diff).status).toBe("partial");
    // 返るのはメタデータ(run・フロー・ステップ・状態・envProtection)と理由
    expect(data(shown).entries[0]).toMatchObject({
      runId: runA,
      flow: "vault flow",
      step: "get",
      status: "passed",
      env: "vault.yaml",
      envProtection: "protected",
    });
    expect(data(shown).entries[0].request).toBeUndefined();
    expect(data(shownPath).entries[0]).toMatchObject({ matchCount: 0 });
    expect(data(shownPath).entries[0].withheld).toContain("klaus history show");
    expect(data(list).entries[0].withheld).toContain("klaus history show");
    expect(data(diff).notComparable).toEqual([
      expect.objectContaining({ flow: "vault flow", step: "get" }),
    ]);
    expect(data(diff).counts).toEqual({ same: 0, different: 0, added: 0, removed: 0 });
    expect(data(snapshots).mismatches).toEqual([]);
    expect(data(snapshots).withheld).toEqual([
      expect.objectContaining({ flow: "snap flow", step: "get" }),
    ]);
    expect(failure(promote).errorCode).toBe("guard.protected");
    expectNoProtectedValues(serializeOutcome(promote).text);
    await expect(stat(join(cwd, "flows", "vault.yaml"))).rejects.toThrow();
  });

  it("名前付きの保護環境の run は、その環境が今も保護されていれば値を隠して読める。保護が外された・環境が消えたときは中身を出さない", async () => {
    await writeProtectedEnvironments();
    const recorded = async () => {
      const { runId } = await executeSingleRequest({
        request: {
          method: "GET",
          url: "{{baseUrl}}/echo-auth",
          headers: { Authorization: "Bearer {{dbPassword}}" },
        },
        cwd,
        envName: "ro",
        history: true,
      });
      return runId;
    };
    const runId = await recorded();

    const whileProtected = await call("klaus_history_show", { runId });
    expectNoProtectedValues(serializeOutcome(whileProtected).text);
    expect(data(whileProtected).entries[0].request.url).toBe("***/echo-auth");
    expect(data(whileProtected).entries[0].envProtection).toBe("readonly");

    // 保護を外しても、記録時に保護されていた事実が残るので値の根拠にできない(中身を出さない)
    await writeProjectFile("environments/ro.yaml", `baseUrl: ${baseUrl}\ndbPassword: x-visible\n`);
    expectWithheld(await call("klaus_history_show", { runId }));
    expect(
      failure(await call("klaus_promote", { runIds: [runId], out: "flows/a.yaml" })).errorCode,
    ).toBe("guard.protected");

    // 環境ファイルが消えた場合も同じ
    await rm(join(cwd, "environments", "ro.yaml"));
    expectWithheld(await call("klaus_history_show", { runId }));
    expect(
      failure(await call("klaus_promote", { runIds: [runId], out: "flows/b.yaml" })).errorCode,
    ).toBe("guard.protected");
  });

  it("envProtection の無い旧エントリ: 記録された環境が今は読めない・名前として使えないときは中身を出さず、promote は拒否する。読める保護なしの環境なら従来どおり", async () => {
    await writeProjectFile(
      "environments/dev.yaml",
      `baseUrl: ${baseUrl}\ndbPassword: ${PROTECTED_SECRET}\n`,
    );
    await writeProjectFile("secrets/plain.yaml", `baseUrl: ${baseUrl}\n`);
    const record = (options: { envName?: string; envFilePath?: string }) =>
      executeSingleRequest({
        request: {
          method: "GET",
          url: "{{baseUrl}}/echo-auth",
          headers: { "X-Db": "{{dbPassword}}" },
        },
        cwd,
        history: true,
        variables: { dbPassword: PROTECTED_SECRET },
        ...options,
      }).then((result) => result.runId);
    const named = await record({ envName: "dev" });
    const viaFile = await record({ envFilePath: join(cwd, "secrets", "plain.yaml") });
    for (const entry of await readAllHistoryEntries(cwd)) {
      expect(entry).not.toHaveProperty("envProtection");
    }

    // 読める保護なしの環境: 従来どおり(値は一致する部分だけ現在の保護とは無関係に、そのまま)
    expect(data(await call("klaus_history_show", { runId: named })).entries[0].request.url).toBe(
      `${baseUrl}/echo-auth`,
    );
    // --env-file のファイル名は名前として解決できない: 保護の有無を確かめられない
    expectWithheld(await call("klaus_history_show", { runId: viaFile }));
    expect(
      failure(await call("klaus_promote", { runIds: [viaFile], out: "flows/c.yaml" })).error,
    ).toContain("cannot be determined");

    // 環境ファイルが壊れた(読めない)ときは、環境名で記録された旧エントリも出さない
    await writeProjectFile("environments/dev.yaml", "baseUrl: [unclosed\n");
    expectWithheld(await call("klaus_history_show", { runId: named }));
    expect(
      failure(await call("klaus_promote", { runIds: [named], out: "flows/d.yaml" })).error,
    ).toContain("cannot be determined");
    expect(
      data(await call("klaus_history_list", {})).entries.every(
        (row: { withheld?: string }) => row.withheld !== undefined,
      ),
    ).toBe(true);
  });

  it("klaus_request {env: dev}: 別の保護された環境(prod)の値が応答にエコーされても、結果にも MCP が書く履歴にも出ない", async () => {
    await writeProtectedEnvironments();

    const outcome = await call("klaus_request", {
      method: "GET",
      url: "{{baseUrl}}/echo-auth",
      headers: { Authorization: `Bearer ${PROTECTED_SECRET}` },
      env: "dev",
    });
    const flow = `name: leak\nsteps:\n  - name: get\n    request:\n      method: GET\n      url: "{{baseUrl}}/echo-auth"\n      headers:\n        Authorization: "Bearer ${PROTECTED_SECRET}"\n`;
    await writeProjectFile("api/leak.yaml", flow);
    const run = await call("klaus_run_flow", { file: "api/leak.yaml", env: "dev" });
    const dry = await call("klaus_dry_run", { file: "api/leak.yaml", env: "dev" });

    for (const result of [outcome, run, dry]) {
      expect(serializeOutcome(result).text).not.toContain(PROTECTED_SECRET);
    }
    expect(data(outcome).response.body).toEqual({ authorization: "Bearer ***" });
    expect(await historyText()).not.toContain(PROTECTED_SECRET);
    expect(received.length).toBeGreaterThan(0);
  });

  it("保護された値が URL のとき、ホスト名だけ・host:port だけも、拒否メッセージ・dry-run・MCP が書く履歴に出ない", async () => {
    await writeProtectedEnvironments();
    await writeProjectFile("klaus.config.yaml", "guard:\n  allowedHosts:\n    - example.com\n");
    await writeProjectFile(
      "api/hosts.yaml",
      'name: hosts\nsteps:\n  - name: get\n    request:\n      method: GET\n      url: "{{baseUrl}}/ok"\n      headers:\n        X-Host: "{{baseUrl}}"\n',
    );
    const url = new URL(baseUrl);

    const refused = await call("klaus_request", {
      method: "GET",
      url: "{{baseUrl}}/ok",
      env: "ro",
    });
    const dry = await call("klaus_dry_run", { file: "api/hosts.yaml", env: "ro" });
    const ran = await call("klaus_run_flow", { file: "api/hosts.yaml", env: "ro" });

    expect(failure(refused).errorCode).toBe("guard.allowed-hosts");
    for (const outcome of [refused, dry, ran]) {
      const text = serializeOutcome(outcome).text;
      expect(text).not.toContain(url.hostname);
      expect(text).not.toContain(url.host);
      expect(text).not.toContain(url.origin);
    }
    const history = await historyText();
    expect(history).not.toContain(url.hostname);
    expect(history).not.toContain(url.host);
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

  it("履歴に記録されたステップにだけ historyRef を付ける(応答を受けた後の capture 失敗は付き、接続エラーは付かない)", async () => {
    const closedPort = await reserveClosedPort();
    await writeProjectFile(
      "api/capture.yaml",
      `name: capture flow
steps:
  - name: login
    continueOnError: true
    request:
      method: GET
      url: "${baseUrl}/ok"
    capture:
      token: "$.does.not.exist"
  - name: unreachable
    continueOnError: true
    request:
      method: GET
      url: "http://127.0.0.1:${closedPort}/x"
  - name: after
    request:
      method: GET
      url: "${baseUrl}/ok"
`,
    );

    const result = data(await call("klaus_run_flow", { file: "api/capture.yaml" }));

    const [login, unreachable, after] = result.flows[0].steps;
    expect(login).toMatchObject({ name: "login", status: "error" });
    expect(login.historyRef).toEqual({ runId: result.runId, step: "login" });
    expect(unreachable).toMatchObject({ name: "unreachable", status: "error" });
    expect(unreachable).not.toHaveProperty("historyRef");
    expect(after.historyRef).toEqual({ runId: result.runId, step: "after" });
    // historyRef が指すエントリは引け(応答つきの error)、無いステップは引けない
    const shown = data(await call("klaus_history_show", { runId: result.runId, step: "login" }));
    expect(shown.entries[0]).toMatchObject({
      status: "error",
      response: { status: 200, body: { ok: true } },
    });
    expect(
      failure(await call("klaus_history_show", { runId: result.runId, step: "unreachable" })).error,
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

  it("klaus_history_show: path は $・.name・['name']・[n] だけを受け付け、再帰下降・ワイルドカード・スライス・和集合・フィルター・スクリプト式は即座に拒否する", async () => {
    const { runId } = data(await call("klaus_request", { method: "GET", url: `${baseUrl}/ok` }));

    for (const path of [
      "$[",
      "$..a",
      "$..a..a..a..a",
      "$.*",
      "$[?(@.x)]",
      "$[(1+1)]",
      "$[0:2]",
      "$['a','b']",
      "$[-1]",
    ]) {
      const started = performance.now();
      const refused = failure(await call("klaus_history_show", { runId, step: "request", path }));
      expect(refused.error, path).toContain("invalid path");
      expect(refused.error, path).toContain("supported forms are");
      expect(performance.now() - started, path).toBeLessThan(500);
    }
    // 受け付ける形は、0 個か 1 個の値を返す
    const headers = data(
      await call("klaus_history_show", {
        runId,
        step: "request",
        path: "$['response'].headers['content-type']",
      }),
    );
    expect(headers.entries).toEqual([{ matchCount: 1, matches: ["application/json"] }]);
  });

  it("klaus_history_show: 入れ子の深い履歴エントリに 512 文字ほどの有効な path を当てても即座に返る", async () => {
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 199; i++) deep = { a: deep };
    await appendHistory(cwd, {
      v: 1,
      runId: "deep-run",
      flow: "(single)",
      step: "request",
      startedAt: new Date().toISOString(),
      durationMs: 1,
      status: "passed",
      source: "single",
      request: { method: "GET", url: `${baseUrl}/x`, headers: {} },
      response: { status: 200, headers: {}, body: deep },
      assertions: [],
    });
    const path = `$.response.body${".a".repeat(248)}`;
    expect(path.length).toBeGreaterThanOrEqual(500);

    const started = performance.now();
    const outcome = await call("klaus_history_show", { runId: "deep-run", step: "request", path });

    expect(performance.now() - started).toBeLessThan(1000);
    expect(data(outcome).entries).toEqual([{ matchCount: 0, matches: [] }]);
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
    expect(notString.hint).toContain("Point path at a single string");
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
