import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ReqReport } from "../../src/cli/reporters/req.js";
import { type ReqCommandOptions, reqCommand } from "../../src/cli/req.js";
import { historyFilePath } from "../../src/core/history.js";
import { closeServer, listenEphemeral, reserveClosedPort } from "../support/net.js";

const projectRoot = join(__dirname, "..", "..");
const tmpRoot = join(projectRoot, "tmp");

/** 受け取ったリクエストをそのまま返すローカル fixture(+ ステータス指定・長大ボディ・SSE) */
async function startFixtureServer() {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/status/500") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      if (req.url === "/big") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("x".repeat(2000));
        return;
      }
      if (req.url === "/sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end("data: one\n\ndata: two\n\n");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        }),
      );
    });
  });
  const { baseUrl } = await listenEphemeral(server);
  return { server, baseUrl };
}

describe("reqCommand", () => {
  let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
  let workDir: string;
  let stdoutSpy: string[];
  let stderrSpy: string[];
  let stdoutWriteSpy: typeof process.stdout.write;
  let stderrWriteSpy: typeof process.stderr.write;
  let isTtySpy: boolean | undefined;

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await closeServer(fixture.server);
  });

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    workDir = await mkdtemp(join(tmpRoot, "klaus-req-"));
    stdoutSpy = [];
    stderrSpy = [];
    stdoutWriteSpy = process.stdout.write;
    stderrWriteSpy = process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutSpy.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrSpy.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    // 非 TTY を強制し、JSON 出力経路を通す(実 CI 環境の isTTY 値に依存させない)
    isTtySpy = process.stdout.isTTY;
    process.stdout.isTTY = undefined as unknown as true;
  });

  afterEach(async () => {
    process.stdout.write = stdoutWriteSpy;
    process.stderr.write = stderrWriteSpy;
    process.stdout.isTTY = isTtySpy as true;
    await rm(workDir, { recursive: true, force: true });
  });

  /** テストでは「存在する前提」で読むため、省略可能フィールドも含めて必須として扱う */
  function readJson(): { [K in keyof ReqReport]-?: NonNullable<ReqReport[K]> } {
    return JSON.parse(stdoutSpy.join(""));
  }

  /** fixture が JSON ボディとして返したエコー内容 */
  function readEcho(): {
    method: string;
    url: string;
    headers: Record<string, string | undefined>;
    body: string;
  } {
    return JSON.parse(readJson().response.body ?? "");
  }

  function opts(overrides: Partial<ReqCommandOptions> = {}): ReqCommandOptions {
    return { history: false, mask: true, ...overrides };
  }

  it("GET が成功したら exit 0 で、version 1 の JSON(request / response)を出力する", async () => {
    const code = await reqCommand("GET", `${fixture.baseUrl}/ping`, opts(), workDir);

    expect(code).toBe(0);
    const report = readJson();
    expect(report.version).toBe(1);
    expect(report.status).toBe("passed");
    expect(report.request).toMatchObject({ method: "GET", url: `${fixture.baseUrl}/ping` });
    expect(report.response.status).toBe(200);
    expect(readEcho()).toMatchObject({ method: "GET", url: "/ping" });
    // --no-history 相当のため historyRef は付かない
    expect(report).not.toHaveProperty("historyRef");
  });

  it("ヘッダー・クエリ・JSON ボディを送信し、メソッドは大文字化される", async () => {
    const code = await reqCommand(
      "post",
      `${fixture.baseUrl}/items?page=1`,
      opts({
        header: { "X-Trace": "abc" },
        query: { page: "2", q: "klaus" },
        body: '{"name":"a"}',
      }),
      workDir,
    );

    expect(code).toBe(0);
    const echo = readEcho();
    expect(echo.method).toBe("POST");
    const received = new URL(echo.url, "http://127.0.0.1");
    expect(received.searchParams.get("page")).toBe("2");
    expect(received.searchParams.get("q")).toBe("klaus");
    expect(echo.headers["x-trace"]).toBe("abc");
    expect(echo.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(echo.body)).toEqual({ name: "a" });
  });

  it("JSON として不正な --body は生の文字列として送られ、Content-Type は補われない", async () => {
    await reqCommand("POST", `${fixture.baseUrl}/raw`, opts({ body: "plain text" }), workDir);

    const echo = readEcho();
    expect(echo.body).toBe("plain text");
    expect(echo.headers["content-type"]).toBeUndefined();
  });

  it("--body @file は cwd 配下のファイルを読み、JSON ならパースして送る", async () => {
    await writeFile(join(workDir, "body.json"), '{"from":"file"}\n', "utf-8");

    await reqCommand("POST", `${fixture.baseUrl}/f`, opts({ body: "@body.json" }), workDir);

    expect(JSON.parse(readEcho().body)).toEqual({ from: "file" });
  });

  it("--body @file が JSON でなければファイルの内容を生の文字列として送る", async () => {
    await writeFile(join(workDir, "body.txt"), "<xml/>", "utf-8");

    await reqCommand("POST", `${fixture.baseUrl}/f`, opts({ body: "@body.txt" }), workDir);

    expect(readEcho().body).toBe("<xml/>");
  });

  it("--body @file が cwd の外を指す場合は exit 2 で何も送信しない", async () => {
    const code = await reqCommand(
      "POST",
      `${fixture.baseUrl}/f`,
      opts({ body: "@../outside.json" }),
      workDir,
    );

    expect(code).toBe(2);
    expect(stdoutSpy.join("")).toBe("");
    expect(stderrSpy.join("")).toContain("outside the current directory");
  });

  it("--body @file のファイルが存在しない場合は exit 2", async () => {
    const code = await reqCommand(
      "POST",
      `${fixture.baseUrl}/f`,
      opts({ body: "@missing.json" }),
      workDir,
    );

    expect(code).toBe(2);
    expect(stderrSpy.join("")).toContain("failed to read --body file");
  });

  it("HTTP 500 を受信しても応答が得られたので exit 0(アサーションが無いため)", async () => {
    const code = await reqCommand("GET", `${fixture.baseUrl}/status/500`, opts(), workDir);

    expect(code).toBe(0);
    const report = readJson();
    expect(report.status).toBe("passed");
    expect(report.response.status).toBe(500);
  });

  it("接続不能は exit 3 で、status: error と error メッセージを出力する", async () => {
    const closedPort = await reserveClosedPort();

    const code = await reqCommand("GET", `http://127.0.0.1:${closedPort}/`, opts(), workDir);

    expect(code).toBe(3);
    const report = readJson();
    expect(report.status).toBe("error");
    expect(report.error).toContain("request failed");
    expect(report).not.toHaveProperty("response");
  });

  it("未解決のテンプレート変数は exit 3", async () => {
    const code = await reqCommand("GET", "{{missing}}/x", opts(), workDir);

    expect(code).toBe(3);
    expect(readJson().error).toContain('template variable "missing"');
  });

  it("-e / --env-file / --var の値が URL・ヘッダー・ボディのテンプレートに展開され、--var が環境の値を上書きする", async () => {
    await mkdir(join(workDir, "environments"), { recursive: true });
    await writeFile(
      join(workDir, "environments", "local.yaml"),
      `baseUrl: ${fixture.baseUrl}\ntenant: from-env\n`,
      "utf-8",
    );
    await writeFile(
      join(workDir, "custom.yaml"),
      `baseUrl: ${fixture.baseUrl}\ntenant: from-file\n`,
      "utf-8",
    );
    const template = {
      header: { "X-Tenant": "{{tenant}}" },
      body: '{"tenant":"{{tenant}}"}',
    };

    await reqCommand("POST", "{{baseUrl}}/a", opts({ ...template, env: "local" }), workDir);
    expect(readEcho().headers["x-tenant"]).toBe("from-env");
    expect(JSON.parse(readEcho().body)).toEqual({ tenant: "from-env" });

    stdoutSpy.length = 0;
    await reqCommand(
      "POST",
      "{{baseUrl}}/a",
      opts({ ...template, envFile: "custom.yaml" }),
      workDir,
    );
    expect(readEcho().headers["x-tenant"]).toBe("from-file");

    stdoutSpy.length = 0;
    await reqCommand(
      "POST",
      "{{baseUrl}}/a",
      opts({ ...template, env: "local", var: { tenant: "from-var" } }),
      workDir,
    );
    expect(readEcho().headers["x-tenant"]).toBe("from-var");
  });

  it("存在しない環境ファイルは exit 2", async () => {
    const code = await reqCommand(
      "GET",
      `${fixture.baseUrl}/x`,
      opts({ envFile: "nope.yaml" }),
      workDir,
    );

    expect(code).toBe(2);
    expect(stderrSpy.join("")).toContain("parse error");
  });

  it("--json と --text、-e と --env-file の同時指定は引数エラーで exit 1(run と同じ)", async () => {
    const jsonText = await reqCommand(
      "GET",
      `${fixture.baseUrl}/x`,
      opts({ json: true, text: true }),
      workDir,
    );
    const envBoth = await reqCommand(
      "GET",
      `${fixture.baseUrl}/x`,
      opts({ env: "a", envFile: "b.yaml" }),
      workDir,
    );

    expect(jsonText).toBe(1);
    expect(envBoth).toBe(1);
    expect(stdoutSpy.join("")).toBe("");
  });

  it("リクエスト定義の検証エラー(timeout が正でない)は exit 2 で、何も送信しない", async () => {
    const code = await reqCommand("GET", `${fixture.baseUrl}/x`, opts({ timeout: -5 }), workDir);

    expect(code).toBe(2);
    expect(stderrSpy.join("")).toContain("invalid request");
    expect(stdoutSpy.join("")).toBe("");
  });

  it("履歴有効時は historyRef を付け、source: single で actor / env を履歴に残す(`history show` が引ける runId)", async () => {
    await mkdir(join(workDir, "environments"), { recursive: true });
    await writeFile(
      join(workDir, "environments", "local.yaml"),
      `baseUrl: ${fixture.baseUrl}\n`,
      "utf-8",
    );

    const code = await reqCommand(
      "GET",
      "{{baseUrl}}/ping",
      opts({ history: true, env: "local", actor: "tester" }),
      workDir,
    );

    expect(code).toBe(0);
    const { historyRef } = readJson();
    expect(historyRef).toMatchObject({ step: "request" });
    const entry = JSON.parse((await readFile(historyFilePath(workDir), "utf-8")).trim());
    expect(entry.runId).toBe(historyRef.runId);
    expect(entry).toMatchObject({
      source: "single",
      flow: "(single)",
      step: "request",
      env: "local",
      actor: { name: "tester" },
    });
  });

  it("--no-history 相当(history: false)では履歴ファイルを作らない", async () => {
    await reqCommand("GET", `${fixture.baseUrl}/ping`, opts({ history: false }), workDir);

    await expect(readFile(historyFilePath(workDir), "utf-8")).rejects.toThrow();
  });

  it("接続不能は履歴に残らないため、履歴有効でも historyRef を付けない", async () => {
    const closedPort = await reserveClosedPort();

    await reqCommand("GET", `http://127.0.0.1:${closedPort}/`, opts({ history: true }), workDir);

    expect(readJson()).not.toHaveProperty("historyRef");
  });

  it("guard.allowedHosts に無いホストは exit 3 で拒否され、拒否は履歴に残る", async () => {
    const code = await reqCommand(
      "GET",
      `${fixture.baseUrl}/ping`,
      opts({ history: true, guard: { allowedHosts: ["api.example.com"] } }),
      workDir,
    );

    expect(code).toBe(3);
    const report = readJson();
    expect(report.status).toBe("error");
    expect(report.error).toContain("guard.allowedHosts");
    expect(report.historyRef).toBeDefined();
    const entry = JSON.parse((await readFile(historyFilePath(workDir), "utf-8")).trim());
    expect(entry).toMatchObject({ source: "single", status: "error" });
  });

  it("guard.allowedHosts に一致するホストへは送信される", async () => {
    const code = await reqCommand(
      "GET",
      `${fixture.baseUrl}/ping`,
      opts({ guard: { allowedHosts: [new URL(fixture.baseUrl).host] } }),
      workDir,
    );

    expect(code).toBe(0);
  });

  it("$protected: true の環境は exit 3 で拒否される(--allow-protected は無い)", async () => {
    await mkdir(join(workDir, "environments"), { recursive: true });
    await writeFile(
      join(workDir, "environments", "prod.yaml"),
      `$protected: true\nbaseUrl: ${fixture.baseUrl}\n`,
      "utf-8",
    );

    const code = await reqCommand("GET", "{{baseUrl}}/ping", opts({ env: "prod" }), workDir);

    expect(code).toBe(3);
    expect(readJson().error).toContain("$protected: true");
  });

  it('$protected: "readonly" の環境は GET を許可し、POST は exit 3 で拒否する', async () => {
    await mkdir(join(workDir, "environments"), { recursive: true });
    await writeFile(
      join(workDir, "environments", "stg.yaml"),
      `$protected: readonly\nbaseUrl: ${fixture.baseUrl}\n`,
      "utf-8",
    );

    const get = await reqCommand("GET", "{{baseUrl}}/ping", opts({ env: "stg" }), workDir);
    stdoutSpy.length = 0;
    const post = await reqCommand("POST", "{{baseUrl}}/ping", opts({ env: "stg" }), workDir);

    expect(get).toBe(0);
    expect(post).toBe(3);
    expect(readJson().error).toContain("refusing POST");
  });

  it('$protected: "readonly" の環境では、メソッド上書きヘッダーつきの GET も exit 3 で拒否し、送信しない', async () => {
    await mkdir(join(workDir, "environments"), { recursive: true });
    await writeFile(
      join(workDir, "environments", "stg.yaml"),
      `$protected: readonly\nbaseUrl: ${fixture.baseUrl}\n`,
      "utf-8",
    );

    const code = await reqCommand(
      "GET",
      "{{baseUrl}}/ping",
      opts({ env: "stg", header: { "X-HTTP-Method-Override": "DELETE" } }),
      workDir,
    );

    expect(code).toBe(3);
    const report = readJson();
    expect(report.error).toContain("x-http-method-override");
    // 単発リクエストには --allow-protected が無いため、フロー実行向けの案内に切り替わる
    expect(report.error).toContain("cannot override environment protection");
    expect(report.error).not.toContain("Pass --allow-protected");
    expect(report).not.toHaveProperty("response");
  });

  it("--body @<シンボリックリンク> が cwd の外の実体を指す場合は exit 2 で何も送信しない", async () => {
    const outside = await mkdtemp(join(tmpRoot, "klaus-req-outside-"));
    try {
      await writeFile(join(outside, "secret.json"), '{"leak":true}', "utf-8");
      await symlink(join(outside, "secret.json"), join(workDir, "link.json"));

      const code = await reqCommand(
        "POST",
        `${fixture.baseUrl}/f`,
        opts({ body: "@link.json" }),
        workDir,
      );

      expect(code).toBe(2);
      expect(stdoutSpy.join("")).toBe("");
      expect(stderrSpy.join("")).toContain("outside the current directory");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("--body @<絶対パス> は cwd の外なら exit 2、cwd 配下なら読んで送る", async () => {
    const outside = await mkdtemp(join(tmpRoot, "klaus-req-outside-"));
    try {
      await writeFile(join(outside, "abs.json"), '{"abs":1}', "utf-8");
      const refused = await reqCommand(
        "POST",
        `${fixture.baseUrl}/f`,
        opts({ body: `@${join(outside, "abs.json")}` }),
        workDir,
      );
      expect(refused).toBe(2);
      expect(stdoutSpy.join("")).toBe("");
      expect(stderrSpy.join("")).toContain("outside the current directory");

      await writeFile(join(workDir, "inside.json"), '{"inside":2}', "utf-8");
      const allowed = await reqCommand(
        "POST",
        `${fixture.baseUrl}/f`,
        opts({ body: `@${join(workDir, "inside.json")}` }),
        workDir,
      );
      expect(allowed).toBe(0);
      expect(JSON.parse(readEcho().body)).toEqual({ inside: 2 });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("--no-mask(mask: false)でも履歴ファイルのシークレットはマスクされる", async () => {
    process.env.KLAUS_REQ_TEST_SECRET = "history-secret-value-77";
    try {
      const code = await reqCommand(
        "GET",
        `${fixture.baseUrl}/s`,
        { history: true, mask: false, header: { "X-Secret": "{{env.KLAUS_REQ_TEST_SECRET}}" } },
        workDir,
      );

      expect(code).toBe(0);
      // 標準出力は --no-mask なので生の値が出る
      expect(readJson().request.headers["X-Secret"]).toBe("history-secret-value-77");
      const history = await readFile(historyFilePath(workDir), "utf-8");
      expect(history).not.toContain("history-secret-value-77");
      expect(JSON.parse(history.trim()).request.headers["X-Secret"]).toBe("***");
    } finally {
      delete process.env.KLAUS_REQ_TEST_SECRET;
    }
  });

  it("{{env.X}} のシークレットは既定でマスクされ、mask: false(--no-mask)なら生の値が出る", async () => {
    process.env.KLAUS_REQ_TEST_SECRET = "req-secret-value-123";
    try {
      const header = { "X-Secret": "{{env.KLAUS_REQ_TEST_SECRET}}" };

      await reqCommand("GET", `${fixture.baseUrl}/s`, opts({ header }), workDir);
      const masked = stdoutSpy.join("");
      expect(masked).not.toContain("req-secret-value-123");
      expect(readJson().request.headers["X-Secret"]).toBe("***");
      expect(readEcho().headers["x-secret"]).toBe("***");

      stdoutSpy.length = 0;
      await reqCommand("GET", `${fixture.baseUrl}/s`, opts({ header, mask: false }), workDir);
      expect(readJson().request.headers["X-Secret"]).toBe("req-secret-value-123");
    } finally {
      delete process.env.KLAUS_REQ_TEST_SECRET;
    }
  });

  it("登録済みシークレットが無くても、Cookie ヘッダーの値は JSON で *** になる(--no-mask なら生の値)", async () => {
    const header = { Cookie: "session=raw-cookie-abc" };

    await reqCommand("GET", `${fixture.baseUrl}/c`, opts({ header }), workDir);
    expect(readJson().request.headers.Cookie).toBe("session=***");

    stdoutSpy.length = 0;
    await reqCommand("GET", `${fixture.baseUrl}/c`, opts({ header, mask: false }), workDir);
    expect(readJson().request.headers.Cookie).toBe("session=raw-cookie-abc");
  });

  it("応答ボディは JSON 出力で 500 文字に切り詰められる", async () => {
    await reqCommand("GET", `${fixture.baseUrl}/big`, opts(), workDir);

    const body = readJson().response.body;
    expect(body).toBe(`${"x".repeat(500)}...(truncated)`);
  });

  it("Accept: text/event-stream の場合は受信イベントを events に含める", async () => {
    const code = await reqCommand(
      "GET",
      `${fixture.baseUrl}/sse`,
      opts({ header: { Accept: "text/event-stream" } }),
      workDir,
    );

    expect(code).toBe(0);
    expect(readJson().events).toEqual([{ data: "one" }, { data: "two" }]);
  });

  it("--text では1行目に「メソッド URL -> ステータス」、履歴有効時は history show の案内を出す", async () => {
    const code = await reqCommand(
      "GET",
      `${fixture.baseUrl}/ping`,
      opts({ text: true, history: true }),
      workDir,
    );

    expect(code).toBe(0);
    const out = stdoutSpy.join("");
    expect(out.split("\n")[0]).toMatch(
      new RegExp(`^GET ${fixture.baseUrl}/ping -> 200 \\(\\d+ms\\)$`),
    );
    expect(out).toContain("< content-type: application/json");
    expect(out).toMatch(/history: klaus history show \S+ --step request/);
  });

  it("--text の送信エラーは ERROR 行で exit 3、制御文字はサニタイズされる", async () => {
    const code = await reqCommand("GET", "{{bad\u001b[31mvar}}", opts({ text: true }), workDir);

    expect(code).toBe(3);
    const out = stdoutSpy.join("");
    expect(out).toContain("ERROR:");
    expect(out).not.toContain("\u001b");
  });
});
