import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadHttpOptions } from "../../src/cli/config.js";
import { reqCommand } from "../../src/cli/req.js";
import { runCommand } from "../../src/cli/run.js";
import { ParseError } from "../../src/core/index.js";
import { closeServer, listenEphemeral } from "../support/net.js";
import { generateTestCert, type TestCert } from "../support/tls.js";

const tmpRoot = join(__dirname, "..", "..", "tmp");

describe("klaus.config.yaml の http を run / req へ届ける", () => {
  let workDir: string;
  let out: string[];
  let err: string[];
  let stdoutWrite: typeof process.stdout.write;
  let stderrWrite: typeof process.stderr.write;
  let tty: boolean | undefined;
  const servers: { close(cb: () => void): unknown }[] = [];
  let cert: TestCert;

  beforeAll(async () => {
    cert = await generateTestCert();
  });
  afterAll(async () => {
    await rm(cert.dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    workDir = await mkdtemp(join(tmpRoot, "klaus-http-config-"));
    out = [];
    err = [];
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      out.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      err.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    tty = process.stdout.isTTY;
    process.stdout.isTTY = undefined as unknown as true;
  });

  afterEach(async () => {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.stdout.isTTY = tty as true;
    for (const server of servers.splice(0)) await closeServer(server);
    await rm(workDir, { recursive: true, force: true });
  });

  async function redirectingServer() {
    const target = createHttpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("landed");
    });
    servers.push(target);
    const t = await listenEphemeral(target);
    const origin = createHttpServer((_req, res) => {
      res.writeHead(302, { Location: `${t.baseUrl}/t` });
      res.end();
    });
    servers.push(origin);
    const o = await listenEphemeral(origin);
    return { originUrl: o.baseUrl, targetUrl: t.baseUrl };
  }

  it("loadHttpOptions: http が無ければ undefined、tls のパスは設定ファイルのディレクトリ基準の絶対パスにする", async () => {
    expect(await loadHttpOptions(workDir)).toBeUndefined();
    await writeFile(
      join(workDir, "klaus.config.yaml"),
      "http:\n  followRedirects: true\n  tls:\n    ca: certs/ca.pem\n",
    );
    expect(await loadHttpOptions(workDir)).toEqual({
      followRedirects: true,
      tls: { ca: join(workDir, "certs", "ca.pem") },
    });
  });

  it("loadHttpOptions: 設定の検証エラーは ParseError", async () => {
    await writeFile(join(workDir, "klaus.config.yaml"), "http:\n  tls:\n    cert: c.pem\n");
    await expect(loadHttpOptions(workDir)).rejects.toBeInstanceOf(ParseError);
  });

  it("req: 設定ファイルの http.followRedirects でリダイレクトを追う(未設定なら 302 のまま)", async () => {
    const { originUrl } = await redirectingServer();
    const base = { history: false, mask: true } as const;
    expect(await reqCommand("GET", `${originUrl}/o`, base, workDir)).toBe(0);
    expect(JSON.parse(out.join("")).response.status).toBe(302);

    out.length = 0;
    await writeFile(join(workDir, "klaus.config.yaml"), "http:\n  followRedirects: true\n");
    expect(await reqCommand("GET", `${originUrl}/o`, base, workDir)).toBe(0);
    const report = JSON.parse(out.join(""));
    expect(report.response.status).toBe(200);
    expect(report.response.body).toBe("landed");
  });

  it("req: tls.insecure の警告は stderr に出し、stdout の JSON を汚さない", async () => {
    const server = createHttpsServer({ key: cert.key, cert: cert.cert }, (_req, res) =>
      res.end("secure"),
    );
    servers.push(server);
    const { port } = await listenEphemeral(server);
    await writeFile(join(workDir, "klaus.config.yaml"), "http:\n  tls:\n    insecure: true\n");
    const code = await reqCommand(
      "GET",
      `https://127.0.0.1:${port}/`,
      { history: false, mask: true },
      workDir,
    );
    expect(code).toBe(0);
    expect(JSON.parse(out.join("")).response.body).toBe("secure");
    expect(err.join("")).toContain("warning: http.tls.insecure is enabled");
  });

  it("run: options.http(設定ファイル由来)をフロー実行に渡し、フローの http が followRedirects を上書きする", async () => {
    const { originUrl } = await redirectingServer();
    const flowPath = join(workDir, "flow.yaml");
    const body = (http: string) =>
      `name: f\n${http}steps:\n  - name: s\n    request:\n      method: GET\n      url: "${originUrl}/o"\n    assert:\n      status: 200\n`;
    const base = { history: false, mask: true, reportFile: join(workDir, "r.xml") } as const;

    await writeFile(flowPath, body(""));
    expect(await runCommand([flowPath], { ...base, http: { followRedirects: true } })).toBe(0);

    out.length = 0;
    await writeFile(flowPath, body("http:\n  followRedirects: false\n"));
    expect(await runCommand([flowPath], { ...base, http: { followRedirects: true } })).toBe(4);
  });

  it("run: フローに http.proxy / http.tls を書くと検証エラー(exit 2)で、何も送信しない", async () => {
    const { originUrl } = await redirectingServer();
    const flowPath = join(workDir, "flow.yaml");
    await writeFile(
      flowPath,
      `name: f\nhttp:\n  proxy: "http://evil.example:3128"\nsteps:\n  - name: s\n    request:\n      method: GET\n      url: "${originUrl}/o"\n`,
    );
    const code = await runCommand([flowPath], {
      history: false,
      mask: true,
      reportFile: join(workDir, "r.xml"),
    });
    expect(code).toBe(2);
    expect(err.join("")).toContain("klaus.config.yaml");
  });
});
