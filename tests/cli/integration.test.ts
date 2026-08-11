import { execSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeServer, listenEphemeral, reserveClosedPort } from "../support/net.js";

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
  const { baseUrl } = await listenEphemeral(server);
  return { server, baseUrl };
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
  entryPath: string = cliPath,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [entryPath, ...args], { cwd });
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
    await closeServer(fixture.server);
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
    expect(parsed.version).toBe(2);
    expect(parsed.status).toBe("passed");
    expect(parsed.flows).toHaveLength(1);
    expect(parsed.flows[0].steps[0].status).toBe("passed");
  });

  it("(a2) bin シンボリックリンク経由の起動でも CLI が実行される", async () => {
    // npm/pnpm のグローバルインストールや node_modules/.bin は dist/cli.js への
    // シンボリックリンクを経由して起動するため、entry 判定が realpath 差異で
    // 落ちないこと(何も出力せず exit 0 になる退行の防止)を確認する
    const binDir = join(workDir, "bin");
    await mkdir(binDir, { recursive: true });
    const linkPath = join(binDir, "klaus");
    await symlink(cliPath, linkPath);

    const result = await runCli(["--version"], workDir, linkPath);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
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

  it("(l) run -e/--env で指定した環境ファイルが使われる", async () => {
    // 他テストの cwd(workDir)に影響しないよう専用のサブディレクトリを使う
    const envWorkDir = join(workDir, "env-scenario");
    await mkdir(join(envWorkDir, "environments"), { recursive: true });
    await writeFile(
      join(envWorkDir, "environments", "staging.yaml"),
      `baseUrl: "${fixture.baseUrl}"\n`,
      "utf-8",
    );
    const flowPath = join(envWorkDir, "needs-env.yaml");
    await writeFile(
      flowPath,
      'name: needs env flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "{{baseUrl}}/ok"\n    assert:\n      status: 200\n',
      "utf-8",
    );

    const result = await runCli(["run", flowPath, "--no-history", "-e", "staging"], envWorkDir);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("passed");
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

  it("(h) generate → validate: OpenAPI spec から生成したフロー YAML が validate を通る", async () => {
    const specPath = join(workDir, "generate-source.yaml");
    await writeFile(
      specPath,
      [
        "openapi: 3.0.3",
        "info:",
        "  title: Integration Sample API",
        '  version: "1.0.0"',
        "paths:",
        "  /ping:",
        "    get:",
        "      operationId: ping",
        "      responses:",
        '        "200":',
        "          description: OK",
        "",
      ].join("\n"),
      "utf-8",
    );
    const outDir = join(workDir, "generated-api");

    const generateResult = await runCli(
      ["generate", specPath, "--out-dir", outDir, "--json"],
      workDir,
    );

    expect(generateResult.status).toBe(0);
    const generateReport = JSON.parse(generateResult.stdout) as { generated: string[] };
    // generated は validate と同様に cwd 相対の表示パスを返す
    expect(generateReport.generated).toContain(join("generated-api", "ping.yaml"));

    const validateResult = await runCli(["validate", join(outDir, "ping.yaml"), "--json"], workDir);

    expect(validateResult.status).toBe(0);
    const validateReport = JSON.parse(validateResult.stdout) as {
      files: Array<{ valid: boolean }>;
    };
    expect(validateReport.files).toEqual([expect.objectContaining({ valid: true })]);
  });

  it("(i) klaus.config.yaml の run.env が --env 未指定時の既定値として使われる", async () => {
    // workDir 直下に置くと以降の他テストの cwd(workDir)にも影響してしまうため、
    // このテスト専用のサブディレクトリを cwd にする
    const configWorkDir = join(workDir, "config-scenario");
    await mkdir(join(configWorkDir, "environments"), { recursive: true });
    await writeFile(
      join(configWorkDir, "environments", "local.yaml"),
      `baseUrl: "${fixture.baseUrl}"\n`,
      "utf-8",
    );
    await writeFile(join(configWorkDir, "klaus.config.yaml"), "run:\n  env: local\n", "utf-8");
    const flowPath = join(configWorkDir, "needs-env.yaml");
    await writeFile(
      flowPath,
      'name: needs env flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "{{baseUrl}}/ok"\n    assert:\n      status: 200\n',
      "utf-8",
    );

    const result = await runCli(["run", flowPath, "--no-history"], configWorkDir);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("passed");
  });

  it("(j) 不正な klaus.config.yaml(未知キー)があると run は exit 2 になり stderr に config ファイルのパスを含む", async () => {
    // (i) と同様、workDir 直下に置くと他テストの cwd にも影響するため専用のサブディレクトリを使う
    const configWorkDir = join(workDir, "config-invalid-scenario");
    await mkdir(configWorkDir, { recursive: true });
    await writeFile(join(configWorkDir, "klaus.config.yaml"), "run:\n  unknownKey: x\n", "utf-8");
    const flowPath = join(configWorkDir, "success.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const result = await runCli(["run", flowPath, "--no-history"], configWorkDir);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(join(configWorkDir, "klaus.config.yaml"));
  });

  it("(k) klaus.config.yaml の ui.port が --port 未指定時の既定値として使われる", async () => {
    // (i) と同様、workDir 直下に置くと他テストの cwd にも影響するため専用のサブディレクトリを使う
    const configWorkDir = join(workDir, "config-ui-scenario");
    await mkdir(configWorkDir, { recursive: true });
    // 既定ポート 4884 は Docker(verify 用 docker-compose)が占有しているため使わない
    await writeFile(join(configWorkDir, "klaus.config.yaml"), "ui:\n  port: 14899\n", "utf-8");

    const child = spawn("node", [cliPath, "ui", "--no-open"], { cwd: configWorkDir });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    // spawn 失敗等で 'error' が発生してもテストプロセスごとクラッシュしないようにする
    child.on("error", () => {});

    try {
      const expectedLine = "klaus UI started: http://127.0.0.1:14899/";
      const deadline = Date.now() + 15000;
      while (!stdout.includes(expectedLine) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(stdout).toContain(expectedLine);
    } finally {
      child.kill("SIGTERM");
      // グレースフル停止(SIGTERM ハンドラでの close() + exit)を短時間だけ待つ(保険付きで待ちすぎない)
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        setTimeout(resolve, 3000);
      });
    }
  }, 20000);

  it("(m) schema: 既定(flow スキーマ)の JSON Schema を stdout に出力し exit 0 になる", async () => {
    const result = await runCli(["schema"], workDir);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.$schema).toContain("json-schema.org");
    expect(parsed.type).toBe("object");
  });

  it("(n) schema -t bogus: 不正な --target を指定すると exit 1 になり案内メッセージを出す", async () => {
    const result = await runCli(["schema", "-t", "bogus"], workDir);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('invalid --target "bogus"');
  });

  it("(o) ui --port abc: 不正な --port は exit 0 以外になり、サーバーは起動せず未捕捉スタックトレースも出ない", async () => {
    const result = await runCli(["ui", "--port", "abc", "--no-open"], workDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid --port value: abc");
    // InvalidArgumentError として throw されるため commander が整形したメッセージのみになり、
    // 未捕捉例外のスタックトレース("    at ..." 形式の行)は出ない
    expect(result.stderr).not.toMatch(/^\s+at\s/m);
    expect(result.stdout).not.toContain("klaus UI started");
  });

  it("(p) history --last abc: 不正な --last は exit 0 以外になり未捕捉スタックトレースも出ない", async () => {
    const result = await runCli(["history", "--last", "abc"], workDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid --last value: abc");
    expect(result.stderr).not.toMatch(/^\s+at\s/m);
  });

  it("(q) init: api/example.yaml と environments/local.yaml と AGENTS.md を生成し exit 0 になる", async () => {
    const initWorkDir = join(workDir, "init-scenario");
    await mkdir(initWorkDir, { recursive: true });

    const result = await runCli(["init"], initWorkDir);

    expect(result.status).toBe(0);
    await access(join(initWorkDir, "api", "example.yaml"));
    await access(join(initWorkDir, "environments", "local.yaml"));
    await access(join(initWorkDir, "AGENTS.md"));
  });

  it("(r) history / history show: 既存の履歴ディレクトリから JSON を出力し exit 0 になる", async () => {
    const historyWorkDir = join(workDir, "history-scenario");
    const historyDir = join(historyWorkDir, ".klaus", "history");
    await mkdir(historyDir, { recursive: true });
    const entry = {
      v: 1,
      runId: "run-it-1",
      flow: "it flow",
      step: "ok",
      startedAt: "2026-08-08T10:00:00.000Z",
      durationMs: 1,
      status: "passed",
      request: { method: "GET", url: "http://localhost/ok", headers: {} },
      response: { status: 200, headers: {}, body: null },
      assertions: [],
    };
    await writeFile(join(historyDir, "2026-08-08.jsonl"), `${JSON.stringify(entry)}\n`, "utf-8");

    const listResult = await runCli(["history", "--json"], historyWorkDir);
    expect(listResult.status).toBe(0);
    const listParsed = JSON.parse(listResult.stdout) as Array<Record<string, unknown>>;
    expect(listParsed).toHaveLength(1);
    expect(listParsed[0]?.runId).toBe("run-it-1");

    const showResult = await runCli(["history", "show", "run-it-1"], historyWorkDir);
    expect(showResult.status).toBe(0);
    const showParsed = JSON.parse(showResult.stdout) as Array<Record<string, unknown>>;
    expect(showParsed).toHaveLength(1);
    expect(showParsed[0]?.step).toBe("ok");
  });
});
