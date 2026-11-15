import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isHostHeaderAllowed, registerMockCommand, startMockServer } from "../../src/cli/mock.js";
import { appendCassetteEntry, cassetteFilePath } from "../../src/core/cassette.js";

const noopLog = () => {};

describe("klaus mock", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;
  let closers: Array<() => Promise<void>>;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-mock-"));
    closers = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const close of closers) await close();
    await rm(dir, { recursive: true, force: true });
  });

  async function record(
    method: string,
    url: string,
    bodyText: string,
    extra: { status?: number; headers?: Record<string, string> } = {},
  ): Promise<void> {
    await appendCassetteEntry(dir, {
      v: 1,
      method,
      url,
      status: extra.status ?? 200,
      headers: extra.headers ?? { "content-type": "application/json" },
      bodyText,
    });
  }

  async function start(options: Parameters<typeof startMockServer>[1] = {}) {
    const mock = await startMockServer(dir, { port: 0, ...options }, noopLog);
    closers.push(mock.close);
    return mock;
  }

  /** stdout / stderr を捕捉する */
  function captureOutput() {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      err.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    return { out, err };
  }

  it("記録した status・ヘッダー・ボディをそのまま返し、マスク済みの *** も維持する", async () => {
    await record("GET", "http://api.example.com/me", '{"token":"***"}', {
      status: 201,
      headers: {
        "content-type": "application/json",
        "content-length": "999",
        "x-custom": "v",
      },
    });
    const mock = await start();

    const res = await fetch(`${mock.url}/me`);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("v");
    expect(res.headers.get("content-length")).toBe(String('{"token":"***"}'.length));
    expect(await res.text()).toBe('{"token":"***"}');
  });

  it("未マッチは 404 で method/path と近い記録済みパスを返し、記録済みボディは含めない", async () => {
    await record("GET", "http://h/users/1", "PRIVATE-BODY");
    const mock = await start();

    const res = await fetch(`${mock.url}/users/2?x=1`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: "no recorded response",
      method: "GET",
      path: "/users/2",
      closest: ["GET /users/1"],
    });
    expect(text).not.toContain("PRIVATE-BODY");
  });

  it("sequence で記録順に返し、尽きたら最後を繰り返す", async () => {
    await record("GET", "http://h/n", "1");
    await record("GET", "http://h/n", "2");
    const mock = await start({ sequence: true });

    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) bodies.push(await (await fetch(`${mock.url}/n`)).text());
    expect(bodies).toEqual(["1", "2", "2"]);
  });

  it("ignoreQuery で query が違っても path で返す", async () => {
    await record("GET", "http://h/x?a=1", "hit");
    const mock = await start({ ignoreQuery: true });
    expect(await (await fetch(`${mock.url}/x?b=2`)).text()).toBe("hit");
  });

  it("--cors 指定時のみ CORS ヘッダーを付け、preflight に 204 で答える", async () => {
    await record("POST", "http://h/p", "ok");
    const plain = await start();
    const plainRes = await fetch(`${plain.url}/nope`);
    expect(plainRes.headers.get("access-control-allow-origin")).toBeNull();
    const plainPreflight = await fetch(`${plain.url}/p`, {
      method: "OPTIONS",
      headers: { "access-control-request-method": "POST", origin: "http://x" },
    });
    expect(plainPreflight.status).toBe(404);

    const cors = await start({ cors: true });
    const preflight = await fetch(`${cors.url}/p`, {
      method: "OPTIONS",
      headers: { "access-control-request-method": "POST", origin: "http://x" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    const hit = await fetch(`${cors.url}/p`, { method: "POST" });
    expect(hit.status).toBe(200);
    expect(hit.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("--delay の分だけ応答が遅れる", async () => {
    await record("GET", "http://h/d", "ok");
    const mock = await start({ delay: 150 });
    const started = performance.now();
    await fetch(`${mock.url}/d`);
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
  });

  it("衝突は起動時に警告ログとして通知する", async () => {
    await record("GET", "http://a.example.com/p", "a");
    await record("GET", "http://b.example.com/p", "b");
    const events: unknown[] = [];
    const mock = await startMockServer(dir, { port: 0 }, (e) => events.push(e));
    closers.push(mock.close);
    expect(events).toEqual([
      {
        event: "warning",
        message: expect.stringContaining('collision on "GET /p"'),
      },
    ]);
  });

  it("カセットが無い・不正・空(origin 不一致含む)は exit 2、不正な --origin 値は exit 1", async () => {
    const { mockCommand } = await import("../../src/cli/mock.js");
    const { err } = captureOutput();

    expect(await mockCommand(dir, { port: 0 })).toBe(2);
    expect(err.join("")).toContain("failed to read cassette file");

    await writeFile(cassetteFilePath(dir), "{broken\n", "utf-8");
    expect(await mockCommand(dir, { port: 0 })).toBe(2);

    await writeFile(cassetteFilePath(dir), "", "utf-8");
    expect(await mockCommand(dir, { port: 0 })).toBe(2);
    expect(err.join("")).toContain("no recorded responses");

    await record("GET", "http://a.example.com/p", "a");
    expect(await mockCommand(dir, { port: 0, origin: "http://other.example.com" })).toBe(2);
    expect(await mockCommand(dir, { port: 0, origin: "not a url" })).toBe(1);
    expect(err.join("")).toContain("invalid --origin");
  });

  it("mockCommand は起動 URL を stdout に出し、abort で停止して 0 を返す(--json は JSON 行)", async () => {
    await record("GET", "http://h/j", "ok");
    const { out, err } = captureOutput();
    const controller = new AbortController();

    const running = import("../../src/cli/mock.js").then((m) =>
      m.mockCommand(dir, { port: 0, json: true }, controller.signal),
    );
    await vi.waitFor(() => expect(out.length).toBeGreaterThan(0));
    const startup = JSON.parse(out.join(""));
    expect(startup).toMatchObject({ event: "listening", routes: 1, origins: ["http://h"] });

    await fetch(`${startup.url}/j`);
    await fetch(`${startup.url}/missing`);
    controller.abort();
    expect(await running).toBe(0);
    const logs = err
      .join("")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logs).toEqual([
      { event: "request", method: "GET", path: "/j", status: 200, matched: true },
      { event: "request", method: "GET", path: "/missing", status: 404, matched: false },
    ]);
    await expect(fetch(`${startup.url}/j`)).rejects.toThrow();
  });

  /** 生のリクエストターゲットを指定して送る(fetch は absolute-form や * を送れないため) */
  function rawRequest(
    url: string,
    method: string,
    path: string,
  ): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = httpRequest({ host: u.hostname, port: u.port, method, path }, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("リクエストターゲットはパスとして解釈する(// は host にならず、absolute-form は path を使い、* は 400)", async () => {
    await record("GET", "http://h/users", "ok");
    const mock = await start();

    expect((await rawRequest(mock.url, "GET", "//evil.com/users")).status).toBe(404);
    expect((await rawRequest(mock.url, "GET", "/caf%E9%zz?q=%")).status).toBe(404);
    const absolute = await rawRequest(mock.url, "GET", "http://other.example.com/users");
    expect(absolute.status).toBe(200);
    expect(absolute.body).toBe("ok");
    expect((await rawRequest(mock.url, "OPTIONS", "*")).status).toBe(400);
  });

  it("記録済みの 204 はボディも content-length も無く、HEAD は GET と同じ content-length でボディ無し", async () => {
    await record("DELETE", "http://h/r", "left over", { status: 204 });
    await record("GET", "http://h/page", "hello");
    const mock = await start();

    const noContent = await rawRequest(mock.url, "DELETE", "/r");
    expect(noContent.status).toBe(204);
    expect(noContent.body).toBe("");
    expect(noContent.headers["content-length"]).toBeUndefined();

    const head = await rawRequest(mock.url, "HEAD", "/page");
    expect(head.status).toBe(404);
    await record("HEAD", "http://h/page", "hello");
    const mock2 = await start();
    const headHit = await rawRequest(mock2.url, "HEAD", "/page");
    expect(headHit.status).toBe(200);
    expect(headHit.body).toBe("");
    expect(headHit.headers["content-length"]).toBe("5");
  });

  it("記録済みの access-control-* は --cors なしでは落とし、--cors 時は mock 自身の値に置き換える", async () => {
    await record("GET", "http://h/c", "ok", {
      headers: { "access-control-allow-origin": "https://upstream.example.com" },
    });
    const plain = await start();
    expect((await fetch(`${plain.url}/c`)).headers.get("access-control-allow-origin")).toBeNull();
    const cors = await start({ cors: true });
    expect((await fetch(`${cors.url}/c`)).headers.get("access-control-allow-origin")).toBe("*");
  });

  /** Host ヘッダーを上書きして GET /h を送り、ステータスと本文を返す */
  function requestWithHost(
    url: string,
    host: string | undefined,
  ): Promise<{ status: number; body: string; cors: unknown }> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = httpRequest(
        { host: u.hostname, port: u.port, path: "/h", headers: host === undefined ? {} : { host } },
        (res) => {
          let body = "";
          res.on("data", (c) => {
            body += c;
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body,
              cors: res.headers["access-control-allow-origin"],
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("ループバック bind では 127.0.0.1 / localhost / [::1] の実ポートだけを許可し、リバインディング風の Host は 403(--cors でも緩めない)", async () => {
    await record("GET", "http://h/h", "private");
    const mock = await start({ cors: true });
    const port = new URL(mock.url).port;

    for (const host of [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      `LOCALHOST:${port}`,
    ]) {
      const ok = await requestWithHost(mock.url, host);
      expect(ok.status, host).toBe(200);
      expect(ok.body).toBe("private");
    }
    for (const host of [`evil.example:${port}`, "127.0.0.1:1", "127.0.0.1", "evil.example"]) {
      const denied = await requestWithHost(mock.url, host);
      expect(denied.status, host).toBe(403);
      expect(denied.body).not.toContain("private");
      expect(denied.cors).toBeUndefined();
    }
  });

  it("--allow-host で追加したホスト名は(実ポート付きで)許可され、他は引き続き 403", async () => {
    await record("GET", "http://h/h", "private");
    const mock = await start({ allowHost: ["Mock-Service"] });
    const port = new URL(mock.url).port;

    expect((await requestWithHost(mock.url, `mock-service:${port}`)).status).toBe(200);
    expect((await requestWithHost(mock.url, "mock-service:1")).status).toBe(403);
    expect((await requestWithHost(mock.url, `evil.example:${port}`)).status).toBe(403);
  });

  it("isHostHeaderAllowed: ループバック以外への bind ではポート一致のみ確認する", () => {
    expect(isHostHeaderAllowed("mock.internal:4885", 4885, "0.0.0.0")).toBe(true);
    expect(isHostHeaderAllowed("192.168.1.5:4885", 4885, "0.0.0.0")).toBe(true);
    expect(isHostHeaderAllowed("mock.internal:9999", 4885, "0.0.0.0")).toBe(false);
    expect(isHostHeaderAllowed(undefined, 4885, "0.0.0.0")).toBe(false);
    expect(isHostHeaderAllowed("mock.internal:4885", 4885, "127.0.0.1")).toBe(false);
  });

  it("registerMockCommand はオプションを解釈し、不正な --port を拒否する", async () => {
    const program = new Command().exitOverride();
    registerMockCommand(program);
    const mock = program.commands.find((c) => c.name() === "mock");
    expect(mock?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining([
        "--port",
        "--host",
        "--cors",
        "--delay",
        "--ignore-query",
        "--sequence",
        "--origin",
        "--allow-host",
        "--json",
      ]),
    );
    captureOutput();
    program.configureOutput({ writeErr: () => {} });
    mock?.configureOutput({ writeErr: () => {} });
    await expect(
      program.parseAsync(["node", "klaus", "mock", dir, "--port", "abc"]),
    ).rejects.toThrow(/invalid --port value/);
    await expect(
      program.parseAsync(["node", "klaus", "mock", dir, "--port", "99999"]),
    ).rejects.toThrow(/invalid --port value/);
    await expect(
      program.parseAsync(["node", "klaus", "mock", dir, "--origin", "not a url"]),
    ).rejects.toThrow(/invalid --origin value/);
    await expect(
      program.parseAsync(["node", "klaus", "mock", dir, "--allow-host", "evil.example:80"]),
    ).rejects.toThrow(/invalid --allow-host value/);
  });
});
