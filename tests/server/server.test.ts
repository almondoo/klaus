import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { createParser } from "eventsource-parser";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../../src/core/index.js";
import { appendHistory, OpenApiValidator, readAllHistoryEntries } from "../../src/core/index.js";
import { createApp } from "../../src/server/app.js";
import type { StartServerResult } from "../../src/server/index.js";
import { startServer } from "../../src/server/index.js";
import { closeServer, listenEphemeral } from "../support/net.js";

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

/**
 * Host ヘッダーを一切送らないリクエストを送る。node:http.request は Host ヘッダーを常に
 * 自動付与し、HTTP/1.1 では node:http サーバー自体が Host 欠落を(アプリに届く前に)
 * 400 として弾んでしまうため、HTTP/1.0(Host 必須ではない)のリクエスト行を生ソケットで直接書く。
 */
function requestWithoutHostHeader(port: number, path: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.0\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("end", () => {
      const statusLine = data.split("\r\n")[0] ?? "";
      const match = statusLine.match(/^HTTP\/\d\.\d (\d+)/);
      resolve({ status: match ? Number.parseInt(match[1] as string, 10) : 0 });
    });
    socket.on("error", reject);
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
  const { baseUrl } = await listenEphemeral(server);
  return { server, baseUrl };
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
  cwd: string,
  flowName: string,
  expectedCount: number,
  timeoutMs: number,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let entries: HistoryEntry[] = [];
    try {
      // UTC 日付をまたいでファイルが分かれても拾えるよう全履歴ファイルを読む。
      // readAllHistoryEntries は startedAt 降順なので reverse して実行順(昇順)に戻す
      entries = (await readAllHistoryEntries(cwd))
        .reverse()
        .filter((entry) => entry.flow === flowName);
    } catch {
      // 書き込み途中の読み取り競合などで失敗した場合は空として扱い、リトライする
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
    await closeServer(fixture.server);
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

  it("Host ヘッダー自体が無いと 403(DNS rebinding 対策、値が不一致の場合と同じ拒否)", async () => {
    const res = await requestWithoutHostHeader(klaus.port, "/api/flows");
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

  it("GET /api/flows/detail: loadFlow が ParseError で失敗するフロー(スキーマ検証エラー)は 400 でエラーメッセージが返る", async () => {
    const res = await fetch(`${base}/api/flows/detail?path=${encodeURIComponent("broken.yaml")}`, {
      headers: { "X-Klaus-Token": klaus.token },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.length).toBeGreaterThan(0);
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
    const stepNames = await waitForHistorySteps(workDir, "disconnect flow", 3, 5000);
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
      // $protected: readonly の環境ファイル(UI からの書き込みは true と同様に拒否される)
      await writeFile(
        join(dir, "environments", "protected-readonly.yaml"),
        "$protected: readonly\nbaseUrl: http://localhost:4000\ntoken: secret-token\n",
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

    it.each([
      ["protected", "$protected: true"],
      ["protected-readonly", "$protected: readonly"],
    ])(
      "PUT /api/environments/:name: 保護環境(%s)への書き込みは 403 で拒否され、ファイルは変更されない",
      async (name, marker) => {
        const filePath = join(dir, "environments", `${name}.yaml`);
        const beforeContent = await readFile(filePath, "utf-8");

        const res = await fetch(`${apiBase}/api/environments/${name}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Klaus-Token": server.token,
            Cookie: `klaus_token=${server.token}`,
          },
          body: JSON.stringify({ values: { baseUrl: "http://localhost:9000" } }),
        });

        expect(res.status).toBe(403);
        expect(await res.text()).toBe(
          `Forbidden: environment "${name}" is protected and cannot be edited via this API (edit the file directly)`,
        );
        const afterContent = await readFile(filePath, "utf-8");
        expect(afterContent).toBe(beforeContent);
        expect(afterContent).toContain(marker);
      },
    );

    it("PUT /api/environments/:name: 保護環境でも Cookie(CSRF)が無ければ保護判定より先に 403 で拒否される", async () => {
      const res = await fetch(`${apiBase}/api/environments/protected`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Klaus-Token": server.token },
        body: JSON.stringify({ values: { baseUrl: "http://localhost:9000" } }),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("CSRF");
    });

    it("PUT /api/environments/:name: 保護状態を判定できない(スキーマ違反の)環境ファイルは fail closed で 400", async () => {
      await writeFile(
        join(dir, "environments", "broken.yaml"),
        "$protected: true\nport: 3000\n",
        "utf-8",
      );

      const res = await fetch(`${apiBase}/api/environments/broken`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: JSON.stringify({ values: { port: "3000" } }),
      });

      expect(res.status).toBe(400);
      const content = await readFile(join(dir, "environments", "broken.yaml"), "utf-8");
      expect(content).toContain("$protected: true");
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
      await writeFile(
        join(dir, "environments", "protected-true.yaml"),
        "$protected: true\nbaseUrl: http://localhost:4000\n",
        "utf-8",
      );
      await writeFile(
        join(dir, "environments", "protected-readonly.yaml"),
        "$protected: readonly\nbaseUrl: http://localhost:4000\n",
        "utf-8",
      );
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

    it("key が $protected の場合は 400 で拒否され、ファイルは変更されない", async () => {
      const beforeContent = await readFile(
        join(dir, "environments", "capture-target.yaml"),
        "utf-8",
      );

      const res = await postCapture("capture-target", {
        key: "$protected",
        path: "$.token",
        json: { token: "abc123" },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "$protected is a reserved key and cannot be edited via this API",
      });

      const afterContent = await readFile(
        join(dir, "environments", "capture-target.yaml"),
        "utf-8",
      );
      expect(afterContent).toBe(beforeContent);
    });

    it.each(["protected-true", "protected-readonly"])(
      "保護環境(%s)への capture は 403 で拒否され、ファイルは変更されない",
      async (name) => {
        const filePath = join(dir, "environments", `${name}.yaml`);
        const beforeContent = await readFile(filePath, "utf-8");

        const res = await postCapture(name, {
          key: "token",
          path: "$.token",
          json: { token: "abc123" },
        });

        expect(res.status).toBe(403);
        expect(await res.text()).toBe(
          `Forbidden: environment "${name}" is protected and cannot be edited via this API (edit the file directly)`,
        );
        expect(await readFile(filePath, "utf-8")).toBe(beforeContent);
      },
    );

    it("ファイル書き込みに失敗すると EnvironmentNotFoundError 以外の例外は 500 で rethrow される", async () => {
      const res = await postCapture("readonly-capture", {
        key: "token",
        path: "$.token",
        json: { token: "abc123" },
      });
      expect(res.status).toBe(500);
    });
  });

  describe("guard.allowedHosts(startServer の guard オプション)", () => {
    let dir: string;
    let server: StartServerResult;
    let apiBase: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpRoot, "klaus-server-guard-"));
      await writeFile(
        join(dir, "flow.yaml"),
        [
          "name: guarded flow",
          "steps:",
          "  - name: step1",
          "    request:",
          "      method: GET",
          `      url: "${fixture.baseUrl}/step1"`,
          "",
        ].join("\n"),
        "utf-8",
      );
      await mkdir(join(dir, "environments"), { recursive: true });
      await writeFile(
        join(dir, "environments", "stg.yaml"),
        `$protected: readonly\nbaseUrl: ${fixture.baseUrl}\n`,
        "utf-8",
      );
      server = await startServer({
        cwd: dir,
        port: 0,
        guard: { allowedHosts: ["api.example.com"] },
      });
      apiBase = `http://127.0.0.1:${server.port}`;
    });

    afterAll(async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    });

    function post(path: string, body: unknown) {
      return fetch(`${apiBase}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: JSON.stringify(body),
      });
    }

    it("POST /api/runs: 許可リストに無いホストへのステップは送信されず error になる", async () => {
      const res = await post("/api/runs", { path: "flow.yaml" });
      expect(res.status).toBe(200);

      const events = await collectSseEvents(res);
      const runResult = events.at(-1)?.data as {
        flow: { status: string; steps: Array<{ status: string; error?: string }> };
      };
      expect(runResult.flow.status).toBe("error");
      expect(runResult.flow.steps[0]?.status).toBe("error");
      expect(runResult.flow.steps[0]?.error).toContain("guard.allowedHosts");
    });

    it("POST /api/request: 許可リストに無いホストへの単発リクエストは error になる", async () => {
      const res = await post("/api/request", {
        request: { method: "GET", url: `${fixture.baseUrl}/step1` },
      });
      expect(res.status).toBe(200);

      const payload = (await res.json()) as { result: { status: string; error?: string } };
      expect(payload.result.status).toBe("error");
      expect(payload.result.error).toContain("guard.allowedHosts");
    });

    it('POST /api/request: $protected: "readonly" の環境でも guard は独立に効き、POST は readonly 側の理由で拒否される', async () => {
      // 許可リスト外のため GET もホストで拒否される(readonly とは独立に guard が効く)
      const get = await post("/api/request", {
        request: { method: "GET", url: "{{baseUrl}}/step1" },
        env: "stg",
      });
      const getPayload = (await get.json()) as { result: { error?: string } };
      expect(getPayload.result.error).toContain("guard.allowedHosts");

      const postRes = await post("/api/request", {
        request: { method: "POST", url: "{{baseUrl}}/step1" },
        env: "stg",
      });
      const postPayload = (await postRes.json()) as { result: { error?: string } };
      expect(postPayload.result.error).toContain("refusing POST");
    });
  });

  describe('$protected: "readonly"(guard なしの startServer)', () => {
    let dir: string;
    let server: StartServerResult;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpRoot, "klaus-server-readonly-"));
      await mkdir(join(dir, "environments"), { recursive: true });
      await writeFile(
        join(dir, "environments", "stg.yaml"),
        "$protected: readonly\nbaseUrl: x\n",
        "utf-8",
      );
      for (const method of ["GET", "POST"]) {
        await writeFile(
          join(dir, `${method.toLowerCase()}-flow.yaml`),
          [
            `name: ${method} flow`,
            "env: stg",
            "steps:",
            "  - name: call",
            "    request:",
            `      method: ${method}`,
            `      url: "${fixture.baseUrl}/step1"`,
            "",
          ].join("\n"),
          "utf-8",
        );
      }
      server = await startServer({ cwd: dir, port: 0 });
    });

    afterAll(async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    });

    async function runFlowViaApi(path: string) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": server.token,
          Cookie: `klaus_token=${server.token}`,
        },
        body: JSON.stringify({ path }),
      });
      const events = await collectSseEvents(res);
      const last = events.at(-1)?.data as {
        flow: { steps: Array<{ status: string; error?: string }> };
      };
      return last.flow.steps[0];
    }

    it("POST /api/runs: POST を含むフローは UI 経由でも拒否される(--allow-protected を渡せないため)", async () => {
      const step = await runFlowViaApi("post-flow.yaml");

      expect(step?.status).toBe("error");
      expect(step?.error).toContain("refusing POST");
    });

    it("POST /api/runs: GET のみのフローは readonly でも実行できる", async () => {
      const step = await runFlowViaApi("get-flow.yaml");

      expect(step?.status).toBe("passed");
    });
  });

  describe("UI 起点の履歴の監査項目", () => {
    it("POST /api/runs と POST /api/request の履歴は actor.kind が human で、file は cwd 相対パスになる", async () => {
      const runRes = await fetch(`${base}/api/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": klaus.token,
          Cookie: `klaus_token=${klaus.token}`,
        },
        body: JSON.stringify({ path: "success.yaml" }),
      });
      await collectSseEvents(runRes);
      await fetch(`${base}/api/request`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": klaus.token,
          Cookie: `klaus_token=${klaus.token}`,
        },
        body: JSON.stringify({ request: { method: "GET", url: `${fixture.baseUrl}/step1` } }),
      });

      const entries = await readAllHistoryEntries(workDir);
      const flowEntry = entries.find((entry) => entry.flow === "success flow");
      const singleEntry = entries.find((entry) => entry.source === "single");
      expect(flowEntry?.actor).toEqual({ kind: "human" });
      expect(flowEntry?.file).toBe("success.yaml");
      expect(singleEntry?.actor).toEqual({ kind: "human" });
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

  describe("GET /api/flows/detail: シンボリックリンクによる境界外読み出し", () => {
    // 他の describe の workDir に symlink を仕込むと一覧走査(GET /api/flows)等の他テストに影響しうるため、
    // 専用の workDir・server を使う。境界外の実体を置く outsideDir も別途用意し、afterAll で両方削除する。
    let dir: string;
    let outsideDir: string;
    let server: StartServerResult;
    let apiBase: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpRoot, "klaus-server-symlink-"));
      outsideDir = await mkdtemp(join(tmpRoot, "klaus-server-symlink-outside-"));

      // cwd(dir)の外側に置かれた、本来読めてはいけないファイル
      await writeFile(join(outsideDir, "secret.yaml"), "apiKey: leaked\n", "utf-8");
      // dir 配下に、境界外の secret.yaml を指すシンボリックリンクを仕込む
      // (isPathWithinDir だけの文字列比較では resolve(dir, "linked.yaml") 自体が dir 配下と判定されてしまう)
      await symlink(join(outsideDir, "secret.yaml"), join(dir, "linked.yaml"));

      // 比較対象: シンボリックリンクでない通常のフローファイル(回帰確認用)
      await writeFile(
        join(dir, "normal.yaml"),
        [
          "name: normal flow",
          "steps:",
          "  - name: step1",
          "    request:",
          "      method: GET",
          '      url: "http://example.com"',
          "",
        ].join("\n"),
        "utf-8",
      );

      server = await startServer({ cwd: dir, port: 0 });
      apiBase = `http://127.0.0.1:${server.port}`;
    });

    afterAll(async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    });

    it("path が cwd 配下のシンボリックリンク経由で境界外を指す場合は 403(readFile が追随する前に検知する)", async () => {
      const res = await fetch(
        `${apiBase}/api/flows/detail?path=${encodeURIComponent("linked.yaml")}`,
        {
          headers: { "X-Klaus-Token": server.token },
        },
      );
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden: path traversal detected");
    });

    it("path が通常ファイル(シンボリックリンクでない)を指す場合は従来どおり 200 で読み込める(回帰確認)", async () => {
      const res = await fetch(
        `${apiBase}/api/flows/detail?path=${encodeURIComponent("normal.yaml")}`,
        {
          headers: { "X-Klaus-Token": server.token },
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { name: string };
      expect(body.name).toBe("normal flow");
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

/** GET /api/history/events を購読し、イベントを待ち受けるテスト用クライアント */
async function subscribeHistoryEvents(base: string, token: string) {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/history/events`, {
    headers: { "X-Klaus-Token": token },
    signal: controller.signal,
  });
  const queue: Array<{ event: string; data: unknown }> = [];
  const waiters: Array<() => void> = [];
  const parser = createParser({
    onEvent(event) {
      if (!event.data) return;
      queue.push({ event: event.event ?? "", data: JSON.parse(event.data) });
      for (const w of waiters.splice(0)) w();
    },
  });
  const reader = response.body?.getReader();
  const pump = (async () => {
    if (!reader) return;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
    } catch {
      // abort による中断は想定どおり
    }
  })();

  /** 指定イベントが届くまで待つ(固定 sleep ではなくイベント駆動。タイムアウトは寛容に取る) */
  async function waitFor(eventName: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = queue.findIndex((e) => e.event === eventName);
      if (index >= 0) return queue.splice(index, 1)[0] as { event: string; data: unknown };
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`event "${eventName}" did not arrive in ${timeoutMs}ms`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  return {
    response,
    waitFor,
    ended: pump,
    close: () => controller.abort(),
  };
}

describe("GET /api/history/events", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;
  let klaus: StartServerResult;
  let base: string;

  function entry(runId: string, startedAt: string): HistoryEntry {
    return {
      v: 1,
      runId,
      flow: "events flow",
      step: "s1",
      startedAt,
      durationMs: 1,
      status: "passed",
      assertions: [],
    };
  }

  beforeAll(async () => {
    await mkdir(tmpRoot, { recursive: true });
    // .klaus/history が存在しない状態でサーバーを起動する
    dir = await mkdtemp(join(tmpRoot, "klaus-events-it-"));
    klaus = await startServer({ cwd: dir });
    base = `http://127.0.0.1:${klaus.port}`;
  });

  afterAll(async () => {
    await klaus.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("トークンが無ければ 401、不一致でも 401", async () => {
    expect((await fetch(`${base}/api/history/events`)).status).toBe(401);
    const bad = await fetch(`${base}/api/history/events`, { headers: { "X-Klaus-Token": "x" } });
    expect(bad.status).toBe(401);
  });

  it("履歴ディレクトリが無い状態で購読でき、追記(新規日付ファイル作成)で history イベントが届く", async () => {
    const sub = await subscribeHistoryEvents(base, klaus.token);
    try {
      expect(sub.response.status).toBe(200);
      expect(sub.response.headers.get("content-type")).toContain("text/event-stream");
      await sub.waitFor("ready");

      await appendHistory(dir, entry("r1", "2026-03-01T00:00:00.000Z"));
      const first = await sub.waitFor("history");
      expect(first.data).toMatchObject({ dates: ["2026-03-01"] });
      expect((first.data as { seq: number }).seq).toBeGreaterThanOrEqual(1);

      // 通知は中身を含まず、取得は認証付きの GET /api/history 経由
      const page = await fetch(`${base}/api/history`, {
        headers: { "X-Klaus-Token": klaus.token },
      });
      const body = (await page.json()) as { entries: Array<{ runId: string }> };
      expect(body.entries.map((e) => e.runId)).toEqual(["r1"]);
    } finally {
      sub.close();
    }
  });

  it("ウォッチャーは購読者数の上限を超えると拒否し、解除後は再び購読できる", async () => {
    const { createHistoryWatcher } = await import("../../src/server/history-watcher.js");
    const watcher = createHistoryWatcher(dir, { maxSubscribers: 1 });
    const noop = { onChange: () => {}, onClose: () => {} };
    const first = await watcher.subscribe(noop);
    expect(first).toBeTypeOf("function");
    expect(await watcher.subscribe(noop)).toBeUndefined();
    first?.();
    const again = await watcher.subscribe(noop);
    expect(again).toBeTypeOf("function");
    again?.();
    watcher.close();
  });

  it("サーバー停止でストリームが終了する", async () => {
    const stopDir = await mkdtemp(join(tmpRoot, "klaus-events-stop-"));
    const server = await startServer({ cwd: stopDir });
    try {
      const sub = await subscribeHistoryEvents(`http://127.0.0.1:${server.port}`, server.token);
      await sub.waitFor("ready");
      await server.close();
      // close() が購読を終わらせるので、ストリームの読み取りが完了する
      await sub.ended;
    } finally {
      await rm(stopDir, { recursive: true, force: true });
    }
  });

  it("クライアント切断後も再購読できる", async () => {
    const sub = await subscribeHistoryEvents(base, klaus.token);
    await sub.waitFor("ready");
    sub.close();
    await sub.ended;
    const again = await subscribeHistoryEvents(base, klaus.token);
    try {
      await again.waitFor("ready");
    } finally {
      again.close();
    }
  });
});

describe("http 設定(startServer の http オプション)", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;
  let target: ReturnType<typeof createServer>;
  let targetBase: string;
  let plain: StartServerResult;
  let following: StartServerResult;

  function post(server: StartServerResult, path: string, body: unknown) {
    return fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": server.token,
        Cookie: `klaus_token=${server.token}`,
      },
      body: JSON.stringify(body),
    });
  }

  async function singleStatus(server: StartServerResult, body: unknown): Promise<number> {
    const res = await post(server, "/api/request", body);
    const payload = (await res.json()) as { result: { response?: { status: number } } };
    return payload.result.response?.status ?? 0;
  }

  async function flowStatus(server: StartServerResult, body: unknown): Promise<number> {
    const events = await collectSseEvents(await post(server, "/api/runs", body));
    const last = events.at(-1)?.data as {
      flow: { steps: Array<{ response?: { status: number } }> };
    };
    return last.flow.steps[0]?.response?.status ?? 0;
  }

  beforeAll(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-server-http-"));
    target = createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/final" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ final: true }));
    });
    targetBase = (await listenEphemeral(target)).baseUrl;
    await writeFile(
      join(dir, "redirect.yaml"),
      [
        "name: redirect flow",
        "steps:",
        "  - name: go",
        "    request:",
        "      method: GET",
        `      url: "${targetBase}/redirect"`,
        "",
      ].join("\n"),
      "utf-8",
    );
    plain = await startServer({ cwd: dir, port: 0 });
    following = await startServer({ cwd: dir, port: 0, http: { followRedirects: true } });
  });

  afterAll(async () => {
    await plain.close();
    await following.close();
    await closeServer(target);
    await rm(dir, { recursive: true, force: true });
  });

  const single = { request: { method: "GET", url: "" } };

  it("http 未指定なら従来どおりリダイレクトを追わない(POST /api/request・POST /api/runs)", async () => {
    expect(
      await singleStatus(plain, { request: { ...single.request, url: `${targetBase}/redirect` } }),
    ).toBe(302);
    expect(await flowStatus(plain, { path: "redirect.yaml" })).toBe(302);
  });

  it("http.followRedirects を渡すと POST /api/request と POST /api/runs の両方に効く", async () => {
    expect(
      await singleStatus(following, {
        request: { ...single.request, url: `${targetBase}/redirect` },
      }),
    ).toBe(200);
    expect(await flowStatus(following, { path: "redirect.yaml" })).toBe(200);
  });

  it("リクエストボディの http は無視される(設定は起動時に渡したものだけ)", async () => {
    const url = `${targetBase}/redirect`;
    expect(
      await singleStatus(plain, {
        request: { ...single.request, url },
        http: { followRedirects: true },
      }),
    ).toBe(302);
    expect(
      await flowStatus(plain, { path: "redirect.yaml", http: { followRedirects: true } }),
    ).toBe(302);
  });
});

