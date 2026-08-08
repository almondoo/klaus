import { execSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const projectRoot = join(__dirname, "..", "..");
const cliPath = join(projectRoot, "dist", "cli.js");

/** 成功/失敗/接続不能を再現するための最小限のローカル HTTP サーバー */
async function startFixtureServer() {
  const server = createServer((req, res) => {
    if (req.url === "/ok" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/** 確実に接続不能になる(誰も listen していない)ポートを1つ確保する */
async function reserveClosedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * node dist/cli.js を子プロセスとして実行する。パイプ経由なので stdout は非 TTY になる。
 *
 * 重要: ここでは spawnSync ではなく非同期の spawn を使う。
 * fixture サーバーはこのテストプロセス自身(vitest のシングルスレッドイベントループ)上で
 * listen しているため、spawnSync でイベントループを同期的にブロックすると、
 * CLI 子プロセスからのリクエストをサーバー側が処理できずデッドロック(タイムアウトまで無応答)になる。
 */
function runCli(
  args: string[],
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("cli integration", () => {
  let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
  const tmpRoot = join(projectRoot, "tmp");
  let workDir: string;

  beforeAll(async () => {
    // ビルド成果物(dist/cli.js)が必要なので、テスト実行前に1回だけビルドする
    execSync("pnpm build", { cwd: projectRoot, stdio: "inherit" });
    fixture = await startFixtureServer();
    await mkdir(tmpRoot, { recursive: true });
    workDir = await mkdtemp(join(tmpRoot, "klaus-cli-it-"));
  }, 60000);

  afterAll(async () => {
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("(a) 全成功: exit 0 + 非 TTY なので JSON がデフォルト出力になる", async () => {
    const flowPath = join(workDir, "success.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const result = await runCli(["run", flowPath, "--no-history"], workDir);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.version).toBe(1);
    expect(parsed.status).toBe("passed");
    expect(parsed.flows).toHaveLength(1);
    expect(parsed.flows[0].steps[0].status).toBe("passed");
  });

  it("(b) パースエラー: exit 2 + 何も実行されない", async () => {
    const flowPath = join(workDir, "broken.yaml");
    await writeFile(flowPath, "name: broken\nsteps: []\n", "utf-8");

    const result = await runCli(["run", flowPath, "--no-history"], workDir);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("broken.yaml");
  });

  it("(c) 接続不能: exit 3", async () => {
    const closedPort = await reserveClosedPort();
    const flowPath = join(workDir, "unreachable.yaml");
    await writeFile(
      flowPath,
      `name: unreachable flow\nsteps:\n  - name: ping\n    request:\n      method: GET\n      url: "http://127.0.0.1:${closedPort}/"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const result = await runCli(["run", flowPath, "--no-history"], workDir);

    expect(result.status).toBe(3);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("error");
  });

  it("(d) アサーション失敗: exit 4", async () => {
    const flowPath = join(workDir, "assert-fail.yaml");
    await writeFile(
      flowPath,
      `name: assert fail flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 201\n`,
      "utf-8",
    );

    const result = await runCli(["run", flowPath, "--no-history"], workDir);

    expect(result.status).toBe(4);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("failed");
  });

  it("(f) 壊れた environments/<name>.yaml を参照すると exit 2", async () => {
    const environmentsDir = join(workDir, "environments");
    await mkdir(environmentsDir, { recursive: true });
    await writeFile(join(environmentsDir, "broken.yaml"), "baseUrl: [\n", "utf-8");

    const flowPath = join(workDir, "needs-broken-env.yaml");
    await writeFile(
      flowPath,
      `name: needs env flow\nenv: broken\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const result = await runCli(["run", flowPath, "--no-history"], workDir);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("broken.yaml");
  });

  it("(g) --report invalid のような未対応レポート形式を指定すると exit 1", async () => {
    const flowPath = join(workDir, "success-for-invalid-report.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const result = await runCli(["run", flowPath, "--no-history", "--report", "invalid"], workDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid");
  });

  it("(e) --report junit でレポートファイルが生成される", async () => {
    const flowPath = join(workDir, "success-for-report.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );
    const reportPath = join(workDir, "report.xml");

    const result = await runCli(
      ["run", flowPath, "--no-history", "--report", "junit", "--report-file", reportPath],
      workDir,
    );

    expect(result.status).toBe(0);
    await access(reportPath);
    const xml = await readFile(reportPath, "utf-8");
    expect(xml).toContain("<testsuite");
    expect(xml).toContain('<testcase name="ok"');
  });
});
