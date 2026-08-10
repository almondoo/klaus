import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { historyFilePath } from "../src/core/history.js";
import { executeSingleRequest } from "../src/core/runner.js";
import { closeServer, listenEphemeral } from "./support/net.js";

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
