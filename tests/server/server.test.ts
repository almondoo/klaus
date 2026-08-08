import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createParser } from "eventsource-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../src/core/index.js";
import { historyFilePath } from "../../src/core/index.js";
import type { StartServerResult } from "../../src/server/index.js";
import { startServer } from "../../src/server/index.js";

/**
 * 偽の Host ヘッダーを送るためのヘルパー。
 * fetch() は "Host" を forbidden header として扱い、指定しても実際の接続先ホストで上書きされてしまうため、
 * node:http.request を直接使う(生のソケットレベルでは Host ヘッダーを自由に指定できる)。
 */
function requestWithHost(port: number, path: string, host: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: host } },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** POST /api/runs 用のターゲット: 2ステップ分のエンドポイントを持つ最小限のローカル HTTP サーバー */
async function startFixtureServer() {
  const server = createServer((req, res) => {
    if (req.url === "/step1" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ step: 1 }));
      return;
    }
    if (req.url === "/step2" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ step: 2 }));
      return;
    }
    // クライアント切断の回帰テスト用: 各ステップに間を持たせ、切断が
    // ステップ実行の途中で発生する状況を確実に作るための遅延付きエンドポイント
    if (req.url === "/delay" && req.method === "GET") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }, 60);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/** SSE レスポンスを読み切り、event/data の列を配列で返す */
