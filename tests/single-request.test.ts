import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { historyFilePath } from "../src/core/history.js";
import { executeFlow, executeSingleRequest } from "../src/core/runner.js";
import { flowSchema } from "../src/core/schema.js";
import { closeServer, listenEphemeral, reserveClosedPort } from "./support/net.js";

async function startEchoServer() {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf-8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          url: req.url,
          receivedSecret: req.headers["x-secret"],
          body: bodyText ? JSON.parse(bodyText) : null,
        }),
      );
    });
  });
  const { baseUrl } = await listenEphemeral(server);
  return { server, baseUrl };
}

describe("executeSingleRequest", () => {
  let ctx: Awaited<ReturnType<typeof startEchoServer>>;
  const tmpRoot = join(process.cwd(), "tmp");
  let cwd: string;

  beforeAll(async () => {
    ctx = await startEchoServer();
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

  it("単一のリクエスト定義を実行し、StepResult を返す(フロー定義ファイル不要)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));

    const { result } = await executeSingleRequest({
      request: { method: "GET", url: `${ctx.baseUrl}/ping` },
      cwd,
      history: false,
    });

    expect(result.name).toBe("request");
    expect(result.status).toBe("passed");
    expect(result.response?.status).toBe(200);
  });

  it("検証エラーのあるリクエスト定義は ZodError をそのまま投げる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));

    await expect(
      executeSingleRequest({
        request: { url: `${ctx.baseUrl}/ping` }, // method 省略(graphql も無いため必須違反)
        cwd,
        history: false,
      }),
    ).rejects.toThrow();
  });

  it("history: true(既定)で .klaus/history/*.jsonl に source: 'single' のエントリが1件書き込まれる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));

    await executeSingleRequest({
      request: { method: "GET", url: `${ctx.baseUrl}/ping` },
      cwd,
    });

    const filePath = historyFilePath(cwd);
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0] as string);
    expect(entry.flow).toBe("(single)");
    expect(entry.step).toBe("request");
    expect(entry.status).toBe("passed");
    expect(entry.source).toBe("single");
  });

  it("history: false の場合は .klaus/history に何も書き込まれない", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));

    await executeSingleRequest({
      request: { method: "GET", url: `${ctx.baseUrl}/ping` },
      cwd,
      history: false,
    });

    await expect(readFile(historyFilePath(cwd), "utf-8")).rejects.toThrow();
  });

  it("envName で指定した environments/<name>.yaml がテンプレート変数として解決される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(join(cwd, "environments", "local.yaml"), `baseUrl: ${ctx.baseUrl}\n`, "utf-8");

    const { result } = await executeSingleRequest({
      request: { method: "GET", url: "{{baseUrl}}/ping" },
      cwd,
      envName: "local",
      history: false,
    });

    expect(result.status).toBe("passed");
    expect(result.request?.url).toBe(`${ctx.baseUrl}/ping`);
  });

  it("$protected: true の環境は server/UI 経由(allowProtected を渡さない)では常に拒否される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(
      join(cwd, "environments", "prod.yaml"),
      `$protected: true\nbaseUrl: ${ctx.baseUrl}\n`,
      "utf-8",
    );

    const { result } = await executeSingleRequest({
      request: { method: "GET", url: "{{baseUrl}}/ping" },
      cwd,
      envName: "prod",
      history: false,
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("prod");
    expect(result.error).toContain("--allow-protected");
    // 単発リクエストには --allow-protected が無いため、「Pass --allow-protected」とは案内しない
    expect(result.error).not.toContain("Pass --allow-protected");
    expect(result.error).toContain("cannot override environment protection");
  });

  it("保護環境の拒否メッセージの案内は入口で切り替わる(フロー実行は --allow-protected を案内し、単発は案内しない)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(
      join(cwd, "environments", "prod.yaml"),
      `$protected: true\nbaseUrl: ${ctx.baseUrl}\n`,
      "utf-8",
    );
    const flow = flowSchema.parse({
      name: "f",
      env: "prod",
      steps: [{ name: "s", request: { method: "GET", url: "{{baseUrl}}/ping" } }],
    });

    const run = await executeFlow(flow, "f.yaml", { cwd, history: false });

    expect(run.steps[0]?.error).toContain("Pass --allow-protected to run against this environment");
    expect(run.steps[0]?.error).not.toContain("Single requests");
  });

  it("entryPoint が mcp の単発リクエストの保護環境の拒否は、klaus mcp が上書きできず利用者が端末から実行する案内になる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(
      join(cwd, "environments", "prod.yaml"),
      `$protected: true\nbaseUrl: ${ctx.baseUrl}\n`,
      "utf-8",
    );

    const { result } = await executeSingleRequest({
      request: { method: "GET", url: "{{baseUrl}}/ping" },
      cwd,
      envName: "prod",
      history: false,
      entryPoint: "mcp",
    });

    expect(result.status).toBe("error");
    expect(result.errorCode).toBe("guard.protected");
    expect(result.error).toContain("klaus mcp cannot override environment protection");
    expect(result.error).toContain("from a terminal with `klaus run --allow-protected`");
    expect(result.error).not.toContain("Single requests");
  });

  it('$protected: "readonly" の環境では安全メソッド(GET)のみ許可され、POST は拒否される', async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(
      join(cwd, "environments", "stg.yaml"),
      `$protected: readonly\nbaseUrl: ${ctx.baseUrl}\n`,
      "utf-8",
    );

    const get = await executeSingleRequest({
      request: { method: "GET", url: "{{baseUrl}}/ping" },
      cwd,
      envName: "stg",
      history: false,
    });
    const post = await executeSingleRequest({
      request: { method: "POST", url: "{{baseUrl}}/echo", body: { a: 1 } },
      cwd,
      envName: "stg",
      history: false,
    });

    expect(get.result.status).toBe("passed");
    expect(post.result.status).toBe("error");
    expect(post.result.error).toContain("refusing POST");
    expect(post.result.error).toContain("--allow-protected");
  });

  it("guard.allowedHosts に無いホストへの単発リクエストは送信されず error になる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));

    const { result } = await executeSingleRequest({
      request: { method: "GET", url: `${ctx.baseUrl}/ping` },
      cwd,
      history: false,
      guard: { allowedHosts: ["api.example.com"] },
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("guard.allowedHosts");
  });

  it("guard.allowedHosts に一致するホストへの単発リクエストは実行される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));
    const { host } = new URL(ctx.baseUrl);

    const { result } = await executeSingleRequest({
      request: { method: "GET", url: `${ctx.baseUrl}/ping` },
      cwd,
      history: false,
      guard: { allowedHosts: [host] },
    });

    expect(result.status).toBe("passed");
  });

  it("履歴に env / actor / git を記録し、フローファイルが無いため file は書かない", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(join(cwd, "environments", "local.yaml"), `baseUrl: ${ctx.baseUrl}\n`, "utf-8");

    await executeSingleRequest({
      request: { method: "GET", url: "{{baseUrl}}/ping" },
      cwd,
      envName: "local",
      actor: { kind: "human" },
      git: { commit: "abc123", dirty: false },
    });

    const entry = JSON.parse((await readFile(historyFilePath(cwd), "utf-8")).trim());
    expect(entry).toMatchObject({
      source: "single",
      env: "local",
      actor: { kind: "human" },
      git: { commit: "abc123", dirty: false },
    });
    expect(entry).not.toHaveProperty("file");
  });

  it("安全柵に拒否された単発リクエストは status: error の履歴として記録される(source: single)", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));

    await executeSingleRequest({
      request: { method: "GET", url: `${ctx.baseUrl}/ping` },
      cwd,
      guard: { allowedHosts: ["api.example.com"] },
      actor: { kind: "human" },
    });

    const entry = JSON.parse((await readFile(historyFilePath(cwd), "utf-8")).trim());
    expect(entry).toMatchObject({
      source: "single",
      status: "error",
      request: { method: "GET", url: `${ctx.baseUrl}/ping` },
      actor: { kind: "human" },
    });
    expect(entry.error).toContain("guard.allowedHosts");
  });

  it("request.query が URL にマージされて送信される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));

    const { result } = await executeSingleRequest({
      request: {
        method: "GET",
        url: `${ctx.baseUrl}/search?page=1`,
        query: { page: "2", q: "klaus" },
      },
      cwd,
      history: false,
    });

    expect(result.status).toBe("passed");
    const body = result.response?.body as { url: string };
    const receivedUrl = new URL(body.url, "http://127.0.0.1");
    expect(receivedUrl.searchParams.get("page")).toBe("2");
    expect(receivedUrl.searchParams.get("q")).toBe("klaus");
  });

  it("envFilePath で指定した任意パスの環境ファイルがテンプレート変数として解決され、履歴の env にはファイル名だけが残る", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));
    await writeFile(join(cwd, "custom-env.yaml"), `baseUrl: ${ctx.baseUrl}\n`, "utf-8");

    const { result } = await executeSingleRequest({
      request: { method: "GET", url: "{{baseUrl}}/ping" },
      cwd,
      envFilePath: "custom-env.yaml",
    });

    expect(result.status).toBe("passed");
    expect(result.request?.url).toBe(`${ctx.baseUrl}/ping`);
    const entry = JSON.parse((await readFile(historyFilePath(cwd), "utf-8")).trim());
    expect(entry.env).toBe("custom-env.yaml");
  });

  it("$protected: true の環境ファイルを envFilePath で指定しても拒否される", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));
    await writeFile(
      join(cwd, "prod-env.yaml"),
      `$protected: true\nbaseUrl: ${ctx.baseUrl}\n`,
      "utf-8",
    );

    const { result } = await executeSingleRequest({
      request: { method: "GET", url: "{{baseUrl}}/ping" },
      cwd,
      envFilePath: "prod-env.yaml",
      history: false,
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("prod-env.yaml");
  });

  it("variables は環境ファイルの同名の値を上書きしてテンプレートに渡る", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(
      join(cwd, "environments", "local.yaml"),
      `baseUrl: http://unused.invalid\nid: from-env\n`,
      "utf-8",
    );

    const { result } = await executeSingleRequest({
      request: { method: "GET", url: "{{baseUrl}}/items/{{id}}" },
      cwd,
      envName: "local",
      variables: { baseUrl: ctx.baseUrl, id: "from-var" },
      history: false,
    });

    expect(result.status).toBe("passed");
    expect(result.request?.url).toBe(`${ctx.baseUrl}/items/from-var`);
  });

  describe("runId と historyRecorded", () => {
    it("履歴を書き込んだ場合は historyRecorded: true で、runId が履歴エントリの runId と一致する", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));

      const { runId, historyRecorded } = await executeSingleRequest({
        request: { method: "GET", url: `${ctx.baseUrl}/ping` },
        cwd,
      });

      expect(historyRecorded).toBe(true);
      const entry = JSON.parse((await readFile(historyFilePath(cwd), "utf-8")).trim());
      expect(entry.runId).toBe(runId);
    });

    it("安全柵による拒否も履歴に書かれるため historyRecorded: true", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));

      const { result, historyRecorded } = await executeSingleRequest({
        request: { method: "GET", url: `${ctx.baseUrl}/ping` },
        cwd,
        guard: { allowedHosts: ["api.example.com"] },
      });

      expect(result.status).toBe("error");
      expect(historyRecorded).toBe(true);
    });

    it("history: false の場合は historyRecorded: false", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));

      const { historyRecorded } = await executeSingleRequest({
        request: { method: "GET", url: `${ctx.baseUrl}/ping` },
        cwd,
        history: false,
      });

      expect(historyRecorded).toBe(false);
    });

    it("接続不能など履歴に残らない実行時エラーでは、history が有効でも historyRecorded: false", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));
      const closedPort = await reserveClosedPort();

      const { result, historyRecorded } = await executeSingleRequest({
        request: { method: "GET", url: `http://127.0.0.1:${closedPort}/` },
        cwd,
      });

      expect(result.status).toBe("error");
      expect(historyRecorded).toBe(false);
      await expect(readFile(historyFilePath(cwd), "utf-8")).rejects.toThrow();
    });
  });

  describe("履歴のシークレットマスク", () => {
    const SECRET_KEY = "KLAUS_SINGLE_TEST_SECRET";
    const SECRET_VALUE = "supersecret-single-value";

    beforeEach(() => {
      process.env[SECRET_KEY] = SECRET_VALUE;
    });

    afterEach(() => {
      delete process.env[SECRET_KEY];
    });

    it("{{env.X}} で解決した値は履歴では *** にマスクされ、実行結果 (StepResult) は生の値のまま返る", async () => {
      cwd = await mkdtemp(join(tmpRoot, "klaus-single-"));

      const { result } = await executeSingleRequest({
        request: {
          method: "POST",
          url: `${ctx.baseUrl}/echo`,
          headers: { "X-Secret": `{{env.${SECRET_KEY}}}` },
        },
        cwd,
      });

      // 実行結果(呼び出し元へ返る StepResult)はライブ値のまま
      expect(result.request?.headers["X-Secret"]).toBe(SECRET_VALUE);

      // 履歴側はマスク済み
      const filePath = historyFilePath(cwd);
      const content = await readFile(filePath, "utf-8");
      expect(content).not.toContain(SECRET_VALUE);
      const entry = JSON.parse(content.trim());
      expect(entry.request.headers["X-Secret"]).toBe("***");
      expect(entry.response.body.receivedSecret).toBe("***");
    });
  });
});
