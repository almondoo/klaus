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
    // WHATWG URL 正規化形でリクエスト行に載ったままの req.url をそのままエコーする
    // (tests/cli/run.test.ts の同名エンドポイントと同じ用途: クエリ文字列の組み立て結果を検証する)
    if (req.url?.startsWith("/echo") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: req.url }));
      return;
    }
    // req コマンド用: 受け取ったメソッド・URL・ヘッダー・ボディをそのままエコーする(任意メソッド)
    if (req.url?.startsWith("/req-echo")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
      });
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

  it("(l2) run --env と --env-file の同時指定は exit 1", async () => {
    const flowPath = join(workDir, "env-envfile-conflict.yaml");
    await writeFile(
      flowPath,
      `name: conflict flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );
    const envFilePath = join(workDir, "conflict-env.yaml");
    await writeFile(envFilePath, "baseUrl: https://example.com\n", "utf-8");

    const result = await runCli(
      ["run", flowPath, "--no-history", "-e", "local", "--env-file", envFilePath],
      workDir,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--env and --env-file cannot be used together");
  });

  it("(l3) run --var と --env-file を組み合わせた実行が成功する(--var が env-file の同名キーを上書きする)", async () => {
    const varWorkDir = join(workDir, "var-envfile-scenario");
    await mkdir(varWorkDir, { recursive: true });
    const envFilePath = join(varWorkDir, "outside-env.yaml");
    // baseUrl はわざと到達不能なアドレスにしておき、--var による上書きが効いていない場合は
    // 接続不能(exit 3)になって検知できるようにする
    await writeFile(envFilePath, "baseUrl: http://127.0.0.1:1\n", "utf-8");
    const flowPath = join(varWorkDir, "var-envfile-flow.yaml");
    await writeFile(
      flowPath,
      'name: var envfile flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "{{baseUrl}}/ok"\n    assert:\n      status: 200\n',
      "utf-8",
    );

    const result = await runCli(
      [
        "run",
        flowPath,
        "--no-history",
        "--env-file",
        envFilePath,
        "--var",
        `baseUrl=${fixture.baseUrl}`,
      ],
      varWorkDir,
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("passed");
  });

  it("(l4) run --var に = を含まない値を渡すと exit 0 以外になり未捕捉スタックトレースも出ない", async () => {
    const flowPath = join(workDir, "var-invalid.yaml");
    await writeFile(flowPath, "name: any\nsteps: []\n", "utf-8");

    const result = await runCli(["run", flowPath, "--no-history", "--var", "novalue"], workDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid --var value (expected key=value): novalue");
    expect(result.stderr).not.toMatch(/^\s+at\s/m);
  });

  it("(l5) run --var は繰り返し指定すると累積し、両方の変数が解決される", async () => {
    // /echo は受け取った req.url(クエリ込み)をそのまま JSON body として返すため、
    // bodyText.contains で実際に組み立てられたクエリ文字列を確認できる
    // (この時点で assert は成功=ステップ passed になるが、bodyText の中身自体で解決結果を検証できる)
    const flowPath = join(workDir, "var-repeat.yaml");
    await writeFile(
      flowPath,
      `name: var repeat flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/echo"\n      query:\n        a: "{{a}}"\n        b: "{{b}}"\n    assert:\n      status: 200\n      bodyText:\n        contains: "a=1&b=2"\n`,
      "utf-8",
    );

    const result = await runCli(
      ["run", flowPath, "--no-history", "--var", "a=1", "--var", "b=2"],
      workDir,
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("passed");
  });

  it("(l6) run --var の値自体が = を含む場合、最初の = のみを区切りとして扱う", async () => {
    // request.query は URLSearchParams 経由でクエリ文字列に組み込まれるため、
    // 値中の "=" は application/x-www-form-urlencoded 形でパーセントエンコードされる(%3D)
    const flowPath = join(workDir, "var-equals-in-value.yaml");
    await writeFile(
      flowPath,
      `name: var equals in value flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/echo"\n      query:\n        token: "{{token}}"\n    assert:\n      status: 200\n      bodyText:\n        contains: "token=abc%3D123"\n`,
      "utf-8",
    );

    const result = await runCli(
      ["run", flowPath, "--no-history", "--var", "token=abc=123"],
      workDir,
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("passed");
  });

  it("(l7) run --var のキーが空('=value')だと exit 0 以外になり未捕捉スタックトレースも出ない", async () => {
    const flowPath = join(workDir, "var-empty-key.yaml");
    await writeFile(flowPath, "name: any\nsteps: []\n", "utf-8");

    const result = await runCli(["run", flowPath, "--no-history", "--var", "=value"], workDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid --var value (expected key=value): =value");
    expect(result.stderr).not.toMatch(/^\s+at\s/m);
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

  it("(e2) --report junit,tap + --report-file を2回指定すると両方のレポートファイルが生成される", async () => {
    const flowPath = join(workDir, "success-for-multi-report.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );
    const junitPath = join(workDir, "multi.xml");
    const tapPath = join(workDir, "multi.tap");

    const result = await runCli(
      [
        "run",
        flowPath,
        "--no-history",
        "--report",
        "junit,tap",
        "--report-file",
        junitPath,
        "--report-file",
        tapPath,
      ],
      workDir,
    );

    expect(result.status).toBe(0);
    await access(junitPath);
    await access(tapPath);
    const xml = await readFile(junitPath, "utf-8");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    const tap = await readFile(tapPath, "utf-8");
    expect(tap.startsWith("TAP version 13")).toBe(true);
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

  it("(i2) klaus.config.yaml の run.env が設定されていても、--env-file を明示指定すれば -e/--env との競合エラーにならず env-file が使われる(回帰確認)", async () => {
    // config の run.env は「CLI で -e/--env を明示指定しなかった場合の既定値」に過ぎないため、
    // --env-file を明示指定したこのシナリオでは注入されず、-e/--env と --env-file の
    // 同時指定エラー(exit 1)には抵触しない
    const configWorkDir = join(workDir, "config-envfile-scenario");
    await mkdir(join(configWorkDir, "environments"), { recursive: true });
    // config の run.env(local)が指す環境は到達不能なアドレスにしておき、
    // 誤って config 側が使われた場合は接続不能(exit 3)で検知できるようにする
    await writeFile(
      join(configWorkDir, "environments", "local.yaml"),
      "baseUrl: http://127.0.0.1:1\n",
      "utf-8",
    );
    await writeFile(join(configWorkDir, "klaus.config.yaml"), "run:\n  env: local\n", "utf-8");
    const envFilePath = join(configWorkDir, "outside-env.yaml");
    await writeFile(envFilePath, `baseUrl: "${fixture.baseUrl}"\n`, "utf-8");
    const flowPath = join(configWorkDir, "needs-env.yaml");
    await writeFile(
      flowPath,
      'name: needs env flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "{{baseUrl}}/ok"\n    assert:\n      status: 200\n',
      "utf-8",
    );

    const result = await runCli(
      ["run", flowPath, "--no-history", "--env-file", envFilePath],
      configWorkDir,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("--env and --env-file cannot be used together");
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

  it("(k2) klaus.config.yaml の guard.allowedHosts: 許可外ホストへの run は exit 3 で送信されず、許可ホストなら exit 0", async () => {
    const guardWorkDir = join(workDir, "guard-run-scenario");
    await mkdir(guardWorkDir, { recursive: true });
    const flowPath = join(guardWorkDir, "ok.yaml");
    await writeFile(
      flowPath,
      `name: guard flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    await writeFile(
      join(guardWorkDir, "klaus.config.yaml"),
      "guard:\n  allowedHosts:\n    - api.example.com\n",
      "utf-8",
    );
    const denied = await runCli(["run", flowPath, "--no-history"], guardWorkDir);
    expect(denied.status).toBe(3);
    expect(JSON.parse(denied.stdout).status).toBe("error");
    expect(denied.stdout).toContain("guard.allowedHosts");

    await writeFile(
      join(guardWorkDir, "klaus.config.yaml"),
      `guard:\n  allowedHosts:\n    - "${new URL(fixture.baseUrl).host}"\n`,
      "utf-8",
    );
    const allowed = await runCli(["run", flowPath, "--no-history"], guardWorkDir);
    expect(allowed.status).toBe(0);
  });

  it("(k3) klaus.config.yaml の guard.allowedHosts が空配列だと run は exit 2 になる", async () => {
    const guardWorkDir = join(workDir, "guard-empty-scenario");
    await mkdir(guardWorkDir, { recursive: true });
    await writeFile(
      join(guardWorkDir, "klaus.config.yaml"),
      "guard:\n  allowedHosts: []\n",
      "utf-8",
    );
    const flowPath = join(guardWorkDir, "ok.yaml");
    await writeFile(
      flowPath,
      `name: guard flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n`,
      "utf-8",
    );

    const result = await runCli(["run", flowPath, "--no-history"], guardWorkDir);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("klaus.config.yaml");
  });

  it("(k4) run --actor / 環境変数の推定が履歴(history show)の actor・file・git に記録される", async () => {
    const auditWorkDir = join(workDir, "audit-scenario");
    await mkdir(auditWorkDir, { recursive: true });
    const flowPath = join(auditWorkDir, "ok.yaml");
    await writeFile(
      flowPath,
      `name: audit flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const run = await runCli(["run", flowPath, "--actor", "it-bot"], auditWorkDir);
    expect(run.status).toBe(0);
    const runId = (JSON.parse(run.stdout) as { runId: string }).runId;

    const show = await runCli(["history", "show", runId], auditWorkDir);
    const [entry] = JSON.parse(show.stdout) as Array<{
      actor?: { kind: string; name?: string };
      file?: string;
      git?: unknown;
    }>;
    // kind は実行環境(CI / エージェント)に依存して変わるため、name と file の記録のみ固定する
    expect(entry?.actor?.name).toBe("it-bot");
    expect(["human", "agent", "ci"]).toContain(entry?.actor?.kind);
    expect(entry?.file).toBe("ok.yaml");
  });

  it("(k5) klaus ui: klaus.config.yaml の guard が POST /api/request に効き、許可外ホストは error になる", async () => {
    const uiGuardDir = join(workDir, "guard-ui-scenario");
    await mkdir(uiGuardDir, { recursive: true });
    await writeFile(
      join(uiGuardDir, "klaus.config.yaml"),
      "guard:\n  allowedHosts:\n    - api.example.com\n",
      "utf-8",
    );

    const child = spawn("node", [cliPath, "ui", "--no-open", "--port", "14898"], {
      cwd: uiGuardDir,
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.on("error", () => {});

    try {
      const deadline = Date.now() + 15000;
      while (!/klaus UI started: \S+/.test(stdout) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const url = /klaus UI started: (\S+)/.exec(stdout)?.[1];
      expect(url).toBeDefined();
      const token = new URL(url as string).searchParams.get("token") as string;

      const res = await fetch("http://127.0.0.1:14898/api/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Klaus-Token": token,
          Cookie: `klaus_token=${token}`,
        },
        body: JSON.stringify({ request: { method: "GET", url: `${fixture.baseUrl}/ok` } }),
      });
      const payload = (await res.json()) as { result: { status: string; error?: string } };

      expect(res.status).toBe(200);
      expect(payload.result.status).toBe("error");
      expect(payload.result.error).toContain("guard.allowedHosts");
    } finally {
      child.kill("SIGTERM");
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

  it("(s) run --data: 2行のデータファイルで全フロー成功なら exit 0 になり、JSON 出力に iteration フィールドが含まれる", async () => {
    const dataPath = join(workDir, "data-rows.json");
    await writeFile(dataPath, JSON.stringify([{ name: "alice" }, { name: "bob" }]), "utf-8");
    const flowPath = join(workDir, "data-flow.yaml");
    await writeFile(
      flowPath,
      `name: data flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/echo"\n      query:\n        u: "{{name}}"\n    assert:\n      status: 200\n      bodyText:\n        contains: "{{name}}"\n`,
      "utf-8",
    );

    const result = await runCli(["run", flowPath, "--no-history", "--data", dataPath], workDir);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("passed");
    expect(parsed.flows).toHaveLength(2);
    expect(parsed.flows[0].iteration).toBe(1);
    expect(parsed.flows[1].iteration).toBe(2);
  });

  it("(t) run --data: 一部の行がアサーション失敗すると exit 4 になる", async () => {
    const dataPath = join(workDir, "data-rows-fail.json");
    await writeFile(dataPath, JSON.stringify([{ path: "ok" }, { path: "missing" }]), "utf-8");
    const flowPath = join(workDir, "data-flow-fail.yaml");
    await writeFile(
      flowPath,
      `name: data flow fail\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/{{path}}"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const result = await runCli(["run", flowPath, "--no-history", "--data", dataPath], workDir);

    expect(result.status).toBe(4);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("failed");
  });

  it("(u) run --tags: 一致するタグを持つフローのみ実行され exit 0 になる", async () => {
    const taggedPath = join(workDir, "tags-happy-tagged.yaml");
    await writeFile(
      taggedPath,
      `name: tagged flow\ntags: [smoke]\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );
    const untaggedPath = join(workDir, "tags-happy-untagged.yaml");
    await writeFile(
      untaggedPath,
      `name: untagged flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const result = await runCli(
      ["run", taggedPath, untaggedPath, "--no-history", "--tags", "smoke"],
      workDir,
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("passed");
    expect(parsed.flows).toHaveLength(1);
    expect(parsed.flows[0].name).toBe("tagged flow");
  });

  it("(v) run --tags: 一致するフローが0件だと exit 1 + stderr メッセージになり、何も実行されない", async () => {
    const flowPath = join(workDir, "tags-zero-match.yaml");
    await writeFile(
      flowPath,
      `name: any flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const result = await runCli(
      ["run", flowPath, "--no-history", "--tags", "nonexistent"],
      workDir,
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("klaus: no flows match the specified tags");
  });

  it("(w) run --tags に空エントリ(連続カンマ)を渡すと exit 0 以外になり未捕捉スタックトレースも出ない", async () => {
    const flowPath = join(workDir, "tags-invalid.yaml");
    await writeFile(flowPath, "name: any\nsteps: []\n", "utf-8");

    const result = await runCli(
      ["run", flowPath, "--no-history", "--tags", "smoke,,auth"],
      workDir,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid tag list (empty tag after trimming): smoke,,auth");
    expect(result.stderr).not.toMatch(/^\s+at\s/m);
  });

  it("(x) run --jobs 2: 2フローが並列実行され exit 0 になり、JSON 出力の flows は入力順のまま", async () => {
    const flowPathA = join(workDir, "jobs-happy-a.yaml");
    await writeFile(
      flowPathA,
      `name: jobs flow a\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );
    const flowPathB = join(workDir, "jobs-happy-b.yaml");
    await writeFile(
      flowPathB,
      `name: jobs flow b\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const result = await runCli(
      ["run", flowPathA, flowPathB, "--no-history", "--jobs", "2"],
      workDir,
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.status).toBe("passed");
    expect(parsed.flows.map((flow: { name: string }) => flow.name)).toEqual([
      "jobs flow a",
      "jobs flow b",
    ]);
  });

  it("(y) run --jobs 0: 不正な --jobs は exit 0 以外になり未捕捉スタックトレースも出ない", async () => {
    const flowPath = join(workDir, "jobs-invalid.yaml");
    await writeFile(flowPath, "name: any\nsteps: []\n", "utf-8");

    const result = await runCli(["run", flowPath, "--no-history", "--jobs", "0"], workDir);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid --jobs value (expected an integer 1-32): 0");
    expect(result.stderr).not.toMatch(/^\s+at\s/m);
  });

  it("(z) run --record と --jobs 2 の同時指定は exit 1 になる", async () => {
    const flowPath = join(workDir, "jobs-record-conflict.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );
    const recordDir = join(workDir, "jobs-record-conflict-cassette");

    const result = await runCli(
      ["run", flowPath, "--no-history", "--record", recordDir, "--jobs", "2"],
      workDir,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--record and --jobs > 1 cannot be used together");
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

  it("(req-1) req GET: exit 0 + version 1 の JSON(request / response)。HTTP 404 でも応答を受信したので exit 0", async () => {
    const ok = await runCli(["req", "GET", `${fixture.baseUrl}/ok`, "--no-history"], workDir);

    expect(ok.status).toBe(0);
    const report = JSON.parse(ok.stdout);
    expect(report.version).toBe(1);
    expect(report.status).toBe("passed");
    expect(report.request.method).toBe("GET");
    expect(report.response.status).toBe(200);
    expect(report).not.toHaveProperty("historyRef");

    const notFound = await runCli(
      ["req", "GET", `${fixture.baseUrl}/missing`, "--no-history"],
      workDir,
    );
    expect(notFound.status).toBe(0);
    expect(JSON.parse(notFound.stdout).response.status).toBe(404);
  });

  it("(req-2) req POST: -H / --query / --body を送信し、historyRef の runId で history show から全文を取得できる", async () => {
    const reqWorkDir = join(workDir, "req-scenario");
    await mkdir(reqWorkDir, { recursive: true });

    const result = await runCli(
      [
        "req",
        "post",
        `${fixture.baseUrl}/req-echo`,
        "-H",
        "X-Trace: abc",
        "--query",
        "q=klaus",
        "--body",
        '{"name":"a"}',
        "--actor",
        "it-agent",
      ],
      reqWorkDir,
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    const echo = JSON.parse(report.response.body);
    expect(echo.method).toBe("POST");
    expect(echo.url).toBe("/req-echo?q=klaus");
    expect(echo.headers["x-trace"]).toBe("abc");
    expect(JSON.parse(echo.body)).toEqual({ name: "a" });
    expect(report.historyRef).toMatchObject({ step: "request" });

    const show = await runCli(
      ["history", "show", report.historyRef.runId, "--step", "request"],
      reqWorkDir,
    );
    expect(show.status).toBe(0);
    const entries = JSON.parse(show.stdout) as Array<Record<string, unknown>>;
    expect(entries[0]).toMatchObject({
      source: "single",
      actor: { name: "it-agent" },
      request: { method: "POST" },
    });
  });

  it("(req-3) req: 接続不能は exit 3(status: error)", async () => {
    const closedPort = await reserveClosedPort();

    const result = await runCli(
      ["req", "GET", `http://127.0.0.1:${closedPort}/`, "--no-history"],
      workDir,
    );

    expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout).status).toBe("error");
  });

  it("(req-4) req: guard.allowedHosts は exit 3 で拒否し、$protected: readonly は GET のみ許可する", async () => {
    const guardWorkDir = join(workDir, "req-guard-scenario");
    await mkdir(join(guardWorkDir, "environments"), { recursive: true });
    await writeFile(
      join(guardWorkDir, "environments", "stg.yaml"),
      `$protected: readonly\nbaseUrl: ${fixture.baseUrl}\n`,
      "utf-8",
    );

    const get = await runCli(
      ["req", "GET", "{{baseUrl}}/req-echo", "-e", "stg", "--no-history"],
      guardWorkDir,
    );
    const post = await runCli(
      ["req", "POST", "{{baseUrl}}/req-echo", "-e", "stg", "--no-history"],
      guardWorkDir,
    );
    expect(get.status).toBe(0);
    expect(post.status).toBe(3);
    expect(JSON.parse(post.stdout).error).toContain("refusing POST");

    await writeFile(
      join(guardWorkDir, "klaus.config.yaml"),
      "guard:\n  allowedHosts:\n    - api.example.com\n",
      "utf-8",
    );
    const denied = await runCli(
      ["req", "GET", `${fixture.baseUrl}/req-echo`, "--no-history"],
      guardWorkDir,
    );
    expect(denied.status).toBe(3);
    expect(JSON.parse(denied.stdout).error).toContain("guard.allowedHosts");
  });

  it("(req-5) req: 不正な引数は exit 0 以外(--header の形式不正は commander、--json と --text の併用・cwd 外の --body ファイルは exit 2)で、何も送信しない", async () => {
    const badHeader = await runCli(
      ["req", "GET", `${fixture.baseUrl}/ok`, "-H", "novalue", "--no-history"],
      workDir,
    );
    expect(badHeader.status).not.toBe(0);
    expect(badHeader.stderr).toContain("invalid --header value");
    expect(badHeader.stderr).not.toMatch(/^\s+at\s/m);
    expect(badHeader.stdout).toBe("");

    const both = await runCli(
      ["req", "GET", `${fixture.baseUrl}/ok`, "--json", "--text", "--no-history"],
      workDir,
    );
    expect(both.status).toBe(2);
    expect(both.stdout).toBe("");

    const outside = await runCli(
      ["req", "POST", `${fixture.baseUrl}/ok`, "--body", "@../outside.json", "--no-history"],
      workDir,
    );
    expect(outside.status).toBe(2);
    expect(outside.stderr).toContain("outside the current directory");
  });

  it("(req-6) schema -t req-report: req --json の JSON Schema を出力し exit 0 になる", async () => {
    const result = await runCli(["schema", "-t", "req-report"], workDir);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).properties.historyRef).toBeDefined();
  });

  it("(dry-1) run --dry-run: capture 依存つきの 2 ステップを送信せずに展開し、dryRun: true の JSON と exit 0", async () => {
    const dryWorkDir = join(workDir, "dry-run-scenario");
    await mkdir(dryWorkDir, { recursive: true });
    const flowPath = join(dryWorkDir, "chain.yaml");
    await writeFile(
      flowPath,
      `name: chain\nsteps:\n  - name: login\n    request:\n      method: POST\n      url: "${fixture.baseUrl}/req-echo/login"\n      body: { user: a }\n    capture: { token: "$.body" }\n  - name: me\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/req-echo/me"\n      headers: { Authorization: "Bearer {{token}}" }\n`,
      "utf-8",
    );

    const result = await runCli(["run", flowPath, "--dry-run"], dryWorkDir);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ version: 1, dryRun: true, status: "ok" });
    expect(report.flows[0].steps[1]).toMatchObject({
      unresolved: ["token"],
      request: { headers: { Authorization: "Bearer {{token}}" } },
      guard: { status: "allowed" },
    });
    // 履歴は書かれない
    await expect(access(join(dryWorkDir, ".klaus"))).rejects.toThrow();
  });

  it("(dry-2) run --dry-run: guard.allowedHosts で拒否されるステップがあれば exit 3、config の run.report があっても使える", async () => {
    const dryWorkDir = join(workDir, "dry-run-guard-scenario");
    await mkdir(dryWorkDir, { recursive: true });
    const flowPath = join(dryWorkDir, "ok.yaml");
    await writeFile(
      flowPath,
      `name: guard flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n`,
      "utf-8",
    );
    await writeFile(
      join(dryWorkDir, "klaus.config.yaml"),
      "run:\n  report: junit\nguard:\n  allowedHosts:\n    - api.example.com\n",
      "utf-8",
    );

    const result = await runCli(["run", flowPath, "--dry-run"], dryWorkDir);

    expect(result.status).toBe(3);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe("error");
    expect(report.flows[0].steps[0].guard.status).toBe("refused");
    // config の run.report は --dry-run では適用されず、レポートファイルは書かれない
    await expect(access(join(dryWorkDir, "klaus-report.xml"))).rejects.toThrow();
  });

  it("(dry-3) run --dry-run: --data で行ごとに展開され、--record / --replay / --report との併用は exit 2", async () => {
    const dryWorkDir = join(workDir, "dry-run-data-scenario");
    await mkdir(dryWorkDir, { recursive: true });
    const flowPath = join(dryWorkDir, "item.yaml");
    await writeFile(
      flowPath,
      `name: item\nsteps:\n  - name: get\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/req-echo/{{id}}"\n`,
      "utf-8",
    );
    const dataPath = join(dryWorkDir, "rows.json");
    await writeFile(dataPath, '[{"id":"a"},{"id":"b"}]', "utf-8");

    const data = await runCli(
      ["run", flowPath, "--dry-run", "--data", dataPath, "--jobs", "2"],
      dryWorkDir,
    );
    expect(data.status).toBe(0);
    const urls = JSON.parse(data.stdout).flows.map(
      (f: { iteration: number; steps: { request: { url: string } }[] }) =>
        `${f.iteration}:${f.steps[0]?.request.url.replace(fixture.baseUrl, "")}`,
    );
    expect(urls).toEqual(["1:/req-echo/a", "2:/req-echo/b"]);

    for (const extra of [
      ["--record", "cas"],
      ["--replay", "cas"],
      ["--report", "junit"],
    ]) {
      const conflict = await runCli(["run", flowPath, "--dry-run", ...extra], dryWorkDir);
      expect(conflict.status, extra.join(" ")).toBe(2);
      expect(conflict.stdout).toBe("");
      expect(conflict.stderr).toContain("--dry-run cannot be combined with");
    }
  });

  it("(dry-4) schema -t dry-run-report: run --dry-run --json の JSON Schema を出力し exit 0 になる", async () => {
    const result = await runCli(["schema", "-t", "dry-run-report"], workDir);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).properties.dryRun).toBeDefined();
  });
});
