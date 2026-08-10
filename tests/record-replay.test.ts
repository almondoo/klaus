import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/cli/run.js";
import { cassetteFilePath } from "../src/core/cassette.js";
import { executeFlow } from "../src/core/runner.js";
import { flowSchema } from "../src/core/schema.js";
import { closeServer, listenEphemeral } from "./support/net.js";

/** X-Secret ヘッダーを受け取り、JSON レスポンスの body にそのまま反映するエコーサーバー */
async function startEchoServer() {
  const server = createServer((req, res) => {
    if (req.url === "/ok" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, secret: req.headers["x-secret"] ?? null }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  const { baseUrl } = await listenEphemeral(server);
  return { server, baseUrl };
}

describe("record/replay モード", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let cwd: string;
  let cassetteDir: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    cwd = await mkdtemp(join(tmpRoot, "klaus-recrep-cwd-"));
    cassetteDir = await mkdtemp(join(tmpRoot, "klaus-recrep-cassette-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
    await rm(cassetteDir, { recursive: true, force: true });
  });

  it("record 実行でカセットが生成され、{{env.X}} の解決値がカセットに平文で残らない", async () => {
    const { server, baseUrl } = await startEchoServer();
    const SECRET_KEY = "KLAUS_TEST_RECORD_SECRET";
    const SECRET_VALUE = "record-cassette-secret-value-123";
    process.env[SECRET_KEY] = SECRET_VALUE;
    try {
      const flow = flowSchema.parse({
        name: "record flow",
        steps: [
          {
            name: "ok",
            request: {
              method: "GET",
              url: `${baseUrl}/ok`,
              headers: { "X-Secret": `{{env.${SECRET_KEY}}}` },
            },
            assert: { status: 200 },
          },
        ],
      });

      const result = await executeFlow(flow, "record-flow.yaml", {
        cwd,
        history: false,
        recording: { mode: "record", dir: cassetteDir },
      });

      expect(result.status).toBe("passed");
      const cassetteContent = await readFile(cassetteFilePath(cassetteDir), "utf-8");
      expect(cassetteContent).not.toContain(SECRET_VALUE);
      expect(cassetteContent).toContain("***");
      const entry = JSON.parse(cassetteContent.trim());
      expect(entry.method).toBe("GET");
      expect(entry.url).toBe(`${baseUrl}/ok`);
      expect(entry.status).toBe(200);
    } finally {
      delete process.env[SECRET_KEY];
      await closeServer(server);
    }
  });

  it("record → replay の往復で同一フローがネットワークなしで pass する", async () => {
    const { server, baseUrl } = await startEchoServer();
    let serverClosed = false;
    try {
      const flow = flowSchema.parse({
        name: "round trip flow",
        steps: [
          {
            name: "ok",
            request: { method: "GET", url: `${baseUrl}/ok` },
            assert: { status: 200 },
          },
        ],
      });

      const recordResult = await executeFlow(flow, "round-trip-flow.yaml", {
        cwd,
        history: false,
        recording: { mode: "record", dir: cassetteDir },
      });
      expect(recordResult.status).toBe("passed");

      // fixture サーバーを停止してから replay する(実ネットワークに出ていないことを保証する)
      await closeServer(server);
      serverClosed = true;

      const replayResult = await executeFlow(flow, "round-trip-flow.yaml", {
        cwd,
        history: false,
        recording: { mode: "replay", dir: cassetteDir },
      });

      expect(replayResult.status).toBe("passed");
      expect(replayResult.steps[0]?.response?.status).toBe(200);
    } finally {
      if (!serverClosed) {
        await closeServer(server);
      }
    }
  });

  it("replay 時に記録外リクエスト(URL を変える)が明確なエラーで fail する", async () => {
    const { server, baseUrl } = await startEchoServer();
    try {
      const recordedFlow = flowSchema.parse({
        name: "mismatch flow",
        steps: [
          {
            name: "ok",
            request: { method: "GET", url: `${baseUrl}/ok` },
            assert: { status: 200 },
          },
        ],
      });
      const recordResult = await executeFlow(recordedFlow, "mismatch-flow.yaml", {
        cwd,
        history: false,
        recording: { mode: "record", dir: cassetteDir },
      });
      expect(recordResult.status).toBe("passed");

      // replay 側は同名ステップだが URL が異なる(カセットに無いリクエスト)
      const mismatchedFlow = flowSchema.parse({
        name: "mismatch flow",
        steps: [
          {
            name: "ok",
            request: { method: "GET", url: `${baseUrl}/ok?extra=1` },
            assert: { status: 200 },
          },
        ],
      });

      const replayResult = await executeFlow(mismatchedFlow, "mismatch-flow.yaml", {
        cwd,
        history: false,
        recording: { mode: "replay", dir: cassetteDir },
      });

      expect(replayResult.status).toBe("error");
      expect(replayResult.steps[0]?.status).toBe("error");
      expect(replayResult.steps[0]?.error).toContain("no recorded response");
      expect(replayResult.steps[0]?.error).toContain("--record");
    } finally {
      await closeServer(server);
    }
  });

  it("--record と --replay の同時指定は CLI レベルでエラーになる(stderr + exit 1)", async () => {
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;

    try {
      const exitCode = await runCommand([], {
        history: false,
        mask: true,
        reportFile: join(cwd, "klaus-report.xml"),
        record: cassetteDir,
        replay: cassetteDir,
      });

      expect(exitCode).toBe(1);
      expect(stderrChunks.join("")).toContain("--record and --replay cannot be used together");
    } finally {
      process.stderr.write = originalWrite;
    }
  });

  it("カセットファイルの中身が壊れている(行が JSON として不正)場合、replayLoadError は RuntimeError でない元エラーを String() 化して包む", async () => {
    // loadCassetteIndex は各行を JSON.parse するだけで try/catch していないため、
    // 壊れた行があると RuntimeError ではなく素の SyntaxError が投げられる。
    // executeFlow(resolveHttpResponse 手前の loadCassetteIndex 呼び出し)側で
    // 「RuntimeError でなければ String(error) で包み直す」フォールバックを通す
    await mkdir(cassetteDir, { recursive: true });
    await writeFile(cassetteFilePath(cassetteDir), "{not valid json\n", "utf-8");

    const flow = flowSchema.parse({
      name: "broken cassette flow",
      steps: [
        {
          name: "ok",
          request: { method: "GET", url: "http://127.0.0.1:1/ok" },
          assert: { status: 200 },
        },
      ],
    });

    const result = await executeFlow(flow, "broken-cassette-flow.yaml", {
      cwd,
      history: false,
      recording: { mode: "replay", dir: cassetteDir },
    });

    expect(result.status).toBe("error");
    expect(result.steps[0]?.status).toBe("error");
    // SyntaxError のメッセージ(JSON.parse の失敗理由)がそのまま含まれる
    expect(result.steps[0]?.error).toMatch(/JSON|Unexpected/i);
  });

  it("SSE ステップ入りフローの record は明示的なエラーになる(黙って実ネットワークへ送らない)", async () => {
    const flow = flowSchema.parse({
      name: "sse in record flow",
      steps: [
        {
          name: "stream",
          request: {
            method: "GET",
            url: "https://example.invalid/stream",
            headers: { Accept: "text/event-stream" },
          },
        },
      ],
    });

    const result = await executeFlow(flow, "sse-in-record-flow.yaml", {
      cwd,
      history: false,
      recording: { mode: "record", dir: cassetteDir },
    });

    expect(result.status).toBe("error");
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("SSE/WS");
  });
});