describe("保護環境の拒否メッセージ(UI 起点のフロー実行)", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;
  let server: StartServerResult;

  async function runStepError(
    path: string,
  ): Promise<{ stream: string; error: string | undefined }> {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": server.token,
        Cookie: `klaus_token=${server.token}`,
      },
      body: JSON.stringify({ path }),
    });
    const events = await collectSseEvents(res);
    const last = events.at(-1)?.data as { flow: { steps: Array<{ error?: string }> } };
    const stepResult = events.find((e) => e.event === "step-result")?.data as {
      result: { error?: string };
    };
    return { stream: stepResult.result.error ?? "", error: last.flow.steps[0]?.error };
  }

  beforeAll(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-server-hint-"));
    await mkdir(join(dir, "environments"), { recursive: true });
    await writeFile(join(dir, "environments", "prod.yaml"), "$protected: true\nbaseUrl: x\n");
    await writeFile(join(dir, "environments", "stg.yaml"), "$protected: readonly\nbaseUrl: x\n");
    for (const [file, env, method] of [
      ["blocked.yaml", "prod", "GET"],
      ["readonly-post.yaml", "stg", "POST"],
    ]) {
      await writeFile(
        join(dir, file as string),
        [
          `name: ${file}`,
          `env: ${env}`,
          "steps:",
          "  - name: call",
          "    request:",
          `      method: ${method}`,
          '      url: "http://127.0.0.1:9/x"',
          "",
        ].join("\n"),
      );
    }
    server = await startServer({ cwd: dir, port: 0 });
  });

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it.each(["blocked.yaml", "readonly-post.yaml"])(
    "%s: core が UI 向けの案内(--allow-protected を渡せない旨)を生成し、ストリームの step-result と run-result の両方に反映される",
    async (path) => {
      const { stream, error } = await runStepError(path);
      for (const text of [stream, error ?? ""]) {
        expect(text).toContain("protected");
        expect(text).not.toContain("Pass --allow-protected");
        expect(text).toContain("klaus ui cannot override environment protection");
        expect(text).toContain("klaus run --allow-protected");
      }
    },
  );

  it("履歴に記録される拒否理由も、利用者が実際に見た UI 向けの案内になる", async () => {
    const entries = await readAllHistoryEntries(dir);
    const recorded = entries.find((entry) => entry.step === "call" && entry.error);
    expect(recorded?.error).toContain("klaus ui cannot override environment protection");
    expect(recorded?.error).not.toContain("Pass --allow-protected");
  });
});

