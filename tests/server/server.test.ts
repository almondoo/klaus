import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createParser } from "eventsource-parser";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HistoryEntry } from "../../src/core/index.js";
import { historyFilePath } from "../../src/core/index.js";
import { createApp } from "../../src/server/app.js";
import type { StartServerResult } from "../../src/server/index.js";
import { startServer } from "../../src/server/index.js";

/**
 * 偽の Host ヘッダーを送るためのヘルパー。
 * fetch() は "Host" を forbidden header として扱い、指定しても実際の接続先ホストで上書きされてしまうため、
 * node:http.request を直接使う(生のソケットレベルでは Host ヘッダーを自由に指定できる)。
 * connectHost は実際に接続するソケット先(既定 127.0.0.1)で、"localhost" バインドの環境によっては
 * IPv6(::1)に解決されるため、呼び出し側で実バインド先に合わせて上書きできるようにしている。
 */
function requestWithHost(
  port: number,
  path: string,
  host: string,
  connectHost = "127.0.0.1",
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: connectHost, port, path, method: "GET", headers: { Host: host } },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * 任意のヘッダーを直接指定してリクエストするためのヘルパー。
 * node:http.request を使うことで、fetch() の Headers 実装では表現しにくい配列値の
 * ヘッダー(同名ヘッダーの複数行送信、例: Set-Cookie)をそのまま生のソケットレベルで送れる
 * (node-bridge.ts の toWebRequest が req.headers の配列値を1つずつ変換する分岐の検証用)。
 */
