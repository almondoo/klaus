import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunCommandOptions, runCommand } from "../../src/cli/run.js";
import { historyFilePath } from "../../src/core/history.js";
import { closeServer, listenEphemeral, reserveClosedPort } from "../support/net.js";

// loadFlow/runLoadedFlows が ParseError 以外を投げた場合、runCommand が catch せずそのまま呼び出し元へ
// 伝播させる契約(run.ts の JSDoc に明記)をテストするため、実装は素通しのままフックできるようにする。
vi.mock("../../src/core/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/index.js")>();
  return {
    ...actual,
    loadFlow: vi.fn(actual.loadFlow),
    runLoadedFlows: vi.fn(actual.runLoadedFlows),
  };
});
const { loadFlow: mockedLoadFlow, runLoadedFlows: mockedRunLoadedFlows } = await import(
  "../../src/core/index.js"
);

const projectRoot = join(__dirname, "..", "..");
const tmpRoot = join(projectRoot, "tmp");

/** mock 経由の伝播テストなど、実際には実行されない(loadFlow/runLoadedFlows をモックする)ケース向けの最小フロー定義 */
const VALID_FLOW_YAML = `
name: sample flow
steps:
  - name: step1
    request:
      method: GET
      url: "https://example.com"
`;

/** 成功/失敗を再現するための最小限のローカル HTTP サーバー(tests/cli/integration.test.ts の方式を参考に、このファイル専用に複製) */
async function startFixtureServer() {
  const server = createServer((req, res) => {
    if (req.url === "/ok" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // WHATWG URL 正規化形でリクエスト行に載ったままの req.url をそのままエコーする
    // (undici の URL 正規化がクエリの記号・空白をどう変換したかを検証するため)
    if (req.url?.startsWith("/echo") && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ url: req.url }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  const { baseUrl } = await listenEphemeral(server);
  return { server, baseUrl };
}

describe("runCommand", () => {
  let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
  let workDir: string;
  let stdoutSpy: string[];
  let stderrSpy: string[];
  let stdoutWriteSpy: typeof process.stdout.write;
  let stderrWriteSpy: typeof process.stderr.write;
  let isTtySpy: boolean | undefined;

  beforeAll(async () => {
    fixture = await startFixtureServer();
  });

  afterAll(async () => {
    await closeServer(fixture.server);
  });

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    workDir = await mkdtemp(join(tmpRoot, "klaus-run-"));
    stdoutSpy = [];
    stderrSpy = [];
    stdoutWriteSpy = process.stdout.write;
    stderrWriteSpy = process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutSpy.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrSpy.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    // 非 TTY を強制し、JSON 出力経路を通す(実 CI 環境の isTTY 値に依存させない)
    isTtySpy = process.stdout.isTTY;
    process.stdout.isTTY = undefined as unknown as true;
  });

  afterEach(async () => {
    process.stdout.write = stdoutWriteSpy;
    process.stderr.write = stderrWriteSpy;
    process.stdout.isTTY = isTtySpy as true;
    await rm(workDir, { recursive: true, force: true });
  });

  function readJson(): Record<string, unknown> {
    return JSON.parse(stdoutSpy.join(""));
  }

  function baseOptions(overrides: Partial<RunCommandOptions> = {}): RunCommandOptions {
    return {
      history: false,
      mask: true,
      reportFile: join(workDir, "klaus-report.xml"),
      ...overrides,
    };
  }

  it("全成功: 戻り値 0 で、非 TTY のため JSON が出力される", async () => {
    const flowPath = join(workDir, "success.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const exitCode = await runCommand([flowPath], baseOptions());

    expect(exitCode).toBe(0);
    const report = readJson();
    expect(report.version).toBe(2);
    expect(report.status).toBe("passed");
    expect(stderrSpy.join("")).toBe("");
  });

  it("パース不能なフロー(スキーマ違反)は戻り値 2 になり、何も実行せず stderr にエラーを出す", async () => {
    const flowPath = join(workDir, "broken.yaml");
    // request.url が無くスキーマ違反
    await writeFile(
      flowPath,
      "name: broken flow\nsteps:\n  - name: step1\n    request:\n      method: GET\n",
      "utf-8",
    );

    const exitCode = await runCommand([flowPath], baseOptions());

    expect(exitCode).toBe(2);
    expect(stdoutSpy.join("")).toBe("");
    expect(stderrSpy.join("")).toContain("klaus: parse error:");
    expect(stderrSpy.join("")).toContain("broken.yaml");
  });

  it("実行時エラー(接続不能ポート)は戻り値 3 になり、JSON の status が error になる", async () => {
    const closedPort = await reserveClosedPort();
    const flowPath = join(workDir, "unreachable.yaml");
    await writeFile(
      flowPath,
      `name: unreachable flow\nsteps:\n  - name: ping\n    request:\n      method: GET\n      url: "http://127.0.0.1:${closedPort}/"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const exitCode = await runCommand([flowPath], baseOptions());

    expect(exitCode).toBe(3);
    const report = readJson();
    expect(report.status).toBe("error");
  });

  it("$protected: true の環境は --allow-protected 無しだと戻り値 3 で拒否され、案内メッセージを含む", async () => {
    const cwdSpy = process.cwd;
    process.cwd = () => workDir;
    try {
      await mkdir(join(workDir, "environments"), { recursive: true });
      await writeFile(join(workDir, "environments", "prod.yaml"), "$protected: true\nbaseUrl: x\n");
      const flowPath = join(workDir, "protected.yaml");
      await writeFile(
        flowPath,
        `name: protected flow\nenv: prod\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions());

      expect(exitCode).toBe(3);
      const report = readJson();
      expect(report.status).toBe("error");
      expect(stdoutSpy.join("")).toContain("--allow-protected");
    } finally {
      process.cwd = cwdSpy;
    }
  });

  it("--allow-protected オプションが RunFlowOptions.allowProtected として runLoadedFlows に渡り、$protected な環境でも実行される", async () => {
    const cwdSpy = process.cwd;
    process.cwd = () => workDir;
    try {
      await mkdir(join(workDir, "environments"), { recursive: true });
      await writeFile(join(workDir, "environments", "prod.yaml"), "$protected: true\nbaseUrl: x\n");
      const flowPath = join(workDir, "protected-allowed.yaml");
      await writeFile(
        flowPath,
        `name: protected flow\nenv: prod\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions({ allowProtected: true }));

      expect(exitCode).toBe(0);
      expect(mockedRunLoadedFlows).toHaveBeenCalledWith(
        [expect.objectContaining({ filePath: flowPath })],
        expect.objectContaining({ allowProtected: true }),
      );
      const report = readJson();
      expect(report.status).toBe("passed");
    } finally {
      process.cwd = cwdSpy;
    }
  });

  it("--env-file で指定した $protected: true のファイルは --allow-protected 無しだと戻り値 3 で拒否され、案内メッセージにファイルパスを含む", async () => {
    const envFilePath = join(workDir, "protected-envfile.yaml");
    await writeFile(envFilePath, "$protected: true\nbaseUrl: x\n", "utf-8");
    const flowPath = join(workDir, "protected-via-envfile.yaml");
    await writeFile(
      flowPath,
      `name: protected flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const exitCode = await runCommand([flowPath], baseOptions({ envFile: envFilePath }));

    expect(exitCode).toBe(3);
    const report = readJson();
    expect(report.status).toBe("error");
    // 名前付き環境の案内メッセージと異なり、--env-file はファイルパスそのものを表示名として使う
    expect(stdoutSpy.join("")).toContain("--allow-protected");
    expect(stdoutSpy.join("")).toContain(envFilePath);
  });

  it("--env-file で指定した $protected: true のファイルも --allow-protected と併せれば実行される", async () => {
    const envFilePath = join(workDir, "protected-envfile-allowed.yaml");
    await writeFile(envFilePath, `$protected: true\nbaseUrl: "${fixture.baseUrl}"\n`, "utf-8");
    const flowPath = join(workDir, "protected-via-envfile-allowed.yaml");
    await writeFile(
      flowPath,
      'name: protected flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "{{baseUrl}}/ok"\n    assert:\n      status: 200\n',
      "utf-8",
    );

    const exitCode = await runCommand(
      [flowPath],
      baseOptions({ envFile: envFilePath, allowProtected: true }),
    );

    expect(exitCode).toBe(0);
    const report = readJson();
    expect(report.status).toBe("passed");
  });

  it("--env オプションが RunFlowOptions.envNameOverride として runLoadedFlows に渡り、指定した環境ファイルが使われる", async () => {
    const cwdSpy = process.cwd;
    process.cwd = () => workDir;
    try {
      await mkdir(join(workDir, "environments"), { recursive: true });
      await writeFile(
        join(workDir, "environments", "custom.yaml"),
        `baseUrl: "${fixture.baseUrl}"\n`,
      );
      // flow 自体に env: は指定せず、--env での上書きのみで baseUrl が解決されることを確認する
      const flowPath = join(workDir, "env-override.yaml");
      await writeFile(
        flowPath,
        'name: env override flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "{{baseUrl}}/ok"\n    assert:\n      status: 200\n',
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions({ env: "custom" }));

      expect(exitCode).toBe(0);
      expect(mockedRunLoadedFlows).toHaveBeenCalledWith(
        [expect.objectContaining({ filePath: flowPath })],
        expect.objectContaining({ envNameOverride: "custom" }),
      );
      const report = readJson();
      expect(report.status).toBe("passed");
    } finally {
      process.cwd = cwdSpy;
    }
  });

  it("--env と --env-file の同時指定は戻り値 1 になり stderr にエラーを出す", async () => {
    const flowPath = join(workDir, "env-envfile-conflict.yaml");
    await writeFile(flowPath, VALID_FLOW_YAML, "utf-8");
    const envFilePath = join(workDir, "custom-env.yaml");
    await writeFile(envFilePath, "baseUrl: https://example.com\n", "utf-8");

    const exitCode = await runCommand(
      [flowPath],
      baseOptions({ env: "local", envFile: envFilePath }),
    );

    expect(exitCode).toBe(1);
    expect(stdoutSpy.join("")).toBe("");
    expect(stderrSpy.join("")).toContain("klaus: --env and --env-file cannot be used together");
  });

  it("--env-file が RunFlowOptions.envFilePath として runLoadedFlows に渡り、指定した任意パスの環境ファイルが使われる", async () => {
    const envFilePath = join(workDir, "outside-env.yaml");
    await writeFile(envFilePath, `baseUrl: "${fixture.baseUrl}"\n`, "utf-8");
    const flowPath = join(workDir, "env-file-flow.yaml");
    await writeFile(
      flowPath,
      'name: env file flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "{{baseUrl}}/ok"\n    assert:\n      status: 200\n',
      "utf-8",
    );

    const exitCode = await runCommand([flowPath], baseOptions({ envFile: envFilePath }));

    expect(exitCode).toBe(0);
    expect(mockedRunLoadedFlows).toHaveBeenCalledWith(
      [expect.objectContaining({ filePath: flowPath })],
      expect.objectContaining({ envFilePath }),
    );
    const report = readJson();
    expect(report.status).toBe("passed");
  });

  it("--var で渡した値がテンプレートの env 名前空間から参照できる(環境未指定でも単独で使える)", async () => {
    const flowPath = join(workDir, "var-only-flow.yaml");
    await writeFile(
      flowPath,
      'name: var only flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "{{baseUrl}}/ok"\n    assert:\n      status: 200\n',
      "utf-8",
    );

    const exitCode = await runCommand(
      [flowPath],
      baseOptions({ var: { baseUrl: fixture.baseUrl } }),
    );

    expect(exitCode).toBe(0);
    const report = readJson();
    expect(report.status).toBe("passed");
  });

  it("--var が --env-file で読み込んだ同名キーを上書きする", async () => {
    const envFilePath = join(workDir, "overridden-env.yaml");
    await writeFile(envFilePath, "baseUrl: http://127.0.0.1:1\n", "utf-8");
    const flowPath = join(workDir, "var-overrides-env-file-flow.yaml");
    await writeFile(
      flowPath,
      'name: var overrides env file flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "{{baseUrl}}/ok"\n    assert:\n      status: 200\n',
      "utf-8",
    );

    const exitCode = await runCommand(
      [flowPath],
      baseOptions({ envFile: envFilePath, var: { baseUrl: fixture.baseUrl } }),
    );

    expect(exitCode).toBe(0);
    const report = readJson();
    expect(report.status).toBe("passed");
  });

  it("アサーション失敗は戻り値 4 になり、JSON の status が failed になる", async () => {
    const flowPath = join(workDir, "assert-fail.yaml");
    await writeFile(
      flowPath,
      `name: assert fail flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 201\n`,
      "utf-8",
    );

    const exitCode = await runCommand([flowPath], baseOptions());

    expect(exitCode).toBe(4);
    const report = readJson();
    expect(report.status).toBe("failed");
  });

  it("--report junit を指定すると --report-file 先に JUnit XML が書き出される", async () => {
    const flowPath = join(workDir, "success-for-report.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );
    const reportPath = join(workDir, "report.xml");

    const exitCode = await runCommand(
      [flowPath],
      baseOptions({ report: "junit", reportFile: reportPath }),
    );

    expect(exitCode).toBe(0);
    await access(reportPath);
    const xml = await readFile(reportPath, "utf-8");
    expect(xml).toContain("<testsuite");
    expect(xml).toContain('<testcase name="ok"');
  });

  it("--report junit: {{env.X}} のシークレットを含むフローでアサーション失敗しても、書き出された XML は *** にマスクされ生値を含まない", async () => {
    const SECRET_KEY = "KLAUS_TEST_JUNIT_SECRET";
    const SECRET_VALUE = "junit-report-secret-value-456";
    process.env[SECRET_KEY] = SECRET_VALUE;
    try {
      const flowPath = join(workDir, "assert-fail-secret.yaml");
      await writeFile(
        flowPath,
        `name: assert fail flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      bodyText:\n        contains: "{{env.${SECRET_KEY}}}"\n`,
        "utf-8",
      );
      const reportPath = join(workDir, "report-secret.xml");

      const exitCode = await runCommand(
        [flowPath],
        baseOptions({ report: "junit", reportFile: reportPath }),
      );

      expect(exitCode).toBe(4);
      const xml = await readFile(reportPath, "utf-8");
      expect(xml).not.toContain(SECRET_VALUE);
      expect(xml).toContain("***");
    } finally {
      delete process.env[SECRET_KEY];
    }
  });

  it("--report junit,tap を指定すると --report-file を2回指定した順にペアで両方のファイルが書き出される", async () => {
    const flowPath = join(workDir, "success-for-multi-report.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );
    const junitPath = join(workDir, "multi-report.xml");
    const tapPath = join(workDir, "multi-report.tap");

    const exitCode = await runCommand(
      [flowPath],
      baseOptions({ report: "junit,tap", reportFile: [junitPath, tapPath] }),
    );

    expect(exitCode).toBe(0);
    const xml = await readFile(junitPath, "utf-8");
    expect(xml).toContain("<testsuite");
    expect(xml).toContain('<testcase name="ok"');
    const tap = await readFile(tapPath, "utf-8");
    expect(tap).toContain("TAP version 13");
    expect(tap).toContain("ok 1 - success flow > ok");
  });

  it("--report にフォーマット数と異なる回数の --report-file を渡すと exit 1 で何も書き出さない", async () => {
    const flowPath = join(workDir, "success-for-report-count-mismatch.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );
    const onlyPath = join(workDir, "count-mismatch.xml");

    const exitCode = await runCommand(
      [flowPath],
      // 2 フォーマットに対して --report-file は1個(baseOptions のデフォルトが単一 string で来るケースを兼ねる)
      baseOptions({ report: "junit,tap", reportFile: onlyPath }),
    );

    expect(exitCode).toBe(1);
    expect(stderrSpy.join("")).toContain("--report-file must be given exactly 2 time(s)");
    await expect(access(onlyPath)).rejects.toThrow();
  });

  it("--report に未知のフォーマットを渡すと exit 1", async () => {
    const flowPath = join(workDir, "success-for-unknown-report.yaml");
    await writeFile(flowPath, "name: any\nsteps: []\n", "utf-8");

    const exitCode = await runCommand([flowPath], baseOptions({ report: "junit,bogus" }));

    expect(exitCode).toBe(1);
    expect(stderrSpy.join("")).toContain('unknown report type in "junit,bogus"');
  });

  it("--report junit,junit のようにフォーマットが重複すると exit 1 で何も書き出さない", async () => {
    const flowPath = join(workDir, "success-for-duplicate-format.yaml");
    await writeFile(flowPath, "name: any\nsteps: []\n", "utf-8");

    const exitCode = await runCommand([flowPath], baseOptions({ report: "junit,junit" }));

    expect(exitCode).toBe(1);
    expect(stderrSpy.join("")).toContain('duplicate format "junit"');
  });

  it("--report junit,tap で --report-file を2回とも同じパスに指定すると exit 1 で何も書き出さない", async () => {
    const flowPath = join(workDir, "success-for-duplicate-path.yaml");
    await writeFile(flowPath, "name: any\nsteps: []\n", "utf-8");
    const samePath = join(workDir, "collide.out");

    const exitCode = await runCommand(
      [flowPath],
      baseOptions({ report: "junit,tap", reportFile: [samePath, samePath] }),
    );

    expect(exitCode).toBe(1);
    expect(stderrSpy.join("")).toContain(`same output path "${samePath}"`);
    await expect(access(samePath)).rejects.toThrow();
  });

  it("--report を指定し --report-file を省略すると、フォーマットごとの既定ファイル名(klaus-report.xml / klaus-report.tap)に書き出す", async () => {
    // DEFAULT_REPORT_FILENAMES は相対パスのため、既定値どおりの挙動を確認するにはカレントディレクトリを
    // 一時的に workDir に切り替える(commander 経由で実際に klaus run を叩いたときの cwd 相対解決を再現する)
    const originalCwd = process.cwd();
    process.chdir(workDir);
    try {
      const flowPath = join(workDir, "success-for-default-report-file.yaml");
      await writeFile(
        flowPath,
        `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
        "utf-8",
      );
      const defaultJunitPath = join(workDir, "klaus-report.xml");
      const defaultTapPath = join(workDir, "klaus-report.tap");

      const exitCode = await runCommand(
        [flowPath],
        baseOptions({ report: "junit,tap", reportFile: [] }),
      );

      expect(exitCode).toBe(0);
      await access(defaultJunitPath);
      await access(defaultTapPath);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("JSON 出力: {{env.X}} で解決したシークレットが平文で現れず *** にマスクされる", async () => {
    const SECRET_KEY = "KLAUS_TEST_JSON_SECRET";
    const SECRET_VALUE = "json-output-secret-value-789";
    process.env[SECRET_KEY] = SECRET_VALUE;
    try {
      const flowPath = join(workDir, "assert-fail-json-secret.yaml");
      await writeFile(
        flowPath,
        `name: assert fail flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      bodyText:\n        contains: "{{env.${SECRET_KEY}}}"\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions());

      expect(exitCode).toBe(4);
      const rawOutput = stdoutSpy.join("");
      expect(rawOutput).not.toContain(SECRET_VALUE);
      expect(rawOutput).toContain("***");
    } finally {
      delete process.env[SECRET_KEY];
    }
  });

  it("text 出力(TTY): {{env.X}} で解決したシークレットが平文で現れず *** にマスクされる", async () => {
    process.stdout.isTTY = true;
    const SECRET_KEY = "KLAUS_TEST_TEXT_SECRET";
    const SECRET_VALUE = "text-output-secret-value-321";
    process.env[SECRET_KEY] = SECRET_VALUE;
    try {
      const flowPath = join(workDir, "assert-fail-text-secret.yaml");
      await writeFile(
        flowPath,
        `name: assert fail flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      bodyText:\n        contains: "{{env.${SECRET_KEY}}}"\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions());

      expect(exitCode).toBe(4);
      const rawOutput = stdoutSpy.join("");
      expect(rawOutput).not.toContain(SECRET_VALUE);
      expect(rawOutput).toContain("***");
    } finally {
      delete process.env[SECRET_KEY];
    }
  });

  it("mask: false(--no-mask 相当)のときは stdout の JSON にシークレットが平文で出る", async () => {
    const SECRET_KEY = "KLAUS_TEST_NOMASK_SECRET";
    const SECRET_VALUE = "no-mask-secret-value-654";
    process.env[SECRET_KEY] = SECRET_VALUE;
    try {
      const flowPath = join(workDir, "assert-fail-nomask-secret.yaml");
      await writeFile(
        flowPath,
        `name: assert fail flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      bodyText:\n        contains: "{{env.${SECRET_KEY}}}"\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions({ mask: false }));

      expect(exitCode).toBe(4);
      const rawOutput = stdoutSpy.join("");
      expect(rawOutput).toContain(SECRET_VALUE);
    } finally {
      delete process.env[SECRET_KEY];
    }
  });

  it("URL エンコード変種(request.query の {{env.X}} が URLSearchParams でパーセントエンコードされた値)も JSON 出力でマスクされる", async () => {
    const QUERY_SECRET_KEY = "KLAUS_TEST_CLI_QUERY_SECRET";
    // + と = を含む base64 風の値。URLSearchParams.set() 経由で組むとパーセントエンコードされ、
    // 生の値のままでは maskString の単純な部分一致に失敗する(tests/runner.test.ts の同種テストと同じ再現条件)
    const QUERY_SECRET_VALUE = "aB+cd/Ef==";
    process.env[QUERY_SECRET_KEY] = QUERY_SECRET_VALUE;
    try {
      const flowPath = join(workDir, "assert-fail-query-secret.yaml");
      await writeFile(
        flowPath,
        `name: assert fail flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n      query:\n        token: "{{env.${QUERY_SECRET_KEY}}}"\n    assert:\n      status: 201\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions());

      expect(exitCode).toBe(4);
      const report = readJson() as {
        flows: Array<{ steps: Array<{ request?: { url: string } }> }>;
      };
      const url = report.flows[0]?.steps[0]?.request?.url ?? "";
      expect(url).toBe(`${fixture.baseUrl}/ok?token=***`);
      expect(url).not.toContain(QUERY_SECRET_VALUE);
      expect(url).not.toContain(encodeURIComponent(QUERY_SECRET_VALUE));
    } finally {
      delete process.env[QUERY_SECRET_KEY];
    }
  });

  it("request.url テンプレートに直書きした secret が WHATWG URL 正規化形でエコーされても JSON 出力に平文が現れない(#42)", async () => {
    const URL_SECRET_KEY = "KLAUS_TEST_URL_LITERAL_SECRET";
    // 空白と記号(@ / + = !)を含む値。undici が送信時に行う WHATWG URL 正規化により
    // 空白のみ %20 化された "p@ss%20w/rd+key=99!" という、生値・encodeURIComponent 形・
    // form-urlencoded 形のいずれとも一致しない形でリクエスト行に載る(#42 の再現条件)。
    const URL_SECRET_VALUE = "p@ss w/rd+key=99!";
    process.env[URL_SECRET_KEY] = URL_SECRET_VALUE;
    try {
      const flowPath = join(workDir, "url-literal-secret.yaml");
      await writeFile(
        flowPath,
        // query: ではなく url: テンプレートへ直書きする(applyQueryParams の URLSearchParams 経由を通さない)
        `name: url literal secret flow\nsteps:\n  - name: leak\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/echo?token={{env.${URL_SECRET_KEY}}}"\n    assert:\n      status: 201\n`,
        "utf-8",
      );

      // 実際の応答は 200 のため必ず失敗し、response スナップショット(エコーされた URL を含む)が JSON 出力に含まれる
      const exitCode = await runCommand([flowPath], baseOptions());

      expect(exitCode).toBe(4);
      const rawOutput = stdoutSpy.join("");
      expect(rawOutput).not.toContain(URL_SECRET_VALUE);
      expect(rawOutput).not.toContain(encodeURI(URL_SECRET_VALUE));
      expect(rawOutput).toContain("***");
    } finally {
      delete process.env[URL_SECRET_KEY];
    }
  });

  it('JSON 出力: `"` を含むシークレットが equals アサーション失敗メッセージの JSON エスケープ形でも平文で現れず *** にマスクされる', async () => {
    const SECRET_KEY = "KLAUS_TEST_JSON_ESCAPE_SECRET";
    // assert.ts の bodyText.equals 失敗メッセージは JSON.stringify(expected) を埋め込むため、
    // `"` を含むこの値はエスケープ済みの形(ab\"cd5)でメッセージに現れる
    // (JSON.stringify 後の単純な文字列置換では検出できない再現条件)。
    const SECRET_VALUE = 'ab"cd5';
    process.env[SECRET_KEY] = SECRET_VALUE;
    try {
      const flowPath = join(workDir, "assert-fail-json-escape-secret.yaml");
      await writeFile(
        flowPath,
        `name: assert fail flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      bodyText:\n        equals: "{{env.${SECRET_KEY}}}"\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions());

      expect(exitCode).toBe(4);
      const rawOutput = stdoutSpy.join("");
      const jsonEscaped = JSON.stringify(SECRET_VALUE).slice(1, -1);
      expect(rawOutput).not.toContain(SECRET_VALUE);
      expect(rawOutput).not.toContain(jsonEscaped);
      expect(rawOutput).toContain("***");
    } finally {
      delete process.env[SECRET_KEY];
    }
  });

  it('text 出力(TTY): `"` を含むシークレットが equals アサーション失敗メッセージの JSON エスケープ形でも平文で現れず *** にマスクされる', async () => {
    process.stdout.isTTY = true;
    const SECRET_KEY = "KLAUS_TEST_TEXT_JSON_ESCAPE_SECRET";
    const SECRET_VALUE = 'ef"gh6';
    process.env[SECRET_KEY] = SECRET_VALUE;
    try {
      const flowPath = join(workDir, "assert-fail-text-json-escape-secret.yaml");
      await writeFile(
        flowPath,
        `name: assert fail flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      bodyText:\n        equals: "{{env.${SECRET_KEY}}}"\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions());

      expect(exitCode).toBe(4);
      const rawOutput = stdoutSpy.join("");
      const jsonEscaped = JSON.stringify(SECRET_VALUE).slice(1, -1);
      expect(rawOutput).not.toContain(SECRET_VALUE);
      expect(rawOutput).not.toContain(jsonEscaped);
      expect(rawOutput).toContain("***");
    } finally {
      delete process.env[SECRET_KEY];
    }
  });

  it("--report を指定しない場合はレポートファイルを書き出さない", async () => {
    const flowPath = join(workDir, "success-no-report.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );
    const reportPath = join(workDir, "unused-report.xml");

    const exitCode = await runCommand([flowPath], baseOptions({ reportFile: reportPath }));

    expect(exitCode).toBe(0);
    await expect(access(reportPath)).rejects.toThrow();
  });

  it('--record <dir> が RunFlowOptions.recording に { mode: "record", dir } として変換されて runLoadedFlows に渡る', async () => {
    const recordDir = await mkdtemp(join(tmpRoot, "klaus-run-record-"));
    try {
      const flowPath = join(workDir, "record-single.yaml");
      await writeFile(
        flowPath,
        `name: record flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions({ record: recordDir }));

      expect(exitCode).toBe(0);
      expect(mockedRunLoadedFlows).toHaveBeenCalledWith(
        [expect.objectContaining({ filePath: flowPath })],
        expect.objectContaining({ recording: { mode: "record", dir: recordDir } }),
      );
    } finally {
      await rm(recordDir, { recursive: true, force: true });
    }
  });

  it('--replay <dir> が RunFlowOptions.recording に { mode: "replay", dir } として変換されて runLoadedFlows に渡る', async () => {
    // カセットが存在しなくても(replay 実行自体が失敗しても)runLoadedFlows への引数変換は検証できる
    // (同時指定エラーは tests/record-replay.test.ts で別途検証済みのため、ここでは変換のみを見る)
    const replayDir = await mkdtemp(join(tmpRoot, "klaus-run-replay-"));
    try {
      const flowPath = join(workDir, "replay-single.yaml");
      await writeFile(
        flowPath,
        `name: replay flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
        "utf-8",
      );

      await runCommand([flowPath], baseOptions({ replay: replayDir }));

      expect(mockedRunLoadedFlows).toHaveBeenCalledWith(
        [expect.objectContaining({ filePath: flowPath })],
        expect.objectContaining({ recording: { mode: "replay", dir: replayDir } }),
      );
    } finally {
      await rm(replayDir, { recursive: true, force: true });
    }
  });

  it("history: false のときは .klaus/history に何も書き込まれない", async () => {
    const cwdSpy = process.cwd;
    process.cwd = () => workDir;
    try {
      const flowPath = join(workDir, "success-no-history.yaml");
      await writeFile(
        flowPath,
        `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions({ history: false }));

      expect(exitCode).toBe(0);
      await expect(access(join(workDir, ".klaus", "history"))).rejects.toThrow();
      // JSON 出力にも historyRef が付与されない
      const report = readJson() as { flows: Array<{ steps: Array<{ historyRef?: unknown }> }> };
      expect(report.flows[0]?.steps[0]?.historyRef).toBeUndefined();
    } finally {
      process.cwd = cwdSpy;
    }
  });

  it("history: true のときは cwd 直下の .klaus/history/<date>.jsonl に書き込まれる", async () => {
    const cwdSpy = process.cwd;
    process.cwd = () => workDir;
    try {
      const flowPath = join(workDir, "success-with-history.yaml");
      await writeFile(
        flowPath,
        `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions({ history: true }));

      expect(exitCode).toBe(0);
      const historyContent = await readFile(historyFilePath(workDir), "utf-8");
      expect(historyContent).toContain('"flow":"success flow"');
      const report = readJson() as { flows: Array<{ steps: Array<{ historyRef?: unknown }> }> };
      expect(report.flows[0]?.steps[0]?.historyRef).toBeDefined();
    } finally {
      process.cwd = cwdSpy;
    }
  });

  it("--jobs 2 以上でも履歴 JSONL には全エントリが書き込まれる(行の順序は保証しない)", async () => {
    const cwdSpy = process.cwd;
    process.cwd = () => workDir;
    try {
      // 各フロー2ステップ × 3フロー = 6行を期待する。並行 appendFile(O_APPEND)により行の順序は
      // 実行のたびに変わり得るため、ここでは件数と (flow, step) の組の集合のみを検証する
      // (順序に依存しないアサーション)。
      const flowNames = ["history a", "history b", "history c"];
      const flowPaths = flowNames.map((name, index) => {
        const flowPath = join(workDir, `history-jobs-${index}.yaml`);
        return { name, flowPath };
      });
      for (const { name, flowPath } of flowPaths) {
        await writeFile(
          flowPath,
          `name: ${name}\nsteps:\n  - name: step1\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n  - name: step2\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
          "utf-8",
        );
      }

      const exitCode = await runCommand(
        flowPaths.map((f) => f.flowPath),
        baseOptions({ history: true, jobs: 3 }),
      );

      expect(exitCode).toBe(0);
      const historyContent = await readFile(historyFilePath(workDir), "utf-8");
      const lines = historyContent.trim().split("\n");
      expect(lines).toHaveLength(6);
      const entries = lines.map(
        (line) => JSON.parse(line) as { flow: string; step: string; runId: string },
      );
      const keys = new Set(entries.map((e) => `${e.flow}:${e.step}`));
      const expectedKeys = new Set(flowNames.flatMap((name) => [`${name}:step1`, `${name}:step2`]));
      expect(keys).toEqual(expectedKeys);
      // runId は全エントリで共有される
      expect(new Set(entries.map((e) => e.runId)).size).toBe(1);
    } finally {
      process.cwd = cwdSpy;
    }
  });

  it("複数ファイルを指定すると全ファイルが実行され、JSON の flows に両方含まれる", async () => {
    const flowPathA = join(workDir, "multi-a.yaml");
    const flowPathB = join(workDir, "multi-b.yaml");
    await writeFile(
      flowPathA,
      `name: flow a\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );
    await writeFile(
      flowPathB,
      `name: flow b\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const exitCode = await runCommand([flowPathA, flowPathB], baseOptions());

    expect(exitCode).toBe(0);
    const report = readJson() as { flows: Array<{ name: string }> };
    expect(report.flows).toHaveLength(2);
    expect(report.flows.map((flow) => flow.name)).toEqual(["flow a", "flow b"]);
  });

  it("環境ファイル(environments/<name>.yaml)が壊れている場合、runLoadedFlows 側の ParseError も戻り値 2 に丸められる", async () => {
    const cwdSpy = process.cwd;
    process.cwd = () => workDir;
    try {
      const environmentsDir = join(workDir, "environments");
      await mkdir(environmentsDir, { recursive: true });
      await writeFile(join(environmentsDir, "broken.yaml"), "baseUrl: [\n", "utf-8");

      const flowPath = join(workDir, "needs-broken-env.yaml");
      await writeFile(
        flowPath,
        `name: needs env flow\nenv: broken\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions());

      expect(exitCode).toBe(2);
      expect(stdoutSpy.join("")).toBe("");
      expect(stderrSpy.join("")).toContain("klaus: parse error:");
      expect(stderrSpy.join("")).toContain("broken.yaml");
    } finally {
      process.cwd = cwdSpy;
    }
  });

  it("TTY(テキストモード)ではステップ進捗とサマリーが逐次テキストで出力される", async () => {
    process.stdout.isTTY = true;
    const flowPath = join(workDir, "success-text.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const exitCode = await runCommand([flowPath], baseOptions());

    expect(exitCode).toBe(0);
    const output = stdoutSpy.join("");
    // フローヘッダー(onStepStart)・ステップ結果行(onStepComplete)・サマリー(printSummary)の3種が出る
    expect(output).toContain(`success flow (${flowPath})`);
    expect(output).toContain("PASS ok");
    expect(output).toMatch(/1 flow, 1 step: 1 passed/);
  });

  it("非 TTY でも --text を指定すると text 出力になる(#46)", async () => {
    // beforeEach で isTTY は非 TTY(undefined)に固定済み
    const flowPath = join(workDir, "success-text-forced.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const exitCode = await runCommand([flowPath], baseOptions({ text: true }));

    expect(exitCode).toBe(0);
    const output = stdoutSpy.join("");
    expect(output).toContain(`success flow (${flowPath})`);
    expect(output).toContain("PASS ok");
    expect(output).toMatch(/1 flow, 1 step: 1 passed/);
    // JSON としてはパースできない(text 出力である証拠)
    expect(() => JSON.parse(output)).toThrow();
  });

  it("非 TTY + --text + FORCE_COLOR=1 では ANSI カラーコードが出力に含まれる(#46 の完了条件)", async () => {
    const originalForceColor = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const flowPath = join(workDir, "success-text-color.yaml");
      await writeFile(
        flowPath,
        `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions({ text: true }));

      expect(exitCode).toBe(0);
      const output = stdoutSpy.join("");
      // ANSI green (PASS 行の色付け)
      expect(output).toContain("\x1b[32m");
      expect(output).toContain("\x1b[0m");
    } finally {
      if (originalForceColor === undefined) {
        delete process.env.FORCE_COLOR;
      } else {
        process.env.FORCE_COLOR = originalForceColor;
      }
    }
  });

  it("--text + --no-mask(mask: false)ではマスキングを介さず直接 stdout に書き出される", async () => {
    const flowPath = join(workDir, "success-text-nomask.yaml");
    await writeFile(
      flowPath,
      `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    const exitCode = await runCommand([flowPath], baseOptions({ text: true, mask: false }));

    expect(exitCode).toBe(0);
    const output = stdoutSpy.join("");
    expect(output).toContain(`success flow (${flowPath})`);
    expect(output).toContain("PASS ok");
  });

  it("--jobs 2 の text 出力は完了順ではなく入力順を保つ(先頭フローを最も遅くする)", async () => {
    process.stdout.isTTY = true;

    // /order-slow は /order-fast が呼ばれるまで応答を保留する(先頭ユニットが最後に完了することを保証する)
    let releaseSlow: (() => void) | undefined;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const server = createServer((req, res) => {
      if (req.url === "/order-fast") {
        releaseSlow?.();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/order-slow") {
        slowGate.then(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const { baseUrl } = await listenEphemeral(server);

    try {
      const slowPath = join(workDir, "order-slow.yaml");
      await writeFile(
        slowPath,
        `name: flow slow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${baseUrl}/order-slow"\n    assert:\n      status: 200\n`,
        "utf-8",
      );
      const fastPath = join(workDir, "order-fast.yaml");
      await writeFile(
        fastPath,
        `name: flow fast\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${baseUrl}/order-fast"\n    assert:\n      status: 200\n`,
        "utf-8",
      );

      const exitCode = await runCommand([slowPath, fastPath], baseOptions({ jobs: 2 }));

      expect(exitCode).toBe(0);
      const output = stdoutSpy.join("");
      // flow fast のリクエストが先に完了する(それが flow slow のゲートを開ける)にも関わらず、
      // text 出力は入力順(flow slow のブロックが先)のまま
      const slowHeaderIndex = output.indexOf(`flow slow (${slowPath})`);
      const fastHeaderIndex = output.indexOf(`flow fast (${fastPath})`);
      expect(slowHeaderIndex).toBeGreaterThanOrEqual(0);
      expect(fastHeaderIndex).toBeGreaterThan(slowHeaderIndex);
      // サマリー行は全ユニット完了後、最後に1回だけ出る
      expect(output).toMatch(/2 flows, 2 steps: 2 passed/);
    } finally {
      await closeServer(server);
    }
  });

  it("--jobs 2: skipRest によるスキップ・if 条件不成立のスキップ・retry 失敗が混在していても、各ユニットの完了カウントが崩れず全ブロックが入力順で漏れなくフラッシュされる", async () => {
    process.stdout.isTTY = true;

    // flow skiprest: 1つ目が失敗し(continueOnError 無し)、後続2ステップが skipRest によりスキップされる。
    // 「onStepComplete が flow.steps.length(=3)回揃うまで待つ」createOrderedTextFlusher の完了カウントが、
    // skipRest によるスキップでも正しく1回ずつ計上されることを検証する対象
    const skipRestPath = join(workDir, "risky-skiprest.yaml");
    await writeFile(
      skipRestPath,
      `name: flow skiprest\nsteps:\n  - name: fail-first\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 500\n  - name: after-fail-1\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n  - name: after-fail-2\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
      "utf-8",
    );

    // flow retry-if: if 条件不成立によるスキップ(skipRest とは別経路)と、retry(count:1 で2回試行して
    // 最終的に failed)が同じフロー内に混在する。retry は中間試行を含め onStepComplete が1回だけ
    // 呼ばれる契約のため、この完了カウントがずれるとユニットが永遠に flush されず出力がハングし得る
    const retryIfPath = join(workDir, "risky-retry-if.yaml");
    await writeFile(
      retryIfPath,
      `name: flow retry-if\nsteps:\n  - name: passing-step\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n  - name: conditional-skip\n    if: "steps.passing-step.status == 'failed'"\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n  - name: retry-fail\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 500\n    retry:\n      count: 1\n      intervalMs: 0\n`,
      "utf-8",
    );

    const exitCode = await runCommand([skipRestPath, retryIfPath], baseOptions({ jobs: 2 }));

    // fail-first・retry-fail のアサーション失敗により、両フローとも failed(exit code 4)
    expect(exitCode).toBe(4);
    const output = stdoutSpy.join("");

    const skipRestHeaderIndex = output.indexOf(`flow skiprest (${skipRestPath})`);
    const retryIfHeaderIndex = output.indexOf(`flow retry-if (${retryIfPath})`);
    expect(skipRestHeaderIndex).toBeGreaterThanOrEqual(0);
    // 入力順(flow skiprest が先)のまま、途中で欠落せずに次のブロックへ進む
    expect(retryIfHeaderIndex).toBeGreaterThan(skipRestHeaderIndex);

    const skipRestBlock = output.slice(skipRestHeaderIndex, retryIfHeaderIndex);
    expect(skipRestBlock).toContain("FAIL fail-first");
    expect(skipRestBlock).toContain("SKIP after-fail-1");
    expect(skipRestBlock).toContain("SKIP after-fail-2");

    const retryIfBlock = output.slice(retryIfHeaderIndex);
    expect(retryIfBlock).toContain("PASS passing-step");
    expect(retryIfBlock).toContain("SKIP conditional-skip");
    expect(retryIfBlock).toContain("FAIL retry-fail");
    // サマリー行(1 passed / 2 failed / 3 skipped、計6ステップ)まで到達する = 最後のユニットまで
    // flush が止まらず(ハングせず)完了したことの証拠
    expect(output).toMatch(/2 flows, 6 steps: 1 passed, 2 failed, 3 skipped/);
  });

  it("--json と --text の同時指定は戻り値 1 になり stderr にエラーを出す", async () => {
    const flowPath = join(workDir, "any-json-text.yaml");
    await writeFile(flowPath, VALID_FLOW_YAML, "utf-8");

    const exitCode = await runCommand([flowPath], baseOptions({ json: true, text: true }));

    expect(exitCode).toBe(1);
    expect(stdoutSpy.join("")).toBe("");
    expect(stderrSpy.join("")).toContain("klaus: --json and --text cannot be used together");
  });

  it("履歴書き込みが失敗してもステップの成否には影響せず、stderr に warning が出る", async () => {
    const cwdSpy = process.cwd;
    process.cwd = () => workDir;
    try {
      // .klaus をディレクトリではなくファイルにしておき、appendHistory 内の mkdir(recursive) を
      // ENOTDIR で失敗させる(履歴書き込み失敗を実際のファイルシステムエラーで再現する)
      await writeFile(join(workDir, ".klaus"), "not a directory", "utf-8");

      const flowPath = join(workDir, "success-history-fail.yaml");
      await writeFile(
        flowPath,
        `name: success flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions({ history: true }));

      // 履歴書き込み失敗はステップの成否に影響しない(exit 0 のまま)
      expect(exitCode).toBe(0);
      expect(stderrSpy.join("")).toContain("klaus: warning:");
      expect(stderrSpy.join("")).toContain("failed to write history");
    } finally {
      process.cwd = cwdSpy;
    }
  });

  it("loadFlow が ParseError 以外を投げた場合、runCommand は catch せずそのまま呼び出し元へ伝播させる", async () => {
    const flowPath = join(workDir, "any.yaml");
    await writeFile(flowPath, VALID_FLOW_YAML, "utf-8");
    const unexpectedError = new Error("unexpected failure unrelated to schema validation");
    vi.mocked(mockedLoadFlow).mockRejectedValueOnce(unexpectedError);

    await expect(runCommand([flowPath], baseOptions())).rejects.toThrow(unexpectedError);
  });

  it("runLoadedFlows が ParseError 以外を投げた場合、runCommand は catch せずそのまま呼び出し元へ伝播させる", async () => {
    const flowPath = join(workDir, "any-runflows.yaml");
    await writeFile(flowPath, VALID_FLOW_YAML, "utf-8");
    const unexpectedError = new Error("unexpected runtime bug unrelated to environment parsing");
    vi.mocked(mockedRunLoadedFlows).mockRejectedValueOnce(unexpectedError);

    await expect(runCommand([flowPath], baseOptions())).rejects.toThrow(unexpectedError);
  });

  describe("--data", () => {
    it("2行のデータファイル × 1フローで RunResult.flows に iteration 1,2 が入り、行の値がテンプレートで解決される", async () => {
      const dataPath = join(workDir, "rows.json");
      await writeFile(dataPath, JSON.stringify([{ name: "alice" }, { name: "bob" }]), "utf-8");
      const flowPath = join(workDir, "data-flow.yaml");
      await writeFile(
        flowPath,
        `name: data flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/echo"\n      query:\n        u: "{{name}}"\n    assert:\n      status: 200\n      bodyText:\n        contains: "{{name}}"\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions({ data: dataPath }));

      expect(exitCode).toBe(0);
      const report = readJson() as {
        status: string;
        flows: Array<{ name: string; status: string; iteration?: number }>;
      };
      expect(report.status).toBe("passed");
      expect(report.flows).toHaveLength(2);
      expect(report.flows[0]?.iteration).toBe(1);
      expect(report.flows[1]?.iteration).toBe(2);
    });

    it("行の値が --var の同名キーより優先される(row > --var)", async () => {
      const dataPath = join(workDir, "precedence-rows.json");
      await writeFile(dataPath, JSON.stringify([{ baseUrl: fixture.baseUrl }]), "utf-8");
      const flowPath = join(workDir, "precedence-flow.yaml");
      await writeFile(
        flowPath,
        'name: precedence flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "{{baseUrl}}/ok"\n    assert:\n      status: 200\n',
        "utf-8",
      );

      // --var 側は到達不能なアドレスにしておき、row が優先されなかった場合は接続不能(exit 3)で検知できるようにする
      const exitCode = await runCommand(
        [flowPath],
        baseOptions({ data: dataPath, var: { baseUrl: "http://127.0.0.1:1" } }),
      );

      expect(exitCode).toBe(0);
      const report = readJson();
      expect(report.status).toBe("passed");
    });

    it("値が null の行キーはテンプレート変数として注入されず、参照すると未解決変数エラーになる", async () => {
      const dataPath = join(workDir, "null-rows.json");
      await writeFile(dataPath, JSON.stringify([{ token: null }]), "utf-8");
      const flowPath = join(workDir, "null-flow.yaml");
      await writeFile(
        flowPath,
        `name: null flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok?token={{token}}"\n    assert:\n      status: 200\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions({ data: dataPath }));

      expect(exitCode).toBe(3);
      const report = readJson() as {
        flows: Array<{ steps: Array<{ status: string; error?: string }> }>;
      };
      expect(report.flows[0]?.steps[0]?.status).toBe("error");
      expect(report.flows[0]?.steps[0]?.error).toContain('template variable "token"');
    });

    it("一部の行だけアサーション失敗しても他のイテレーションには影響せず、run 全体は failed に集約される", async () => {
      const dataPath = join(workDir, "agg-rows.json");
      await writeFile(dataPath, JSON.stringify([{ path: "ok" }, { path: "missing" }]), "utf-8");
      const flowPath = join(workDir, "agg-flow.yaml");
      await writeFile(
        flowPath,
        `name: agg flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/{{path}}"\n    assert:\n      status: 200\n`,
        "utf-8",
      );

      const exitCode = await runCommand([flowPath], baseOptions({ data: dataPath }));

      expect(exitCode).toBe(4);
      const report = readJson() as {
        status: string;
        flows: Array<{ status: string; iteration?: number }>;
      };
      expect(report.status).toBe("failed");
      expect(report.flows).toHaveLength(2);
      expect(report.flows[0]?.status).toBe("passed");
      expect(report.flows[1]?.status).toBe("failed");
    });

    it("履歴エントリに iteration が記録される", async () => {
      const cwdSpy = process.cwd;
      process.cwd = () => workDir;
      try {
        const dataPath = join(workDir, "history-rows.json");
        await writeFile(dataPath, JSON.stringify([{ name: "alice" }, { name: "bob" }]), "utf-8");
        const flowPath = join(workDir, "history-data-flow.yaml");
        await writeFile(
          flowPath,
          `name: history data flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
          "utf-8",
        );

        const exitCode = await runCommand(
          [flowPath],
          baseOptions({ data: dataPath, history: true }),
        );

        expect(exitCode).toBe(0);
        const historyContent = await readFile(historyFilePath(workDir), "utf-8");
        const entries = historyContent
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { iteration?: number });
        expect(entries.map((entry) => entry.iteration)).toEqual([1, 2]);
      } finally {
        process.cwd = cwdSpy;
      }
    });

    it("データファイルが配列でない場合、戻り値 2 になり ParseError メッセージ(ファイルパス含む)を stderr に出す", async () => {
      const dataPath = join(workDir, "invalid-rows.json");
      // オブジェクトの配列ではなく単一オブジェクト(loadDataFile のスキーマ違反)
      await writeFile(dataPath, JSON.stringify({ name: "alice" }), "utf-8");
      const flowPath = join(workDir, "data-invalid-flow.yaml");
      await writeFile(flowPath, VALID_FLOW_YAML, "utf-8");

      const exitCode = await runCommand([flowPath], baseOptions({ data: dataPath }));

      expect(exitCode).toBe(2);
      expect(stdoutSpy.join("")).toBe("");
      expect(stderrSpy.join("")).toContain("klaus: parse error:");
      expect(stderrSpy.join("")).toContain(dataPath);
    });

    it("--data の ParseError とフロー定義の ParseError が同時に起きた場合、戻り値 2 になり両方のメッセージが stderr に出る", async () => {
      const dataPath = join(workDir, "invalid-rows-both.json");
      await writeFile(dataPath, JSON.stringify({ name: "alice" }), "utf-8");
      const brokenFlowPath = join(workDir, "broken-both-flow.yaml");
      // request.url が無くスキーマ違反
      await writeFile(
        brokenFlowPath,
        "name: broken flow\nsteps:\n  - name: step1\n    request:\n      method: GET\n",
        "utf-8",
      );

      const exitCode = await runCommand([brokenFlowPath], baseOptions({ data: dataPath }));

      expect(exitCode).toBe(2);
      expect(stdoutSpy.join("")).toBe("");
      const stderrOutput = stderrSpy.join("");
      expect(stderrOutput).toContain(dataPath);
      expect(stderrOutput).toContain(brokenFlowPath);
    });
  });

  describe("--tags / --exclude-tags", () => {
    /** tags 未指定(タグ無しフロー)を含む2フローを workDir に書き出す共通セットアップ */
    async function writeTaggedFlows(): Promise<{ taggedPath: string; untaggedPath: string }> {
      const taggedPath = join(workDir, "tagged-flow.yaml");
      await writeFile(
        taggedPath,
        `name: tagged flow\ntags: [smoke, auth]\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
        "utf-8",
      );
      const untaggedPath = join(workDir, "untagged-flow.yaml");
      await writeFile(
        untaggedPath,
        `name: untagged flow\nsteps:\n  - name: ok\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/ok"\n    assert:\n      status: 200\n`,
        "utf-8",
      );
      return { taggedPath, untaggedPath };
    }

    it("--tags は一致するタグを持つフローだけを実行する(OR 条件)", async () => {
      const { taggedPath, untaggedPath } = await writeTaggedFlows();

      const exitCode = await runCommand(
        [taggedPath, untaggedPath],
        baseOptions({ tags: ["smoke"] }),
      );

      expect(exitCode).toBe(0);
      const report = readJson() as { flows: Array<{ name: string }> };
      expect(report.flows).toHaveLength(1);
      expect(report.flows[0]?.name).toBe("tagged flow");
    });

    it("--exclude-tags は一致するタグを持つフローを除外する", async () => {
      const { taggedPath, untaggedPath } = await writeTaggedFlows();

      const exitCode = await runCommand(
        [taggedPath, untaggedPath],
        baseOptions({ excludeTags: ["smoke"] }),
      );

      expect(exitCode).toBe(0);
      const report = readJson() as { flows: Array<{ name: string }> };
      expect(report.flows).toHaveLength(1);
      expect(report.flows[0]?.name).toBe("untagged flow");
    });

    it("--tags と --exclude-tags の両方に一致するフローは除外される(除外が優先)", async () => {
      const { taggedPath, untaggedPath } = await writeTaggedFlows();

      const exitCode = await runCommand(
        [taggedPath, untaggedPath],
        baseOptions({ tags: ["smoke"], excludeTags: ["auth"] }),
      );

      // tagged-flow は --tags(smoke)にも --exclude-tags(auth)にも一致するため除外され、
      // untagged-flow は --tags のどれとも一致しないため除外される → 残り0件で exit 1
      expect(exitCode).toBe(1);
      expect(stdoutSpy.join("")).toBe("");
      expect(stderrSpy.join("")).toContain("klaus: no flows match the specified tags");
    });

    it("タグ無しフローは --tags 指定時は除外され、--exclude-tags のみ指定時は保持される", async () => {
      const { untaggedPath } = await writeTaggedFlows();

      const excludeOnlyExitCode = await runCommand(
        [untaggedPath],
        baseOptions({ excludeTags: ["smoke"] }),
      );
      expect(excludeOnlyExitCode).toBe(0);
      const report = readJson() as { flows: Array<{ name: string }> };
      expect(report.flows).toHaveLength(1);
      expect(report.flows[0]?.name).toBe("untagged flow");
    });

    it("絞り込み結果が0件になると戻り値1になり stderr にメッセージを出し、何も実行されない", async () => {
      const { taggedPath, untaggedPath } = await writeTaggedFlows();

      const exitCode = await runCommand(
        [taggedPath, untaggedPath],
        baseOptions({ tags: ["nonexistent"] }),
      );

      expect(exitCode).toBe(1);
      expect(stdoutSpy.join("")).toBe("");
      expect(stderrSpy.join("")).toContain("klaus: no flows match the specified tags");
    });

    it("--data と組み合わせると絞り込み後のフロー × 行数で実行される(2フロー中1件マッチ × 2行 = 2 FlowResults)", async () => {
      const { taggedPath, untaggedPath } = await writeTaggedFlows();
      const dataPath = join(workDir, "tags-data-rows.json");
      await writeFile(dataPath, JSON.stringify([{ a: "1" }, { a: "2" }]), "utf-8");

      const exitCode = await runCommand(
        [taggedPath, untaggedPath],
        baseOptions({ tags: ["smoke"], data: dataPath }),
      );

      expect(exitCode).toBe(0);
      const report = readJson() as {
        flows: Array<{ name: string; iteration?: number }>;
      };
      expect(report.flows).toHaveLength(2);
      expect(report.flows.every((flow) => flow.name === "tagged flow")).toBe(true);
      expect(report.flows[0]?.iteration).toBe(1);
      expect(report.flows[1]?.iteration).toBe(2);
    });
  });
});