/** 履歴の差分・フロー保存の API 用に、決定的な履歴を書き込むヘルパー */
function runEntries(
  runId: string,
  startedAt: string,
  variant: { status: string; createdAt: string; flow?: string },
): HistoryEntry[] {
  const flow = variant.flow ?? "orders";
  const t = (ms: number) => new Date(Date.parse(startedAt) + ms).toISOString();
  return [
    {
      v: 1,
      runId,
      flow,
      step: "create",
      startedAt: t(0),
      durationMs: 5,
      status: "passed",
      request: {
        method: "POST",
        url: "http://localhost:4000/orders",
        headers: { "content-type": "application/json" },
        body: { name: "widget" },
      },
      response: {
        status: 201,
        headers: { "content-type": "application/json" },
        body: { id: "order-12345678", name: "widget", createdAt: variant.createdAt },
      },
      assertions: [],
    },
    {
      v: 1,
      runId,
      flow,
      step: "get",
      startedAt: t(10),
      durationMs: 5,
      status: "passed",
      request: {
        method: "GET",
        url: "http://localhost:4000/orders/order-12345678",
        headers: {},
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { id: "order-12345678", status: variant.status },
      },
      assertions: [],
    },
  ];
}

describe("GET /api/history/diff と POST /api/history/promote", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;
  let outside: string;
  let server: StartServerResult;
  let base: string;

  const auth = () => ({ "X-Klaus-Token": server.token });
  const authWrite = () => ({
    "Content-Type": "application/json",
    "X-Klaus-Token": server.token,
    Cookie: `klaus_token=${server.token}`,
  });
  const getDiff = (query: string) =>
    fetch(`${base}/api/history/diff?${query}`, { headers: auth() });
  const promote = (body: unknown) =>
    fetch(`${base}/api/history/promote`, {
      method: "POST",
      headers: authWrite(),
      body: JSON.stringify(body),
    });

  async function exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  beforeAll(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-server-diffpromote-"));
    outside = await mkdtemp(join(tmpRoot, "klaus-server-outside-"));
    const seed: HistoryEntry[] = [
      ...runEntries("run-a", "2026-05-01T00:00:00.000Z", {
        status: "new",
        createdAt: "2026-05-01T00:00:00Z",
      }),
      ...runEntries("run-b", "2026-05-02T00:00:00.000Z", {
        status: "shipped",
        createdAt: "2026-05-02T00:00:00Z",
      }),
      // 2 つのフローが混在する run(promote に flow の指定が必要)
      ...runEntries("run-mixed", "2026-05-03T00:00:00.000Z", {
        status: "new",
        createdAt: "x",
        flow: "alpha",
      }).slice(0, 1),
      ...runEntries("run-mixed", "2026-05-03T00:00:01.000Z", {
        status: "new",
        createdAt: "x",
        flow: "beta",
      }).slice(0, 1),
      // マスク済みのヘッダー(OS 環境変数の値)を含む単発リクエスト
      {
        v: 1,
        runId: "run-single",
        flow: "(single)",
        step: "ping",
        startedAt: "2026-05-04T00:00:00.000Z",
        durationMs: 1,
        status: "passed",
        source: "single",
        request: {
          method: "GET",
          url: "http://localhost:4000/ping",
          headers: { "x-api-key": "***" },
        },
        response: { status: 200, headers: {}, body: { ok: true } },
        assertions: [],
      },
      // リテラルの "{{" を含む記録(生成は拒否される)
      {
        v: 1,
        runId: "run-template",
        flow: "(single)",
        step: "tmpl",
        startedAt: "2026-05-05T00:00:00.000Z",
        durationMs: 1,
        status: "passed",
        source: "single",
        request: {
          method: "POST",
          url: "http://localhost:4000/x",
          headers: {},
          body: { note: "hello {{env.SECRET_TOKEN}}" },
        },
        response: { status: 200, headers: {}, body: { ok: true } },
        assertions: [],
      },
      // 全ステップが skipped の run(フロー化できるステップが無い)
      {
        v: 1,
        runId: "run-skipped",
        flow: "skipped-flow",
        step: "only",
        startedAt: "2026-05-06T00:00:00.000Z",
        durationMs: 0,
        status: "skipped",
        assertions: [],
      },
    ];
    for (const entry of seed) await appendHistory(dir, entry);
    server = await startServer({ cwd: dir, port: 0 });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  describe("GET /api/history/diff", () => {
    it("トークンが無ければ 401", async () => {
      expect((await fetch(`${base}/api/history/diff?a=run-a&b=run-b`)).status).toBe(401);
    });

    it("2 つの run の差分を返す(klaus diff --json から version を除いた形)", async () => {
      const res = await getDiff("a=run-a&b=run-b");
      expect(res.status).toBe(200);
      const diff = (await res.json()) as {
        status: string;
        version?: number;
        runs: { a: { runId: string }; b: { runId: string } };
        counts: { same: number; different: number };
        steps: Array<{
          step: string;
          change: string;
          body?: { kind: string; differences: Array<{ path: string; kind: string }> };
        }>;
      };
      expect(diff.version).toBeUndefined();
      expect(diff.status).toBe("different");
      expect(diff.runs.a.runId).toBe("run-a");
      expect(diff.runs.b.runId).toBe("run-b");
      expect(diff.counts.different).toBe(2);
      const get = diff.steps.find((step) => step.step === "get");
      expect(get?.body?.differences.map((d) => d.path)).toEqual(["$.status"]);
    });

    it("ignorePath(繰り返し指定)で差分から除外され、全て除外すると same になる", async () => {
      const res = await getDiff(
        `a=run-a&b=run-b&ignorePath=${encodeURIComponent("$.status")}&ignorePath=${encodeURIComponent("$..createdAt")}`,
      );
      const diff = (await res.json()) as { status: string; counts: { same: number } };
      expect(diff.status).toBe("same");
      expect(diff.counts.same).toBe(2);
    });

    it("flow 指定の latest / previous を解決できる", async () => {
      const res = await getDiff(`a=previous&b=latest&flow=orders`);
      expect(res.status).toBe(200);
      const diff = (await res.json()) as { runs: { a: { runId: string }; b: { runId: string } } };
      expect(diff.runs.a.runId).toBe("run-a");
      expect(diff.runs.b.runId).toBe("run-b");
    });

    it.each([
      ["b が無い", "a=run-a"],
      ["a が空", "a=&b=run-b"],
      ["run ID の形式が不正", "a=run-a&b=../etc/passwd"],
      ["a が複数", "a=run-a&a=run-b&b=run-b"],
      ["run ID に ASCII 以外の紛らわしい文字(キリル文字)", "a=run-a&b=run-%D0%B0"],
      ["run ID にバックスラッシュ", "a=run-a&b=run-b%5Cx"],
      ["run ID が prototype 汚染を狙う名前", "a=__proto__&b=run-b"],
      ["flow が制御文字を含む", `a=run-a&b=run-b&flow=${encodeURIComponent("x\ny")}`],
      ["latest は flow が必須", "a=latest&b=run-b"],
      ["ignorePath が JSONPath として解釈できない", "a=run-a&b=run-b&ignorePath=nope"],
      [
        "ignorePath の .. が多すぎる",
        `a=run-a&b=run-b&ignorePath=${encodeURIComponent("$..a..b..c")}`,
      ],
    ])("400: %s", async (_label, query) => {
      const res = await getDiff(query);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error.length).toBeGreaterThan(0);
    });

    it("400: ignorePath が多すぎる(21 個)", async () => {
      const query = Array.from({ length: 21 }, () => `ignorePath=${encodeURIComponent("$.x")}`);
      const res = await getDiff(`a=run-a&b=run-b&${query.join("&")}`);
      expect(res.status).toBe(400);
    });

    it("404: 存在しない run、flow に該当する run が無い", async () => {
      expect((await getDiff("a=run-a&b=no-such-run")).status).toBe(404);
      expect((await getDiff("a=no-such-run&b=run-b")).status).toBe(404);
      // run-single は flow "orders" のエントリを持たない
      expect((await getDiff("a=run-a&b=run-single&flow=orders")).status).toBe(404);
      expect((await getDiff("a=previous&b=latest&flow=unknown-flow")).status).toBe(404);
    });
  });

  describe("POST /api/history/promote", () => {
    it("トークンが無ければ 401、CSRF Cookie が無ければ 403", async () => {
      const noToken = await fetch(`${base}/api/history/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runIds: ["run-a"], dryRun: true }),
      });
      expect(noToken.status).toBe(401);
      const noCookie = await fetch(`${base}/api/history/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth() },
        body: JSON.stringify({ runIds: ["run-a"], dryRun: true }),
      });
      expect(noCookie.status).toBe(403);
      const badOrigin = await fetch(`${base}/api/history/promote`, {
        method: "POST",
        headers: { ...authWrite(), Origin: "http://evil.example.com" },
        body: JSON.stringify({ runIds: ["run-a"], dryRun: true }),
      });
      expect(badOrigin.status).toBe(403);
      expect(await exists(join(dir, "flows"))).toBe(false);
    });

    it("dryRun: YAML とサマリーを返し、何も書かない", async () => {
      const res = await promote({ runIds: ["run-a"], dryRun: true });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        dryRun: boolean;
        written: boolean;
        file: string;
        exists: boolean;
        yaml: string;
        steps: unknown[];
        notice: string;
        captures: Array<{ name: string }>;
      };
      expect(body).toMatchObject({ dryRun: true, written: false, file: "flows/orders.yaml" });
      expect(body.exists).toBe(false);
      expect(body.yaml).toContain("name: orders");
      expect(body.steps).toHaveLength(2);
      expect(body.notice).toContain("sensitive");
      // 先行ステップのレスポンス値(id)が後続のリクエスト URL に再登場するため capture が推論される
      expect(body.captures.length).toBeGreaterThan(0);
      expect(await exists(join(dir, "flows"))).toBe(false);
      expect(await exists(join(dir, "api"))).toBe(false);
    });

    it("オプション(assert / baseUrlVar / name / out)が反映され、マスク済みの値はプレースホルダーとして返る", async () => {
      const res = await promote({
        runIds: ["run-single", "run-a"],
        assert: "status",
        baseUrlVar: "BASE_URL",
        chain: false,
        name: "my flow",
        out: "flows/custom/my-flow.yaml",
        dryRun: true,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        file: string;
        flow: string;
        assert: string;
        yaml: string;
        variables: Array<{ name: string; value: string }>;
        placeholders: Array<{ name: string }>;
        captures: unknown[];
      };
      expect(body.file).toBe("flows/custom/my-flow.yaml");
      expect(body.flow).toBe("my flow");
      expect(body.assert).toBe("status");
      expect(body.variables).toEqual([{ name: "BASE_URL", value: "http://localhost:4000" }]);
      expect(body.yaml).toContain("{{BASE_URL}}");
      expect(body.yaml).toContain("{{env.TODO_");
      expect(body.placeholders.length).toBeGreaterThan(0);
      expect(body.captures).toEqual([]);
      expect(body.yaml).not.toContain("***");
      expect(await exists(join(dir, "flows", "custom"))).toBe(false);
    });

    it("書き込み: 新規ファイルを作り、フロー一覧に現れ、2 回目は 409 で内容を変えない", async () => {
      const res = await promote({ runIds: ["run-b"], out: "flows/written/orders.yaml" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { written: boolean; file: string; yaml: string };
      expect(body).toMatchObject({ written: true, file: "flows/written/orders.yaml" });
      const onDisk = await readFile(join(dir, "flows", "written", "orders.yaml"), "utf-8");
      expect(onDisk).toBe(body.yaml);

      const flows = (await (
        await fetch(`${base}/api/flows`, { headers: auth() })
      ).json()) as Array<{
        path: string;
      }>;
      expect(flows.map((f) => f.path)).toContain("flows/written/orders.yaml");

      const dry = await promote({
        runIds: ["run-b"],
        out: "flows/written/orders.yaml",
        dryRun: true,
      });
      expect(((await dry.json()) as { exists: boolean }).exists).toBe(true);

      const again = await promote({ runIds: ["run-a"], out: "flows/written/orders.yaml" });
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: string }).error).toContain("already exists");
      expect(await readFile(join(dir, "flows", "written", "orders.yaml"), "utf-8")).toBe(onDisk);
    });

    it("既存のフローファイルは上書きされない(409)", async () => {
      await mkdir(join(dir, "flows", "manual"), { recursive: true });
      await writeFile(join(dir, "flows", "manual", "keep.yaml"), "sentinel: true\n", "utf-8");
      const res = await promote({ runIds: ["run-a"], out: "flows/manual/keep.yaml" });
      expect(res.status).toBe(409);
      expect(await readFile(join(dir, "flows", "manual", "keep.yaml"), "utf-8")).toBe(
        "sentinel: true\n",
      );
    });

    it.each([
      ["親ディレクトリへの脱出", "../escape.yaml"],
      ["絶対パス", "/tmp/klaus-escape.yaml"],
      ["拡張子が yaml / yml ではない", "flows/x.txt"],
      ["隠しディレクトリ", ".git/hooks/x.yaml"],
      ["フロー探索の対象外ディレクトリ(environments)", "environments/x.yaml"],
      ["フロー探索の対象外ディレクトリ(node_modules)", "node_modules/x.yaml"],
      ["設定ファイル名", "klaus.config.yaml"],
      ["cwd 自身", "."],
    ])("403: 出力先の規則 — %s", async (_label, out) => {
      const res = await promote({ runIds: ["run-a"], out });
      expect(res.status).toBe(403);
      expect(await exists(join(dir, "..", "escape.yaml"))).toBe(false);
      expect(await exists(join(dir, "klaus.config.yaml"))).toBe(false);
      expect(await exists(join(dir, "environments"))).toBe(false);
      // dryRun でも同じ規則で拒否される
      const dry = await promote({ runIds: ["run-a"], out, dryRun: true });
      expect(dry.status).toBe(403);
    });

    it("403: cwd の外を指すシンボリックリンク(途中のディレクトリ・最終要素)経由では書かない", async () => {
      await mkdir(join(dir, "flows"), { recursive: true });
      await symlink(outside, join(dir, "flows", "linkdir"));
      const viaDir = await promote({ runIds: ["run-a"], out: "flows/linkdir/x.yaml" });
      expect(viaDir.status).toBe(403);

      await mkdir(join(dir, "flows", "final"), { recursive: true });
      await symlink(join(outside, "created.yaml"), join(dir, "flows", "final", "f.yaml"));
      const viaFile = await promote({ runIds: ["run-a"], out: "flows/final/f.yaml" });
      expect(viaFile.status).toBe(403);

      expect(await readdir(outside)).toEqual([]);
    });

    it.each([
      ["JSON として不正な本文", "{not json"],
      ["runIds が無い", {}],
      ["runIds が空", { runIds: [] }],
      ["runIds が文字列", { runIds: "run-a" }],
      ["run ID の形式が不正", { runIds: ["../x"] }],
      ["runIds が多すぎる", { runIds: Array.from({ length: 51 }, (_, i) => `r${i}`) }],
      ["assert が不正", { runIds: ["run-a"], assert: "everything" }],
      ["baseUrlVar が不正", { runIds: ["run-a"], baseUrlVar: "not valid!" }],
      ["chain が真偽値ではない", { runIds: ["run-a"], chain: "yes" }],
      ["name が空", { runIds: ["run-a"], name: "" }],
      ["out が文字列ではない", { runIds: ["run-a"], out: 1 }],
      ["force は UI に無い", { runIds: ["run-a"], force: true }],
      ["allowTemplateLiterals は UI に無い", { runIds: ["run-a"], allowTemplateLiterals: true }],
      ["本文が配列", [1]],
    ])("400: %s", async (_label, body) => {
      const res = await fetch(`${base}/api/history/promote`, {
        method: "POST",
        headers: authWrite(),
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    });

    it("400(usage): 複数フローを含む run は flow の指定が必要で、指定すれば生成できる", async () => {
      const res = await promote({ runIds: ["run-mixed"], dryRun: true });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { kind: string }).kind).toBe("usage");

      const ok = await promote({ runIds: ["run-mixed"], flow: "alpha", dryRun: true });
      expect(ok.status).toBe(200);
    });

    it("404: 履歴に無い runId", async () => {
      const res = await promote({ runIds: ["run-a", "no-such-run"], dryRun: true });
      expect(res.status).toBe(404);
    });

    it("422: 記録値にリテラルの {{ があるとテンプレート展開による漏洩を防ぐため拒否する(dryRun でも書き込みでも)", async () => {
      for (const dryRun of [true, false]) {
        const res = await promote({ runIds: ["run-template"], dryRun, out: "tmpl/x.yaml" });
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: string; kind: string; code?: string };
        expect(body.kind).toBe("content");
        expect(body.code).toBe("template-literal");
        expect(body.error).toContain("{{");
      }
      expect(await exists(join(dir, "tmpl"))).toBe(false);
    });

    it("422: フロー化できるステップが無い run", async () => {
      const res = await promote({ runIds: ["run-skipped"], dryRun: true });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; code?: string };
      expect(body.error).toContain("no promotable steps");
      expect(body.code).toBeUndefined();
    });
  });
});