async function collectSseEvents(
  response: Response,
): Promise<Array<{ event: string; data: unknown }>> {
  const events: Array<{ event: string; data: unknown }> = [];
  const parser = createParser({
    onEvent(event) {
      if (!event.data) return;
      events.push({ event: event.event ?? "", data: JSON.parse(event.data) });
    },
  });

  const body = response.body;
  if (!body) throw new Error("response has no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }
  return events;
}

/**
 * 履歴 JSONL ファイルをポーリングし、指定フローのステップ履歴が expectedCount 件に達するまで待つ。
 * SSE 配信のクライアント切断後もフロー実行(履歴書き込み)が最後まで継続することを検証するために使う。
 */
async function waitForHistorySteps(
  historyPath: string,
  flowName: string,
  expectedCount: number,
  timeoutMs: number,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let entries: HistoryEntry[] = [];
    try {
      const content = await readFile(historyPath, "utf-8");
      entries = content
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as HistoryEntry)
        .filter((entry) => entry.flow === flowName);
    } catch {
      // ファイルがまだ作成されていない場合は空として扱い、リトライする
    }
    if (entries.length >= expectedCount) {
      return entries.map((entry) => entry.step);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `history entries for flow "${flowName}" did not reach ${expectedCount} within ${timeoutMs}ms (got ${entries.length})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("klaus server", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let workDir: string;
  let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
  let klaus: StartServerResult;
  let base: string;

  beforeAll(async () => {
    await mkdir(tmpRoot, { recursive: true });
    workDir = await mkdtemp(join(tmpRoot, "klaus-server-it-"));
    fixture = await startFixtureServer();

    // 正常なフロー(2ステップ)
    await writeFile(
      join(workDir, "success.yaml"),
      [
        "name: success flow",
        "steps:",
        "  - name: step1",
        "    request:",
        "      method: GET",
        `      url: "${fixture.baseUrl}/step1"`,
        "    assert:",
        "      status: 200",
        "  - name: step2",
        "    request:",
        "      method: GET",
        `      url: "${fixture.baseUrl}/step2"`,
        "    assert:",
        "      status: 200",
        "",
      ].join("\n"),
      "utf-8",
    );

    // クライアント切断の回帰テスト用フロー(3ステップ、各ステップに遅延を挟む)
    await writeFile(
      join(workDir, "disconnect.yaml"),
      [
        "name: disconnect flow",
        "steps:",
        "  - name: step-a",
        "    request:",
        "      method: GET",
        `      url: "${fixture.baseUrl}/delay"`,
        "    assert:",
        "      status: 200",
        "  - name: step-b",
        "    request:",
        "      method: GET",
        `      url: "${fixture.baseUrl}/delay"`,
        "    assert:",
        "      status: 200",
        "  - name: step-c",
        "    request:",
        "      method: GET",
        `      url: "${fixture.baseUrl}/delay"`,
        "    assert:",
        "      status: 200",
        "",
      ].join("\n"),
      "utf-8",
    );

    // steps キーはあるがスキーマ検証に失敗する(min 1 件を満たさない)ファイル
    await writeFile(join(workDir, "broken.yaml"), "name: broken flow\nsteps: []\n", "utf-8");

    // steps キーを持たない YAML(フロー候補として一覧に出てはいけない)
    await writeFile(join(workDir, "not-a-flow.yaml"), "someOtherKey: 1\n", "utf-8");

    klaus = await startServer({ cwd: workDir, port: 0 });
    base = `http://127.0.0.1:${klaus.port}`;
  }, 30000);

  afterAll(async () => {
    await klaus.close();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true });
  });

  it("X-Klaus-Token ヘッダーが無いと /api/* は 401", async () => {
    const res = await fetch(`${base}/api/flows`);
    expect(res.status).toBe(401);
  });

  it("Host ヘッダーが 127.0.0.1:<port>/localhost:<port> 以外だと 403(DNS rebinding 対策)", async () => {
    const res = await requestWithHost(klaus.port, "/api/flows", "evil.example.com");
    expect(res.status).toBe(403);
  });

  it("GET /api/flows/detail の path が cwd 外を指す場合は 403(path traversal 拒否)", async () => {
    const res = await fetch(
      `${base}/api/flows/detail?path=${encodeURIComponent("../../etc/passwd")}`,
      {
        headers: { "X-Klaus-Token": klaus.token },
      },
    );
    expect(res.status).toBe(403);
  });

  it("POST /api/runs: env が cwd 外を指す値だと 403(path traversal 拒否)", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
      },
      body: JSON.stringify({ path: "success.yaml", env: "../../../etc/secrets/prod" }),
    });
    expect(res.status).toBe(403);
  });

  it("GET /api/flows: 正常なフローとパースエラーのフローが混在して返る(steps キーを持たないファイルは除外)", async () => {
    const res = await fetch(`${base}/api/flows`, {
      headers: { "X-Klaus-Token": klaus.token },
    });
    expect(res.status).toBe(200);
    const flows = (await res.json()) as Array<{
      path: string;
      name?: string;
      stepCount?: number;
      error?: string;
    }>;

    const success = flows.find((f) => f.path === "success.yaml");
    expect(success).toEqual({ path: "success.yaml", name: "success flow", stepCount: 2 });

    const broken = flows.find((f) => f.path === "broken.yaml");
    expect(broken?.error).toBeTruthy();
    expect(broken?.name).toBeUndefined();

    expect(flows.some((f) => f.path === "not-a-flow.yaml")).toBe(false);
  });

  it("POST /api/runs: SSE で step-start/step-result が2ステップ分 + run-result が配信される", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
      },
      body: JSON.stringify({ path: "success.yaml" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectSseEvents(res);
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toEqual([
      "step-start",
      "step-result",
      "step-start",
      "step-result",
      "run-result",
    ]);

    const runResult = events[4]?.data as { flow: { status: string; steps: unknown[] } };
    expect(runResult.flow.status).toBe("passed");
    expect(runResult.flow.steps).toHaveLength(2);
  });

  it("POST /api/runs: SSE 配信中にクライアントが切断しても、フロー実行は最後まで継続し履歴が全ステップ分書き込まれる(切断後もサーバーは正常に応答する)", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
      },
      body: JSON.stringify({ path: "disconnect.yaml" }),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);

    const body = res.body;
    if (!body) throw new Error("response has no body");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    // 最初の step-start イベントを受信した時点でクライアントを切断する
    const parser = createParser({
      onEvent(event) {
        if (event.event === "step-start") {
          controller.abort();
        }
      },
    });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } catch {
      // abort によって reader.read() が reject するのは想定内(ここでは無視してよい)
    }

    // (a) 切断後も実行が継続し、3ステップ分すべての履歴が書き込まれる
    const historyPath = historyFilePath(workDir);
    const stepNames = await waitForHistorySteps(historyPath, "disconnect flow", 3, 5000);
    expect(stepNames).toEqual(["step-a", "step-b", "step-c"]);

    // (b) 切断後もサーバーは後続の新規リクエストに正常応答する
    const followUpRes = await fetch(`${base}/api/flows`, {
      headers: { "X-Klaus-Token": klaus.token },
    });
    expect(followUpRes.status).toBe(200);
  }, 10000);

  it("GET /api/history: limit + before カーソルでページングできる(新しい順)", async () => {
    // 履歴を1件以上作るため、直前のテストで実行済みの run に加えてもう1回実行する
    const runRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
      },
      body: JSON.stringify({ path: "success.yaml" }),
    });
    await collectSseEvents(runRes); // 実行完了(履歴書き込み完了)まで待つ

    const page1Res = await fetch(`${base}/api/history?limit=1`, {
      headers: { "X-Klaus-Token": klaus.token },
    });
    const page1 = (await page1Res.json()) as {
      entries: Array<{ startedAt: string }>;
      nextBefore?: string;
    };
    expect(page1.entries).toHaveLength(1);
    expect(page1.nextBefore).toBeTruthy();

    const page2Res = await fetch(
      `${base}/api/history?limit=1&before=${encodeURIComponent(page1.nextBefore as string)}`,
      { headers: { "X-Klaus-Token": klaus.token } },
    );
    const page2 = (await page2Res.json()) as { entries: Array<{ startedAt: string }> };
    expect(page2.entries).toHaveLength(1);
    // page1 は page2 より新しい(startedAt が同じか後)
    const firstStartedAt = page1.entries[0]?.startedAt ?? "";
    const secondStartedAt = page2.entries[0]?.startedAt ?? "";
    expect(firstStartedAt >= secondStartedAt).toBe(true);
  });
});
