import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunCommandOptions, runCommand } from "../../src/cli/run.js";

// loadFlow/runFlows が ParseError 以外を投げた場合、runCommand が catch せずそのまま呼び出し元へ
// 伝播させる契約(run.ts の JSDoc に明記)をテストするため、実装は素通しのままフックできるようにする。
vi.mock("../../src/core/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/index.js")>();
  return { ...actual, loadFlow: vi.fn(actual.loadFlow), runFlows: vi.fn(actual.runFlows) };
});
const { loadFlow: mockedLoadFlow, runFlows: mockedRunFlows } = await import(
  "../../src/core/index.js"
);

const projectRoot = join(__dirname, "..", "..");
const tmpRoot = join(projectRoot, "tmp");

/** mock 経由の伝播テストなど、実際には実行されない(loadFlow/runFlows をモックする)ケース向けの最小フロー定義 */
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
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
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
    return { history: false, reportFile: join(workDir, "klaus-report.xml"), ...overrides };
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
      const today = new Date().toISOString().slice(0, 10);
      const historyContent = await readFile(
        join(workDir, ".klaus", "history", `${today}.jsonl`),
        "utf-8",
      );
      expect(historyContent).toContain('"flow":"success flow"');
      const report = readJson() as { flows: Array<{ steps: Array<{ historyRef?: unknown }> }> };
      expect(report.flows[0]?.steps[0]?.historyRef).toBeDefined();
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

  it("環境ファイル(environments/<name>.yaml)が壊れている場合、runFlows 側の ParseError も戻り値 2 に丸められる", async () => {
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

  it("runFlows が ParseError 以外を投げた場合、runCommand は catch せずそのまま呼び出し元へ伝播させる", async () => {
    const flowPath = join(workDir, "any-runflows.yaml");
    await writeFile(flowPath, VALID_FLOW_YAML, "utf-8");
    const unexpectedError = new Error("unexpected runtime bug unrelated to environment parsing");
    vi.mocked(mockedRunFlows).mockRejectedValueOnce(unexpectedError);

    await expect(runCommand([flowPath], baseOptions())).rejects.toThrow(unexpectedError);
  });
});