describe("OpenAPI(startServer の openapi オプション)", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;
  let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
  let withSpec: StartServerResult;
  let withoutSpec: StartServerResult;

  async function runFlow(server: StartServerResult, body: unknown) {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": server.token,
        Cookie: `klaus_token=${server.token}`,
      },
      body: JSON.stringify(body),
    });
    const events = await collectSseEvents(res);
    return events.at(-1)?.data as {
      flow: {
        status: string;
        steps: Array<{
          assertions: Array<{ kind: string; ok: boolean; openapi?: { state: string } }>;
        }>;
      };
      warnings?: string[];
      openapi?: { operations: { total: number; covered: number }; violations: number };
    };
  }

  beforeAll(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-server-openapi-"));
    fixture = await startFixtureServer();
    const response = (type: string) => ({
      "200": {
        description: "ok",
        content: {
          "application/json": {
            schema: { type: "object", required: ["step"], properties: { step: { type } } },
          },
        },
      },
    });
    await writeFile(
      join(dir, "api.json"),
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "t", version: "1" },
        servers: [{ url: fixture.baseUrl }],
        paths: {
          "/step1": { get: { responses: response("integer") } },
          "/step2": { get: { responses: response("string") } },
          "/unused": { get: { responses: response("integer") } },
        },
      }),
    );
    for (const [file, steps] of [
      ["ok.yaml", ["step1"]],
      ["bad.yaml", ["step1", "step2"]],
    ] as const) {
      await writeFile(
        join(dir, file),
        [
          `name: ${file}`,
          "steps:",
          ...steps.flatMap((s) => [
            `  - name: ${s}`,
            "    request:",
            "      method: GET",
            `      url: "${fixture.baseUrl}/${s}"`,
          ]),
          "",
        ].join("\n"),
      );
    }
    withSpec = await startServer({ cwd: dir, port: 0, openapi: [join(dir, "api.json")] });
    withoutSpec = await startServer({ cwd: dir, port: 0 });
  });

  afterAll(async () => {
    await withSpec.close();
    await withoutSpec.close();
    await closeServer(fixture.server);
    await rm(dir, { recursive: true, force: true });
  });

  it("run.openapi 相当を渡すと、応答が仕様に照らして検証され、カバレッジが run-result に載る", async () => {
    const ok = await runFlow(withSpec, { path: "ok.yaml" });
    expect(ok.flow.status).toBe("passed");
    expect(ok.flow.steps[0]?.assertions.find((a) => a.kind === "openapi")?.openapi?.state).toBe(
      "valid",
    );
    expect(ok.openapi?.operations).toMatchObject({ total: 3, covered: 1 });

    const bad = await runFlow(withSpec, { path: "bad.yaml" });
    expect(bad.flow.status).toBe("failed");
    const states = bad.flow.steps.map(
      (s) => s.assertions.find((a) => a.kind === "openapi")?.openapi?.state,
    );
    expect(states).toEqual(["valid", "invalid"]);
    expect(bad.openapi?.violations).toBe(1);
    // 検証器は実行ごとに作るため、カバレッジは前の実行に引きずられない
    expect(bad.openapi?.operations.covered).toBe(2);
  });

  it("openapi を渡さなければ検証せず、リクエストボディの openapi も受け付けない", async () => {
    const result = await runFlow(withoutSpec, {
      path: "ok.yaml",
      openapi: [join(dir, "api.json")],
    });
    expect(result.flow.status).toBe("passed");
    expect(result.openapi).toBeUndefined();
    expect(result.flow.steps[0]?.assertions.some((a) => a.kind === "openapi")).toBe(false);
  });

  describe("検証器(ワーカースレッド)の後始末", () => {
    async function waitUntil(condition: () => boolean, timeoutMs = 5000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error("condition was not met in time");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    it("成功・失敗・実行前の例外・クライアント切断のどの終わり方でも、実行ごとに作った検証器を必ず close する", async () => {
      await writeFile(
        join(dir, "envbad.yaml"),
        [
          "name: envbad",
          "env: no-such-env",
          "steps:",
          "  - name: s",
          "    request:",
          "      method: GET",
          `      url: "${fixture.baseUrl}/step1"`,
          "",
        ].join("\n"),
      );
      await writeFile(
        join(dir, "slow.yaml"),
        [
          "name: slow",
          "steps:",
          ...[1, 2, 3].flatMap((n) => [
            `  - name: d${n}`,
            "    request:",
            "      method: GET",
            `      url: "${fixture.baseUrl}/delay"`,
          ]),
          "",
        ].join("\n"),
      );
      const load = vi.spyOn(OpenApiValidator, "load");
      const close = vi.spyOn(OpenApiValidator.prototype, "close");
      try {
        await runFlow(withSpec, { path: "ok.yaml" });
        await runFlow(withSpec, { path: "bad.yaml" });
        // 環境ファイルが無く、ステップに入る前に例外になる(検証器は作成済み)
        const envbad = await runFlow(withSpec, { path: "envbad.yaml" });
        expect(envbad.flow.status).toBe("error");
        expect(load).toHaveBeenCalledTimes(3);
        expect(close).toHaveBeenCalledTimes(3);

        // 実行の途中でクライアントが切断しても、フローは最後まで走り、その後に close される
        const controller = new AbortController();
        const res = await fetch(`http://127.0.0.1:${withSpec.port}/api/runs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Klaus-Token": withSpec.token,
            Cookie: `klaus_token=${withSpec.token}`,
          },
          body: JSON.stringify({ path: "slow.yaml" }),
          signal: controller.signal,
        });
        await res.body?.getReader().read();
        controller.abort();
        await waitUntil(() => close.mock.calls.length === 4);
        expect(load).toHaveBeenCalledTimes(4);
      } finally {
        load.mockRestore();
        close.mockRestore();
      }
    });

    it("OpenAPI を使った実行の後でも、サーバーの close が待たされない", async () => {
      const server = await startServer({ cwd: dir, port: 0, openapi: [join(dir, "api.json")] });
      const result = await runFlow(server, { path: "bad.yaml" });
      expect(result.openapi).toBeDefined();
      const started = Date.now();
      await server.close();
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  it("読めない仕様は実行前のエラーとして返り、ステップは送信されない", async () => {
    const broken = await startServer({ cwd: dir, port: 0, openapi: [join(dir, "missing.json")] });
    try {
      const result = await runFlow(broken, { path: "ok.yaml" });
      expect(result.flow.status).toBe("error");
    } finally {
      await broken.close();
    }
  });
});

describe("GET /api/snapshots/mismatches と POST /api/snapshots/accept", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;
  let outside: string;
  let server: StartServerResult;
  let base: string;

  const auth = () => ({ "X-Klaus-Token": server.token });
  const authWrite = () => ({
    "Content-Type": "application/json",
    "X-Klaus-Token": server.token,
    Cookie: `klaus_token=${server.token}`,
  });
  const list = (runId: string) =>
    fetch(`${base}/api/snapshots/mismatches?runId=${encodeURIComponent(runId)}`, {
      headers: auth(),
    });
  const accept = (body: unknown) =>
    fetch(`${base}/api/snapshots/accept`, {
      method: "POST",
      headers: authWrite(),
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  function snapshotEntry(
    runId: string,
    step: string,
    file: string,
    key: string,
    state: "mismatch" | "missing" | "matched",
    extra: Partial<HistoryEntry> = {},
  ): HistoryEntry {
    return {
      v: 1,
      runId,
      flow: "orders",
      step,
      startedAt: "2026-06-01T00:00:00.000Z",
      durationMs: 1,
      status: state === "matched" ? "passed" : "failed",
      file: "orders.yaml",
      assertions: [
        {
          ok: state === "matched",
          kind: "snapshot",
          message: `snapshot ${state}`,
          snapshot: {
            key,
            file,
            state,
            ...(state === "mismatch"
              ? {
                  differences: [
                    { path: "$.body.status", kind: "changed", before: "new", after: "shipped" },
                  ],
                  differenceCount: 1,
                }
              : {}),
            ...(state !== "matched"
              ? { candidate: { status: 200, body: { status: "shipped" } } }
              : {}),
          },
        },
      ],
      ...extra,
    };
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  beforeAll(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-server-snap-"));
    outside = await mkdtemp(join(tmpRoot, "klaus-server-snap-outside-"));
    await mkdir(join(dir, "environments"), { recursive: true });
    await writeFile(join(dir, "environments", "dev.yaml"), "baseUrl: x\n");
    await writeFile(join(dir, "environments", "prod.yaml"), "$protected: true\nbaseUrl: x\n");
    await writeFile(join(dir, "environments", "stg.yaml"), "$protected: readonly\nbaseUrl: x\n");
    const snap = "__snapshots__/orders.snap.json";
    for (const entry of [
      snapshotEntry("run-ok", "get", snap, "get", "mismatch", { env: "dev" }),
      snapshotEntry("run-ok", "create", snap, "create", "missing", { env: "dev" }),
      snapshotEntry("run-ok", "same", snap, "same", "matched", { env: "dev" }),
      snapshotEntry("run-none", "same", snap, "same", "matched"),
      snapshotEntry("run-prod", "get", snap, "get", "mismatch", { env: "prod" }),
      snapshotEntry("run-stg", "get", snap, "get", "mismatch", { env: "stg" }),
      snapshotEntry("run-ghost", "get", snap, "get", "mismatch", { env: "ghost" }),
      snapshotEntry("run-envfile", "get", snap, "get", "mismatch", { env: "../x.yaml" }),
      snapshotEntry("run-corrupt", "get", "bad/__snapshots__/c.snap.json", "get", "mismatch"),
      snapshotEntry("run-link", "get", "__snapshots__/link.snap.json", "get", "mismatch"),
      // 同じステップの他のアサーションが失敗している(その応答は基準にできない)
      snapshotEntry("run-failed", "get", "__snapshots__/failed.snap.json", "get", "mismatch", {
        assertions: [
          { ok: false, kind: "status", message: "expected status 200, got 500" },
          {
            ok: false,
            kind: "snapshot",
            message: "snapshot mismatch",
            snapshot: {
              key: "get",
              file: "__snapshots__/failed.snap.json",
              state: "mismatch",
              differences: [{ path: "$.status", kind: "changed", before: 200, after: 500 }],
              differenceCount: 1,
              candidate: { status: 500, body: { error: "boom" } },
            },
          },
        ],
      }),
    ]) {
      await appendHistory(dir, entry);
    }
    await mkdir(join(dir, "bad", "__snapshots__"), { recursive: true });
    await writeFile(join(dir, "bad", "__snapshots__", "c.snap.json"), "{not json", "utf-8");
    await mkdir(join(dir, "__snapshots__"), { recursive: true });
    await symlink(join(outside, "target.snap.json"), join(dir, "__snapshots__", "link.snap.json"));
    server = await startServer({ cwd: dir, port: 0 });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  describe("GET /api/history(承認用の候補は返さない)", () => {
    it("履歴の snapshot アサーションから candidate を取り除き、他の内容は保つ(履歴ファイル自体は変えない)", async () => {
      const res = await fetch(`${base}/api/history?limit=100`, { headers: auth() });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain("candidate");
      const page = JSON.parse(text) as {
        entries: Array<{
          runId: string;
          assertions: Array<{ snapshot?: { state: string; key: string } }>;
        }>;
      };
      const entry = page.entries.find(
        (e) => e.runId === "run-ok" && e.assertions[0]?.snapshot?.state === "mismatch",
      );
      expect(entry?.assertions[0]?.snapshot).toMatchObject({ key: "get", state: "mismatch" });
      // 承認に必要な候補はサーバー側の履歴に残っている
      const stored = await readAllHistoryEntries(dir);
      expect(JSON.stringify(stored)).toContain("candidate");
    });
  });

  describe("GET /api/snapshots/mismatches", () => {
    it("トークンが無ければ 401", async () => {
      expect((await fetch(`${base}/api/snapshots/mismatches?runId=run-ok`)).status).toBe(401);
    });

    it("承認待ち(mismatch / missing)だけを実行順に返し、候補(candidate)は含めない", async () => {
      const res = await list("run-ok");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        runId: string;
        acceptRefusal?: string;
        mismatches: Array<{
          step: string;
          state: string;
          key: string;
          snapshotFile: string;
          differenceCount: number;
        }>;
      };
      expect(body.runId).toBe("run-ok");
      expect(body.acceptRefusal).toBeUndefined();
      expect(body.mismatches.map((m) => [m.step, m.state])).toEqual([
        ["get", "mismatch"],
        ["create", "missing"],
      ]);
      expect(body.mismatches[0]).toMatchObject({
        snapshotFile: "__snapshots__/orders.snap.json",
        key: "get",
        differenceCount: 1,
      });
      expect(JSON.stringify(body)).not.toContain("candidate");
    });

    it("承認待ちが無い run は 200 の空配列、履歴に無い run は 404", async () => {
      const none = await list("run-none");
      expect(none.status).toBe(200);
      expect(((await none.json()) as { mismatches: unknown[] }).mismatches).toEqual([]);
      expect((await list("no-such-run")).status).toBe(404);
    });

    it.each([
      ["runId が無い", ""],
      ["runId が不正", "?runId=../x"],
      ["runId が複数", "?runId=run-ok&runId=run-none"],
    ])("400: %s", async (_label, query) => {
      const res = await fetch(`${base}/api/snapshots/mismatches${query}`, { headers: auth() });
      expect(res.status).toBe(400);
    });

    it.each(["run-prod", "run-stg", "run-ghost", "run-envfile"])(
      "%s: 保護環境の run(または環境を判定できない run)は承認を拒否する理由を返す",
      async (runId) => {
        const body = (await (await list(runId)).json()) as {
          acceptRefusal?: string;
          mismatches: unknown[];
        };
        expect(body.mismatches).toHaveLength(1);
        expect(body.acceptRefusal).toBeTruthy();
      },
    );
  });

  describe("POST /api/snapshots/accept", () => {
    it("トークンが無ければ 401、CSRF Cookie が無い・Origin が不正なら 403(何も書かない)", async () => {
      const payload = JSON.stringify({
        runId: "run-ok",
        snapshotFile: "__snapshots__/orders.snap.json",
        key: "get",
      });
      const noToken = await fetch(`${base}/api/snapshots/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      expect(noToken.status).toBe(401);
      const noCookie = await fetch(`${base}/api/snapshots/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...auth() },
        body: payload,
      });
      expect(noCookie.status).toBe(403);
      const badOrigin = await fetch(`${base}/api/snapshots/accept`, {
        method: "POST",
        headers: { ...authWrite(), Origin: "http://evil.example.com" },
        body: payload,
      });
      expect(badOrigin.status).toBe(403);
      expect(await exists(join(dir, "__snapshots__", "orders.snap.json"))).toBe(false);
    });

    it("承認すると基準ファイルに書き込まれ(written)、他のキーは変えず、再承認は置き換え(updated)になる", async () => {
      const file = join(dir, "__snapshots__", "orders.snap.json");
      const first = await accept({
        runId: "run-ok",
        snapshotFile: "__snapshots__/orders.snap.json",
        key: "get",
      });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({
        ok: true,
        state: "written",
        snapshotFile: "__snapshots__/orders.snap.json",
        key: "get",
      });
      expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({
        get: { status: 200, body: { status: "shipped" } },
      });

      const second = await accept({
        runId: "run-ok",
        snapshotFile: "__snapshots__/orders.snap.json",
        key: "create",
      });
      expect(((await second.json()) as { state: string }).state).toBe("written");
      const third = await accept({
        runId: "run-ok",
        snapshotFile: "__snapshots__/orders.snap.json",
        key: "get",
      });
      expect(((await third.json()) as { state: string }).state).toBe("updated");
      expect(Object.keys(JSON.parse(await readFile(file, "utf-8"))).sort()).toEqual([
        "create",
        "get",
      ]);
    });

    it.each([
      ["JSON として不正", "{nope"],
      ["本文がオブジェクトではない", "[1]"],
      ["runId が無い", { snapshotFile: "__snapshots__/orders.snap.json", key: "get" }],
      [
        "runId が不正",
        { runId: "../x", snapshotFile: "__snapshots__/orders.snap.json", key: "get" },
      ],
      ["snapshotFile が無い", { runId: "run-ok", key: "get" }],
      ["snapshotFile が制御文字を含む", { runId: "run-ok", snapshotFile: "a\nb", key: "get" }],
      ["key が空", { runId: "run-ok", snapshotFile: "__snapshots__/orders.snap.json", key: "" }],
      [
        "key が文字列ではない",
        { runId: "run-ok", snapshotFile: "__snapshots__/orders.snap.json", key: 1 },
      ],
      [
        "未知のフィールド",
        {
          runId: "run-ok",
          snapshotFile: "__snapshots__/orders.snap.json",
          key: "get",
          candidate: {},
        },
      ],
    ])("400: %s", async (_label, body) => {
      expect((await accept(body)).status).toBe(400);
    });

    it("403: 承認待ちとして返っていない cwd 外のパスは拒否され、何も書かれない", async () => {
      for (const snapshotFile of [
        "../outside/__snapshots__/x.snap.json",
        `${outside}/__snapshots__/x.snap.json`,
      ]) {
        const res = await accept({ runId: "run-ok", snapshotFile, key: "get" });
        expect(res.status).toBe(403);
      }
      expect(await readdir(outside)).toEqual([]);
    });

    it("404: 承認待ちの組でないもの(cwd 内の別ファイル・別キー・承認待ちでないキー)は拒否され、何も書かれない", async () => {
      const cases = [
        { runId: "run-ok", snapshotFile: "other/__snapshots__/x.snap.json", key: "get" },
        { runId: "run-ok", snapshotFile: "__snapshots__/orders.snap.json", key: "nope" },
        { runId: "run-ok", snapshotFile: "__snapshots__/orders.snap.json", key: "same" },
        { runId: "no-such-run", snapshotFile: "__snapshots__/orders.snap.json", key: "get" },
      ];
      for (const body of cases) expect((await accept(body)).status).toBe(404);
      expect(await exists(join(dir, "other"))).toBe(false);
    });

    it("承認待ちの組と大文字小文字・Unicode が違うパスやキーは 404、バックスラッシュを含むパスは 403(何も書かれない)", async () => {
      const file = "__snapshots__/orders.snap.json";
      for (const body of [
        { runId: "run-ok", snapshotFile: "__Snapshots__/orders.snap.json", key: "get" },
        { runId: "run-ok", snapshotFile: "__SNAPSHOTS__/ORDERS.SNAP.JSON", key: "get" },
        { runId: "run-ok", snapshotFile: file, key: "GET" },
        { runId: "run-ok", snapshotFile: "__snapshots__/orde\u0301rs.snap.json", key: "get" },
      ]) {
        expect((await accept(body)).status).toBe(404);
      }
      for (const snapshotFile of [
        "__snapshots__\\orders.snap.json",
        "..\\x\\__snapshots__\\y.snap.json",
      ]) {
        expect((await accept({ runId: "run-ok", snapshotFile, key: "get" })).status).toBe(403);
      }
      expect(await readdir(outside)).toEqual([]);
      expect((await readdir(join(dir, "__snapshots__"))).sort()).toEqual([
        "link.snap.json",
        "orders.snap.json",
      ]);
    });

    it("__proto__ や constructor などの未知のキーを本文に含めると 400", async () => {
      for (const raw of [
        '{"runId":"run-ok","snapshotFile":"__snapshots__/orders.snap.json","key":"get","__proto__":{"x":1}}',
        '{"runId":"run-ok","snapshotFile":"__snapshots__/orders.snap.json","key":"get","constructor":{}}',
      ]) {
        expect((await accept(raw)).status).toBe(400);
      }
    });

    it.each(["run-prod", "run-stg", "run-ghost", "run-envfile"])(
      "403: %s は保護環境(または判定不能)のため承認できず、何も書かれない",
      async (runId) => {
        const res = await accept({
          runId,
          snapshotFile: "__snapshots__/orders.snap.json",
          key: "get",
        });
        expect(res.status).toBe(403);
        expect(await res.text()).toContain("Forbidden");
      },
    );

    it("422: 既存のスナップショットファイルが壊れている場合は書き換えない", async () => {
      const res = await accept({
        runId: "run-corrupt",
        snapshotFile: "bad/__snapshots__/c.snap.json",
        key: "get",
      });
      expect(res.status).toBe(422);
      expect(await readFile(join(dir, "bad", "__snapshots__", "c.snap.json"), "utf-8")).toBe(
        "{not json",
      );
    });

    it("409: 同じステップの他のアサーションが失敗している項目は承認できず(失敗した応答を基準にしない)、何も書かれない", async () => {
      const listed = (await (await list("run-failed")).json()) as {
        mismatches: Array<{ otherAssertionsFailed: boolean }>;
      };
      expect(listed.mismatches.map((m) => m.otherAssertionsFailed)).toEqual([true]);
      const ok = (await (await list("run-ok")).json()) as {
        mismatches: Array<{ otherAssertionsFailed: boolean }>;
      };
      expect(ok.mismatches.every((m) => m.otherAssertionsFailed === false)).toBe(true);

      const res = await accept({
        runId: "run-failed",
        snapshotFile: "__snapshots__/failed.snap.json",
        key: "get",
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toContain("other assertions failed");
      expect(await exists(join(dir, "__snapshots__", "failed.snap.json"))).toBe(false);
    });

    it("403: 承認待ちの書き込み先がシンボリックリンクなら core が拒否し、リンク先には書かれない", async () => {
      const res = await accept({
        runId: "run-link",
        snapshotFile: "__snapshots__/link.snap.json",
        key: "get",
      });
      expect(res.status).toBe(403);
      expect(await readdir(outside)).toEqual([]);
    });
  });
});

describe("POST /api/history/promote の出力先(許可リスト・大文字小文字・Unicode)", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;
  let outside: string;
  let server: StartServerResult;
  let base: string;

  const flowYaml = (name: string) =>
    `name: ${name}\nsteps:\n  - name: s\n    request:\n      method: GET\n      url: http://localhost:1/x\n`;
  const promote = (body: unknown) =>
    fetch(`${base}/api/history/promote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": server.token,
        Cookie: `klaus_token=${server.token}`,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const attempt = (out: string, dryRun = false) => promote({ runIds: ["run-a"], out, dryRun });

  beforeAll(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-server-promote-out-"));
    outside = await mkdtemp(join(tmpRoot, "klaus-server-promote-outside-"));
    for (const entry of runEntries("run-a", "2026-05-01T00:00:00.000Z", {
      status: "new",
      createdAt: "x",
    })) {
      await appendHistory(dir, entry);
    }
    // 既にフローがあるディレクトリ(ちょうどそこだけが保存先になれる)。NFC の非 ASCII 名も含める
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "existing.yaml"), flowYaml("existing"));
    await mkdir(join(dir, "caf\u00e9"), { recursive: true });
    await writeFile(join(dir, "caf\u00e9", "existing.yaml"), flowYaml("cafe"));
    // 環境ファイル(フロー探索の対象外)
    await mkdir(join(dir, "environments"), { recursive: true });
    await writeFile(join(dir, "environments", "dev.yaml"), "baseUrl: x\n");
    server = await startServer({ cwd: dir, port: 0 });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("許可される場所: 既にフローがあるディレクトリ、api/、flows/ とその配下", async () => {
    for (const out of [
      "sub/new.yaml",
      "api/n.yaml",
      "flows/n.yml",
      "flows/deep/er/n.yaml",
      "caf\u00e9/new.yaml",
    ]) {
      expect((await attempt(out, true)).status, out).toBe(200);
    }
    // Unicode の合成形が違う表記でも、同じディレクトリとして許可リストに一致する
    expect((await attempt("cafe\u0301/new2.yaml", true)).status).toBe(200);
  });

  it("許可されない場所: フローが無いディレクトリ・cwd 直下・既存フローのディレクトリの配下は 403", async () => {
    for (const out of [
      "other/n.yaml",
      "n.yaml",
      "sub/deeper/n.yaml",
      "sub/../other/n.yaml",
      "api2/n.yaml",
    ]) {
      expect((await attempt(out, true)).status, out).toBe(403);
    }
  });

  it.each([
    "Node_Modules/x.yaml",
    "NODE_MODULES/x.yaml",
    "Environments/prod.yaml",
    "ENVIRONMENTS/dev2.yaml",
    "TMP/x.yaml",
    "Dist/x.yaml",
    "UI/x.yaml",
    ".Git/x.yaml",
    ".KLAUS/x.yaml",
    "flows/.Git/x.yaml",
    "sub/.Hidden/x.yaml",
    "flows/Node_Modules/x.yaml",
    "flows/ENVIRONMENTS/x.yaml",
    "KLAUS.CONFIG.YAML",
    "Klaus.Config.Yml",
    "flows/Klaus.Config.Yaml",
    "flows/.hidden.yaml",
  ])(
    "403: 大文字小文字を変えた除外ディレクトリ・隠し要素・設定ファイル名 — %s(dryRun でも書き込みでも、何も作られない)",
    async (out) => {
      for (const dryRun of [true, false]) {
        expect((await attempt(out, dryRun)).status).toBe(403);
      }
      const created = (await readdir(dir)).map((name) => name.toLowerCase());
      expect(created.sort()).toEqual([".klaus", "café", "environments", "sub"].sort());
      expect(await readdir(join(dir, "environments"))).toEqual(["dev.yaml"]);
    },
  );

  it("403: バックスラッシュを含むパスは一律に拒否し、リテラルなファイル名のファイルも作らない", async () => {
    for (const out of ["flows\\..\\..\\y.yaml", "flows\\x.yaml", "api/a\\b.yaml", "..\\y.yaml"]) {
      expect((await attempt(out)).status, out).toBe(403);
    }
    expect((await readdir(dir)).some((name) => name.includes("\\"))).toBe(false);
    expect(await exists(join(dir, "flows"))).toBe(false);
  });

  it("書き込み: 許可された場所には書かれ、同じ場所への 2 回目は 409", async () => {
    expect((await attempt("sub/written.yaml")).status).toBe(200);
    expect(await readFile(join(dir, "sub", "written.yaml"), "utf-8")).toContain("name: orders");
    expect((await attempt("sub/written.yaml")).status).toBe(409);
  });

  it("403: 宙づり(行き先が無い)のシンボリックリンクは、許可された場所の名前でも書かない(ディレクトリ・最終要素とも)", async () => {
    // api は実在しないパスへの宙づりリンク。flows 配下に最終要素が宙づりのリンクを置く
    await symlink(join(outside, "nope"), join(dir, "api"));
    await mkdir(join(dir, "flows"), { recursive: true });
    await symlink(join(outside, "created.yaml"), join(dir, "flows", "dangling.yaml"));
    expect((await attempt("api/x.yaml")).status).toBe(403);
    expect((await attempt("api/x.yaml", true)).status).toBe(403);
    expect((await attempt("flows/dangling.yaml")).status).toBe(403);
    expect(await readdir(outside)).toEqual([]);
  });

  it("400: __proto__ や constructor など未知のキーを本文に含めると拒否する(out などは反映されない)", async () => {
    for (const raw of [
      '{"runIds":["run-a"],"dryRun":true,"__proto__":{"out":"x.yaml"}}',
      '{"runIds":["run-a"],"dryRun":true,"constructor":{"prototype":{"out":"x.yaml"}}}',
      '{"runIds":["__proto__"],"dryRun":true}',
    ]) {
      expect((await promote(raw)).status, raw).toBe(400);
    }
    expect(Object.hasOwn({}, "out")).toBe(false);
  });

  async function exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
});

describe("klaus server: ブラウザへ送るライブ結果の Cookie マスク", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  const RAW_SID = "SESSION-RAW-1";
  let dir: string;
  let target: ReturnType<typeof createServer>;
  let server: StartServerResult;
  let apiBase: string;

  beforeAll(async () => {
    target = createServer((_req, res) => {
      res.writeHead(200, { "Set-Cookie": `sid=${RAW_SID}; Path=/`, "X-Plain": "visible" });
      res.end("ok");
    });
    const { baseUrl } = await listenEphemeral(target);
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-server-cookie-"));
    await writeFile(
      join(dir, "flow.yaml"),
      [
        "name: cookie flow",
        "steps:",
        "  - name: login",
        "    request:",
        "      method: GET",
        `      url: "${baseUrl}/login"`,
        "      headers:",
        `        Cookie: "sid=${RAW_SID}"`,
        "",
      ].join("\n"),
      "utf-8",
    );
    server = await startServer({ cwd: dir, port: 0 });
    apiBase = `http://127.0.0.1:${server.port}`;
    urls.target = baseUrl;
  });

  afterAll(async () => {
    await server.close();
    await closeServer(target);
    await rm(dir, { recursive: true, force: true });
  });

  const urls = { target: "" };

  function post(path: string, body: unknown) {
    return fetch(`${apiBase}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Klaus-Token": server.token,
        Cookie: `klaus_token=${server.token}`,
      },
      body: JSON.stringify(body),
    });
  }

  it("POST /api/runs の step-result / run-result は Cookie・Set-Cookie の値が ***(他のヘッダーはそのまま)", async () => {
    const events = await collectSseEvents(await post("/api/runs", { path: "flow.yaml" }));
    const stepResult = events.find((e) => e.event === "step-result");
    if (!stepResult) throw new Error("step-result event was not delivered");
    const text = JSON.stringify(events);
    expect(text).not.toContain(RAW_SID);
    const result = (
      stepResult.data as {
        result: {
          request: { headers: Record<string, string> };
          response: { headers: Record<string, string> };
        };
      }
    ).result;
    expect(result.request.headers.Cookie).toBe("sid=***");
    expect(result.response.headers["set-cookie"]).toBe("sid=***; Path=/");
    expect(result.response.headers["x-plain"]).toBe("visible");
  });

  it("POST /api/request の結果も Cookie・Set-Cookie の値が ***", async () => {
    const res = await post("/api/request", {
      request: {
        method: "GET",
        url: `${urls.target}/login`,
        headers: { Cookie: `sid=${RAW_SID}` },
      },
    });
    const text = await res.text();
    expect(text).not.toContain(RAW_SID);
    const payload = JSON.parse(text) as {
      result: { response: { headers: Record<string, string> } };
    };
    expect(payload.result.response.headers["set-cookie"]).toBe("sid=***; Path=/");
  });
});