function requestWithHeaders(
  port: number,
  path: string,
  headers: Record<string, string | string[]>,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
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

    // GET /api/environments 用: environments/*.yaml を2件用意する(一覧が name でソートされることの確認用)
    await mkdir(join(workDir, "environments"), { recursive: true });
    await writeFile(
      join(workDir, "environments", "staging.yaml"),
      "baseUrl: https://staging.example.com\n",
      "utf-8",
    );
    await writeFile(
      join(workDir, "environments", "local.yaml"),
      "baseUrl: https://local.example.com\n",
      "utf-8",
    );

    // GET /api/flows/detail 用: request(method 明示)/graphql(method 省略)/ws の3種を1フローに混在させる
    await writeFile(
      join(workDir, "detail.yaml"),
      [
        "name: detail flow",
        "steps:",
        "  - name: get-step",
        "    request:",
        "      method: GET",
        `      url: "${fixture.baseUrl}/step1"`,
        "    assert:",
        "      status: 200",
        "  - name: graphql-step",
        "    request:",
        `      url: "${fixture.baseUrl}/graphql"`,
        "      graphql:",
        '        query: "{ ping }"',
        "  - name: ws-step",
        "    ws:",
        "      url: ws://example.com/socket",
        "",
      ].join("\n"),
      "utf-8",
    );

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

  it("GET /api/<未定義パス>: どの API ルートにもマッチしない場合は静的配信の catch-all 経由で 404(index.html にフォールバックしない)", async () => {
    const res = await fetch(`${base}/api/nonexistent`, {
      headers: { "X-Klaus-Token": klaus.token },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
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

  it("POST /api/runs: path が cwd 外を指す値だと 403(path traversal 拒否)", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
      },
      body: JSON.stringify({ path: "../../../etc/passwd" }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden: path traversal detected");
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

  it("POST /api/runs: Cookie(klaus_token)が無い/値が不一致だと 403(CSRF 対策)", async () => {
    const noCookieRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Klaus-Token": klaus.token },
      body: JSON.stringify({ path: "success.yaml" }),
    });
    expect(noCookieRes.status).toBe(403);

    const mismatchedCookieRes = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: "klaus_token=wrong-token-value",
      },
      body: JSON.stringify({ path: "success.yaml" }),
    });
    expect(mismatchedCookieRes.status).toBe(403);
  });

  it("POST /api/runs: Origin ヘッダーが別オリジンだと 403(CSRF 対策)", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
        Origin: "http://evil.example.com",
      },
      body: JSON.stringify({ path: "success.yaml" }),
    });
    expect(res.status).toBe(403);
  });

  it("GET /?token=<正しいトークン> でクッキー(klaus_token)が発行される", async () => {
    // このテストはテスト実行時の src(未ビルド)を対象にしており、静的配信自体(dist/ui)の
    // 有無・ステータスは対象外。ここでは "/" ミドルウェアが Set-Cookie を発行する分岐のみを見る
    const res = await fetch(`${base}/?token=${klaus.token}`);
    expect(res.headers.get("set-cookie")).toContain(`klaus_token=${klaus.token}`);
  });

  it("同名ヘッダーを複数送るリクエスト(Set-Cookie 等)でも node-bridge が1つずつ変換して正常応答する", async () => {
    // node:http は set-cookie のようなヘッダー名を配列として IncomingMessage.headers に渡す。
    // toWebRequest がこの配列値を1つずつ Web 標準 Headers へ append する分岐を検証する
    const res = await requestWithHeaders(klaus.port, "/api/flows", {
      "X-Klaus-Token": klaus.token,
      "Set-Cookie": ["a=1", "b=2"],
    });
    expect(res.status).toBe(200);
  });

  it("HEAD リクエストはボディ無しレスポンスになり、node-bridge のボディ書き込みをスキップする分岐を通る", async () => {
    // Hono は HEAD を内部的に GET として処理したうえで、レスポンスボディを null にして返す
    // (response.body === null になるため、writeWebResponse は res.write を呼ばず res.end のみ行う)
    const res = await fetch(`${base}/api/flows`, {
      method: "HEAD",
      headers: { "X-Klaus-Token": klaus.token },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("GET /api/flows/detail: request(method明示)/graphql(method省略)/ws のステップ形状が丸め込まれて返る", async () => {
    const res = await fetch(`${base}/api/flows/detail?path=${encodeURIComponent("detail.yaml")}`, {
      headers: { "X-Klaus-Token": klaus.token },
    });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      path: string;
      name: string;
      env?: string;
      steps: Array<{ name: string; method: string; url: string }>;
    };

    expect(detail.name).toBe("detail flow");
    expect(detail.env).toBeUndefined();
    expect(detail.steps).toEqual([
      { name: "get-step", method: "GET", url: `${fixture.baseUrl}/step1` },
      // graphql ステップは method 省略時に実行時既定値 "POST" へ丸め込まれる
      { name: "graphql-step", method: "POST", url: `${fixture.baseUrl}/graphql` },
      // ws ステップは method 固定 "WS"、url は ws.url
      { name: "ws-step", method: "WS", url: "ws://example.com/socket" },
    ]);
  });

  it("GET /api/environments: environments/*.yaml の名前一覧が name でソートされて返る", async () => {
    const res = await fetch(`${base}/api/environments`, {
      headers: { "X-Klaus-Token": klaus.token },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: "local" }, { name: "staging" }]);
  });

  it("GET /api/environments: environments ディレクトリが存在しない場合は空配列を返す", async () => {
    const emptyDir = await mkdtemp(join(tmpRoot, "klaus-server-no-env-"));
    const server = await startServer({ cwd: emptyDir, port: 0 });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/environments`, {
        headers: { "X-Klaus-Token": server.token },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await server.close();
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("POST /api/runs: JSON として不正なボディは 400", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
      },
      body: "not valid json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  it("POST /api/runs: path 未指定は 400", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "path is required" });
  });

  it("POST /api/runs: loadFlow が失敗するフロー(スキーマ検証エラー)は run-result が status: error で配信される", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
      },
      body: JSON.stringify({ path: "broken.yaml" }),
    });
    expect(res.status).toBe(200);

    const events = await collectSseEvents(res);
    // ステップループに入る前に失敗するため step-start/step-result は配信されず、run-result のみになる
    expect(events.map((e) => e.event)).toEqual(["run-result"]);

    const runResult = events[0]?.data as {
      flow: { status: string; steps: Array<{ name: string; status: string; error?: string }> };
    };
    expect(runResult.flow.status).toBe("error");
    expect(runResult.flow.steps).toHaveLength(1);
    expect(runResult.flow.steps[0]?.name).toBe("(flow load)");
    expect(runResult.flow.steps[0]?.status).toBe("error");
    expect(runResult.flow.steps[0]?.error).toBeTruthy();
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

  it("POST /api/request: 単一のリクエスト定義をフロー定義ファイル無しで実行し、同期 JSON で結果を返す", async () => {
    const res = await fetch(`${base}/api/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
      },
      body: JSON.stringify({ request: { method: "GET", url: `${fixture.baseUrl}/step1` } }),
    });
    expect(res.status).toBe(200);

    const payload = (await res.json()) as {
      result: { name: string; status: string; response?: { body: unknown } };
    };
    expect(payload.result.name).toBe("request");
    expect(payload.result.status).toBe("passed");
    expect(payload.result.response?.body).toEqual({ step: 1 });
  });

  it("POST /api/request: request がスキーマ検証エラーだと 400", async () => {
    const res = await fetch(`${base}/api/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
      },
      // method 省略かつ graphql も無いため requestSchema の superRefine で検証エラーになる
      body: JSON.stringify({ request: { url: `${fixture.baseUrl}/step1` } }),
    });
    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBeTruthy();
  });

  it("POST /api/request: env が cwd 外を指す値だと 403(path traversal 拒否)", async () => {
    const res = await fetch(`${base}/api/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
      },
      body: JSON.stringify({
        request: { method: "GET", url: `${fixture.baseUrl}/step1` },
        env: "../../../etc/secrets/prod",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("POST /api/request: JSON として不正なボディは 400", async () => {
    const res = await fetch(`${base}/api/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
      },
      body: "not valid json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON body" });
  });

  it("POST /api/request: ボディ全体が JSON オブジェクトでない(null)場合は 400", async () => {
    const res = await fetch(`${base}/api/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": klaus.token,
        Cookie: `klaus_token=${klaus.token}`,
      },
      // JSON としては妥当だが、トップレベルがオブジェクトでない(null)ため body の
      // 型ガード(!body || typeof body !== "object")に落ちる
      body: "null",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "request is required" });
  });

  describe("GET/PUT /api/environments/:name", () => {
    // 一覧テスト(environments/*.yaml の厳密な一覧比較)へ影響しないよう、専用の workDir・server を使う
    let dir: string;
    let server: StartServerResult;
    let apiBase: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpRoot, "klaus-server-envdetail-"));
      await mkdir(join(dir, "environments"), { recursive: true });
      await writeFile(
        join(dir, "environments", "editable.yaml"),
        "# 環境変数の例\nbaseUrl: http://localhost:4000 # 開発用\ntoken: old-token\n",
        "utf-8",
      );
      // saveEnvironment の書き込み失敗(EnvironmentNotFoundError 以外の例外の rethrow)を
      // 再現するため、読み取りはできるが書き込みはできないファイルを用意する
      const readonlyPath = join(dir, "environments", "readonly.yaml");
      await writeFile(readonlyPath, "baseUrl: http://localhost:4000\n", "utf-8");
      await chmod(readonlyPath, 0o444);
      // $protected($protected: true)を持つ環境ファイル。UI 編集経路が予約キーを
      // 想定していない不具合(issue #53)のリグレッションテスト用
      await writeFile(
        join(dir, "environments", "protected.yaml"),
        "$protected: true\nbaseUrl: http://localhost:4000\ntoken: secret-token\n",
        "utf-8",
      );
      server = await startServer({ cwd: dir, port: 0 });
      apiBase = `http://127.0.0.1:${server.port}`;
    });

    afterAll(async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("GET /api/environments/:name: 環境ファイルの内容を返す", async () => {
      const res = await fetch(`${apiBase}/api/environments/editable`, {
        headers: { "X-Klaus-Token": server.token },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        name: "editable",
        values: { baseUrl: "http://localhost:4000", token: "old-token" },
      });
    });

    it("GET /api/environments/:name: 存在しない環境は 404", async () => {
      const res = await fetch(`${apiBase}/api/environments/nonexistent`, {
        headers: { "X-Klaus-Token": server.token },
      });
      expect(res.status).toBe(404);
    });

    it("GET /api/environments/:name: 正規表現に一致しない環境名は 403", async () => {
      const res = await fetch(`${apiBase}/api/environments/${encodeURIComponent("bad name!")}`, {
        headers: { "X-Klaus-Token": server.token },
      });
      expect(res.status).toBe(403);
    });

    it("PUT /api/environments/:name: env 名が cwd 外を指す場合は 403(path traversal 拒否)", async () => {
      const res = await fetch(`${apiBase}/api/environments/${encodeURIComponent("../secret")}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: JSON.stringify({ values: { baseUrl: "x" } }),
      });
      expect(res.status).toBe(403);
    });

    it("PUT /api/environments/:name: Cookie(klaus_token)が無いと 403(CSRF 対策)", async () => {
      const res = await fetch(`${apiBase}/api/environments/editable`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Klaus-Token": server.token },
        body: JSON.stringify({ values: { baseUrl: "http://localhost:4000" } }),
      });
      expect(res.status).toBe(403);
    });

    it("PUT /api/environments/:name: 存在しない環境は 404", async () => {
      const res = await fetch(`${apiBase}/api/environments/nonexistent`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: JSON.stringify({ values: { baseUrl: "x" } }),
      });
      expect(res.status).toBe(404);
    });

    it("PUT /api/environments/:name: JSON として不正なボディは 400", async () => {
      const res = await fetch(`${apiBase}/api/environments/editable`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: "not valid json",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid JSON body" });
    });

    it("PUT /api/environments/:name: values が省略・配列の場合は 400", async () => {
      const missingRes = await fetch(`${apiBase}/api/environments/editable`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: JSON.stringify({}),
      });
      expect(missingRes.status).toBe(400);
      expect(await missingRes.json()).toEqual({ error: "values is required" });

      const arrayRes = await fetch(`${apiBase}/api/environments/editable`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: JSON.stringify({ values: ["a", "b"] }),
      });
      expect(arrayRes.status).toBe(400);
      expect(await arrayRes.json()).toEqual({ error: "values is required" });
    });

    it("PUT /api/environments/:name: values の値に文字列以外が含まれる場合は 400", async () => {
      const res = await fetch(`${apiBase}/api/environments/editable`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: JSON.stringify({ values: { baseUrl: 123 } }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "values must be a map of string to string" });
    });

    it("PUT /api/environments/:name: ファイル書き込みに失敗すると EnvironmentNotFoundError 以外の例外は 500 で rethrow される", async () => {
      const res = await fetch(`${apiBase}/api/environments/readonly`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: JSON.stringify({ values: { baseUrl: "http://localhost:9999" } }),
      });
      expect(res.status).toBe(500);
    });

    it("PUT /api/environments/:name: 正常時は値を更新してレスポンスとファイルの両方に反映し、コメントを保持する", async () => {
      const res = await fetch(`${apiBase}/api/environments/editable`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: JSON.stringify({ values: { baseUrl: "http://localhost:5000" } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        name: "editable",
        values: { baseUrl: "http://localhost:5000" },
      });

      // token キーは values から消えたため削除され、baseUrl の行コメントは保持される
      const content = await readFile(join(dir, "environments", "editable.yaml"), "utf-8");
      expect(content).toContain("# 環境変数の例");
      expect(content).toContain("baseUrl: http://localhost:5000 # 開発用");
      expect(content).not.toContain("token: old-token");
    });

    it("GET /api/environments/:name: $protected を持つ環境でも values に $protected は含まれない", async () => {
      const res = await fetch(`${apiBase}/api/environments/protected`, {
        headers: { "X-Klaus-Token": server.token },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string; values: Record<string, string> };
      expect(body).toEqual({
        name: "protected",
        values: { baseUrl: "http://localhost:4000", token: "secret-token" },
      });
      expect(Object.hasOwn(body.values, "$protected")).toBe(false);
    });

    it("PUT /api/environments/:name: values に $protected キーを含めると 400", async () => {
      const res = await fetch(`${apiBase}/api/environments/protected`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: JSON.stringify({
          values: { baseUrl: "http://localhost:4000", $protected: "false" },
        }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "$protected is a reserved key and cannot be edited via this API",
      });
    });

    it("PUT /api/environments/:name: $protected を持つ環境の他キー更新後もファイルに $protected: true が残る", async () => {
      const res = await fetch(`${apiBase}/api/environments/protected`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: JSON.stringify({ values: { baseUrl: "http://localhost:9000" } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        name: "protected",
        values: { baseUrl: "http://localhost:9000" },
      });

      const content = await readFile(join(dir, "environments", "protected.yaml"), "utf-8");
      expect(content).toContain("$protected: true");
      expect(content).toContain("baseUrl: http://localhost:9000");
      // token は送信 values に含まれなかったため削除される($protected と異なり通常キーの挙動は不変)
      expect(content).not.toContain("token: secret-token");
    });
  });

  describe("POST /api/environments/:name/capture", () => {
    // 他の describe の workDir に影響を与えないよう専用の workDir・server を使う
    let dir: string;
    let server: StartServerResult;
    let apiBase: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpRoot, "klaus-server-capture-"));
      await mkdir(join(dir, "environments"), { recursive: true });
      await writeFile(
        join(dir, "environments", "capture-target.yaml"),
        "baseUrl: http://localhost:4000\nother: keep-me\n",
        "utf-8",
      );
      // saveEnvironment の書き込み失敗(EnvironmentNotFoundError 以外の例外の rethrow)を
      // 再現するため、読み取りはできるが書き込みはできないファイルを用意する
      const readonlyPath = join(dir, "environments", "readonly-capture.yaml");
      await writeFile(readonlyPath, "baseUrl: http://localhost:4000\n", "utf-8");
      await chmod(readonlyPath, 0o444);
      server = await startServer({ cwd: dir, port: 0 });
      apiBase = `http://127.0.0.1:${server.port}`;
    });

    afterAll(async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    });

    function postCapture(name: string, body: unknown) {
      return fetch(`${apiBase}/api/environments/${encodeURIComponent(name)}/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: JSON.stringify(body),
      });
    }

    it("正常時は抽出した値をキーへ保存し、他の既存キーは失われない", async () => {
      const res = await postCapture("capture-target", {
        key: "token",
        path: "$.token",
        json: { token: "abc123", user: { id: 1 } },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        name: "capture-target",
        values: { baseUrl: "http://localhost:4000", other: "keep-me", token: "abc123" },
      });

      const content = await readFile(join(dir, "environments", "capture-target.yaml"), "utf-8");
      expect(content).toContain("token: abc123");
      expect(content).toContain("other: keep-me");
    });

    it("JSONPath にマッチする値が無い場合は 400", async () => {
      const res = await postCapture("capture-target", {
        key: "missing",
        path: "$.nothing.here",
        json: { token: "abc123" },
      });
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: string };
      expect(payload.error).toContain("matched no value");
    });

    it("抽出した値がオブジェクトの場合は文字列化できないため 400", async () => {
      const res = await postCapture("capture-target", {
        key: "user",
        path: "$.user",
        json: { user: { id: 1 } },
      });
      expect(res.status).toBe(400);
      const payload = (await res.json()) as { error: string };
      expect(payload.error).toContain("cannot save");
    });

    it("存在しない環境は 404", async () => {
      const res = await postCapture("nonexistent", {
        key: "token",
        path: "$.token",
        json: { token: "abc123" },
      });
      expect(res.status).toBe(404);
    });

    it("正規表現に一致しない環境名は 403", async () => {
      const res = await postCapture("bad name!", {
        key: "token",
        path: "$.token",
        json: { token: "abc123" },
      });
      expect(res.status).toBe(403);
    });

    it("JSON として不正なボディは 400", async () => {
      const res = await fetch(`${apiBase}/api/environments/capture-target/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: "not valid json",
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid JSON body" });
    });

    it("key が欠落・空文字の場合は 400", async () => {
      const missingRes = await postCapture("capture-target", {
        path: "$.token",
        json: { token: "abc123" },
      });
      expect(missingRes.status).toBe(400);
      expect(await missingRes.json()).toEqual({ error: "key is required" });

      const blankRes = await postCapture("capture-target", {
        key: "   ",
        path: "$.token",
        json: { token: "abc123" },
      });
      expect(blankRes.status).toBe(400);
      expect(await blankRes.json()).toEqual({ error: "key is required" });
    });

    it("path が文字列でない場合は 400", async () => {
      const res = await postCapture("capture-target", {
        key: "token",
        path: 123,
        json: { token: "abc123" },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "path is required" });
    });

    it("ファイル書き込みに失敗すると EnvironmentNotFoundError 以外の例外は 500 で rethrow される", async () => {
      const res = await postCapture("readonly-capture", {
        key: "token",
        path: "$.token",
        json: { token: "abc123" },
      });
      expect(res.status).toBe(500);
    });
  });

  describe("GET /api/flows(走査時のエッジケース)", () => {
    // 一覧テスト(GET /api/flows: 正常なフローとパースエラーのフローが混在)へ影響しないよう、専用の workDir・server を使う
    let dir: string;
    let server: StartServerResult;
    let apiBase: string;
    let unreadablePath: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpRoot, "klaus-server-flows-edge-"));
      await writeFile(
        join(dir, "valid.yaml"),
        [
          "name: valid flow",
          "steps:",
          "  - name: step1",
          "    request:",
          "      method: GET",
          '      url: "http://example.com"',
          "",
        ].join("\n"),
        "utf-8",
      );
      // YAML 構文自体が壊れていて最上位のキーを判定できないファイルは候補から除外される(collectYamlFiles の parseYaml catch)
      await writeFile(join(dir, "broken-syntax.yaml"), "steps: [\n", "utf-8");
      // 読み取り権限が無いファイルも候補から除外される(collectYamlFiles の readFile catch。クラッシュしない)
      unreadablePath = join(dir, "unreadable.yaml");
      await writeFile(unreadablePath, "name: unreadable flow\nsteps:\n  - name: step1\n", "utf-8");
      await chmod(unreadablePath, 0o000);
      server = await startServer({ cwd: dir, port: 0 });
      apiBase = `http://127.0.0.1:${server.port}`;
    });

    afterAll(async () => {
      // rm --force での削除を確実にするため、権限を落としたファイルは戻してから削除する
      await chmod(unreadablePath, 0o644);
      await server.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("YAML 構文エラー・読み取り不可のファイルは一覧から除外され、正常なファイルのみ返る", async () => {
      const res = await fetch(`${apiBase}/api/flows`, {
        headers: { "X-Klaus-Token": server.token },
      });
      expect(res.status).toBe(200);
      const flows = (await res.json()) as Array<{ path: string }>;
      expect(flows.map((f) => f.path)).toEqual(["valid.yaml"]);
    });
  });

  describe("POST /api/runs: 履歴書き込み失敗時の警告", () => {
    // 他の describe の履歴件数アサーションに影響しないよう、専用の workDir・server を使う
    let dir: string;
    let server: StartServerResult;
    let apiBase: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpRoot, "klaus-server-history-warn-"));
      await writeFile(
        join(dir, "simple.yaml"),
        [
          "name: simple flow",
          "steps:",
          "  - name: step1",
          "    request:",
          "      method: GET",
          `      url: "${fixture.baseUrl}/step1"`,
          "    assert:",
          "      status: 200",
          "",
        ].join("\n"),
        "utf-8",
      );
      // .klaus をディレクトリではなくファイルにしておくと、履歴書き込み時の mkdir(.klaus/history) が
      // ENOTDIR で失敗し、appendHistory の例外を runner が onWarning 経由で通知する分岐を再現できる
      await writeFile(join(dir, ".klaus"), "not a directory", "utf-8");
      server = await startServer({ cwd: dir, port: 0 });
      apiBase = `http://127.0.0.1:${server.port}`;
    });

    afterAll(async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("履歴書き込みに失敗してもフロー実行自体は成功し、stderr に警告が出力される", async () => {
      const stderrWrite = process.stderr.write;
      const stderrSpy: string[] = [];
      process.stderr.write = ((chunk: string) => {
        stderrSpy.push(chunk.toString());
        return true;
      }) as typeof process.stderr.write;

      try {
        const res = await fetch(`${apiBase}/api/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Klaus-Token": server.token,
            Cookie: `klaus_token=${server.token}`,
          },
          body: JSON.stringify({ path: "simple.yaml" }),
        });
        expect(res.status).toBe(200);
        const events = await collectSseEvents(res);
        const runResult = events.find((e) => e.event === "run-result")?.data as {
          flow: { status: string };
        };
        expect(runResult.flow.status).toBe("passed");
      } finally {
        process.stderr.write = stderrWrite;
      }

      expect(stderrSpy.join("")).toContain("klaus ui: warning: failed to write history");
    });
  });

  describe("startServer: host オプション", () => {
    // 0.0.0.0 での listen はテスト環境によっては望ましくないため、host オプションが listen に
    // 正しく渡ることの検証は既定値と同じ "127.0.0.1" を明示指定する形で行う。
    // これにより、明示指定時も(host 省略時と同様に)Host ヘッダーの厳密な allowlist 検証が
    // 維持されること(--host 0.0.0.0 用の緩和ロジックへ誤って倒れていないこと)も合わせて確認する。
    let dir: string;
    let server: StartServerResult;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpRoot, "klaus-server-host-"));
      server = await startServer({ cwd: dir, port: 0, host: "127.0.0.1" });
    });

    afterAll(async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("host: '127.0.0.1' を明示しても 127.0.0.1 で listen し、通常どおり応答する", async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/flows`, {
        headers: { "X-Klaus-Token": server.token },
      });
      expect(res.status).toBe(200);
      expect(server.url).toBe(`http://127.0.0.1:${server.port}/?token=${server.token}`);
    });

    it("host: '127.0.0.1' 明示時も Host ヘッダーの厳密な allowlist 検証は維持される(緩和ロジックへ倒れない)", async () => {
      const res = await requestWithHost(server.port, "/api/flows", "evil.example.com");
      expect(res.status).toBe(403);
    });
  });

  describe("startServer: host: 'localhost' オプション", () => {
    // "localhost" もループバック指定の一種のため、127.0.0.1 明示時と同様に Host ヘッダーの
    // 厳密な allowlist 検証が維持されること(緩和ロジックへ誤って倒れていないこと)を確認する。
    // localhost へのバインドは CI でも安全に行える。
    let dir: string;
    let server: StartServerResult;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpRoot, "klaus-server-host-localhost-"));
      server = await startServer({ cwd: dir, port: 0, host: "localhost" });
    });

    afterAll(async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("host: 'localhost' 明示時も Host ヘッダーの厳密な allowlist 検証は維持される(緩和ロジックへ倒れない)", async () => {
      // 接続先も "localhost" を指定する(環境によって ::1 に解決される場合があり、
      // 実際にバインドしたアドレスと DNS 解決を一致させるため)。
      const res = await requestWithHost(server.port, "/api/flows", "evil.example.com", "localhost");
      expect(res.status).toBe(403);
    });
  });

  describe("createApp: host が非ループバックの場合の Host/Origin 検証緩和", () => {
    // --host 0.0.0.0 相当を検証したいが、実バインドは行わない(CI・テスト環境で望ましくないため)。
    // createApp が返す Hono インスタンスを app.request() で直接叩く: これはネットワークを経由せず
    // Request オブジェクトをそのまま fetch ハンドラへ渡すため、通常の fetch() と異なり
    // Host ヘッダーもそのまま(接続先で上書きされずに)c.req.header("host") に反映される。
    const port = 55555;
    const relaxedToken = "relaxed-host-check-token";
    let app: ReturnType<typeof createApp>;

    beforeAll(() => {
      // workDir は外側の beforeAll で作成済みの共有フローディレクトリ(success.yaml 等)を流用する
      app = createApp({
        cwd: workDir,
        token: relaxedToken,
        port,
        staticDir: workDir,
        host: "0.0.0.0",
      });
    });

    it("任意ホスト名でもポートが一致していれば Host 検証で 403 にならない(緩和が効き、トークン検証まで到達して 200)", async () => {
      const res = await app.request("/api/flows", {
        headers: {
          Host: `arbitrary-host.example.com:${port}`,
          "X-Klaus-Token": relaxedToken,
        },
      });
      expect(res.status).toBe(200);
    });

    it("ポートが不一致の Host は緩和対象でも 403 のまま", async () => {
      const res = await app.request("/api/flows", {
        headers: {
          Host: `arbitrary-host.example.com:${port + 1}`,
          "X-Klaus-Token": relaxedToken,
        },
      });
      expect(res.status).toBe(403);
    });

    it("トークン未指定は緩和時も従来どおり 401(トークン認証は緩和されない)", async () => {
      const res = await app.request("/api/flows", {
        headers: { Host: `arbitrary-host.example.com:${port}` },
      });
      expect(res.status).toBe(401);
    });
  });
});
