import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DryRunReport } from "../../src/cli/reporters/dry-run.js";
import { type RunCommandOptions, runCommand } from "../../src/cli/run.js";
import { closeServer, listenEphemeral } from "../support/net.js";

const projectRoot = join(__dirname, "..", "..");
const tmpRoot = join(projectRoot, "tmp");

/** 受信リクエスト数を数える fixture(--dry-run が何も送信しないことの確認用) */
async function startCountingServer() {
  let requestCount = 0;
  const server = createServer((_req, res) => {
    requestCount++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  const { baseUrl } = await listenEphemeral(server);
  return { server, baseUrl, count: () => requestCount };
}

describe("runCommand --dry-run", () => {
  let fixture: Awaited<ReturnType<typeof startCountingServer>>;
  let workDir: string;
  let stdoutSpy: string[];
  let stderrSpy: string[];
  let stdoutWriteSpy: typeof process.stdout.write;
  let stderrWriteSpy: typeof process.stderr.write;
  let isTtySpy: boolean | undefined;

  beforeAll(async () => {
    fixture = await startCountingServer();
  });

  afterAll(async () => {
    await closeServer(fixture.server);
  });

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    workDir = await mkdtemp(join(tmpRoot, "klaus-dryrun-cli-"));
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

  function readJson(): DryRunReport {
    return JSON.parse(stdoutSpy.join(""));
  }

  function baseOptions(overrides: Partial<RunCommandOptions> = {}): RunCommandOptions {
    return {
      history: true,
      mask: true,
      reportFile: join(workDir, "klaus-report.xml"),
      dryRun: true,
      ...overrides,
    };
  }

  async function writeFlow(name: string, yaml: string): Promise<string> {
    const path = join(workDir, name);
    await writeFile(path, yaml, "utf-8");
    return path;
  }

  const CHAIN_FLOW = (baseUrl: string) => `name: chain
steps:
  - name: login
    request:
      method: POST
      url: "${baseUrl}/login"
      body: { user: a }
    capture: { token: "$.token" }
  - name: me
    if: 'steps.login.status == "passed"'
    request:
      method: GET
      url: "${baseUrl}/me"
      headers: { Authorization: "Bearer {{token}}" }
`;

  it("2 ステップ(capture 依存つき): 何も送信せず、履歴も書かず、dryRun: true の JSON を出して exit 0", async () => {
    const flow = await writeFlow("chain.yaml", CHAIN_FLOW(fixture.baseUrl));
    const before = fixture.count();
    // 履歴は process.cwd() 基準で書かれるため、workDir を cwd に見せて「何も書かれないこと」を確認する
    const cwdSpy = process.cwd;
    process.cwd = () => workDir;
    let code: number;
    try {
      code = await runCommand([flow], baseOptions());
    } finally {
      process.cwd = cwdSpy;
    }

    expect(code).toBe(0);
    expect(fixture.count()).toBe(before);
    await expect(access(join(workDir, ".klaus"))).rejects.toThrow();
    const report = readJson();
    expect(report).toMatchObject({ version: 1, dryRun: true, status: "ok" });
    expect(report.summary).toEqual({
      flows: 1,
      steps: 2,
      refused: 0,
      undetermined: 0,
      unresolved: 1,
      errors: 0,
    });
    const [login, me] = report.flows[0]?.steps ?? [];
    expect(login).toMatchObject({
      name: "login",
      kind: "http",
      unresolved: [],
      conditional: false,
      request: { method: "POST", url: `${fixture.baseUrl}/login`, body: '{"user":"a"}' },
      guard: { status: "allowed" },
    });
    expect(me).toMatchObject({
      unresolved: ["token"],
      conditional: true,
      if: 'steps.login.status == "passed"',
      request: { headers: { Authorization: "Bearer {{token}}" } },
    });
  });

  it("guard.allowedHosts に無いホストのステップがあれば exit 3、guard.status は refused", async () => {
    const flow = await writeFlow("chain.yaml", CHAIN_FLOW(fixture.baseUrl));

    const code = await runCommand(
      [flow],
      baseOptions({ guard: { allowedHosts: ["api.example.com"] } }),
    );

    expect(code).toBe(3);
    const report = readJson();
    expect(report.status).toBe("error");
    expect(report.summary.refused).toBe(2);
    expect(report.flows[0]?.steps[0]?.guard.status).toBe("refused");
    expect(report.flows[0]?.steps[0]?.guard.reason).toContain("guard.allowedHosts");
    expect(fixture.count()).toBe(0);
  });

  it("実行時にも失敗する展開エラー(前段の capture でない未解決変数)があれば exit 3", async () => {
    const flow = await writeFlow(
      "missing.yaml",
      `name: missing\nsteps:\n  - name: s\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/{{nope}}"\n`,
    );

    const code = await runCommand([flow], baseOptions());

    expect(code).toBe(3);
    const step = readJson().flows[0]?.steps[0];
    expect(step?.error).toContain('template variable "nope"');
    expect(step?.request).toBeUndefined();
  });

  it("--data / --tags / --jobs と併用でき、出力順は --jobs に関わらず行(外側) × フロー(内側)の入力順", async () => {
    const a = await writeFlow(
      "a.yaml",
      `name: a\ntags: [smoke]\nsteps:\n  - name: s\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/a/{{id}}"\n`,
    );
    const b = await writeFlow(
      "b.yaml",
      `name: b\ntags: [other]\nsteps:\n  - name: s\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/b/{{id}}"\n`,
    );
    const c = await writeFlow(
      "c.yaml",
      `name: c\ntags: [smoke]\nsteps:\n  - name: s\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/c/{{id}}"\n`,
    );
    const data = join(workDir, "rows.json");
    await writeFile(data, '[{"id":"1"},{"id":"2"}]', "utf-8");

    const code = await runCommand([a, b, c], baseOptions({ data, tags: ["smoke"], jobs: 4 }));

    expect(code).toBe(0);
    const urls = readJson().flows.map(
      (f) => `${f.name}#${f.iteration}:${f.steps[0]?.request?.url.replace(fixture.baseUrl, "")}`,
    );
    expect(urls).toEqual(["a#1:/a/1", "c#1:/c/1", "a#2:/a/2", "c#2:/c/2"]);
  });

  it("--record / --replay / --report との併用は引数エラー(exit 2)で、何も出力しない", async () => {
    const flow = await writeFlow("chain.yaml", CHAIN_FLOW(fixture.baseUrl));
    const cassette = join(workDir, "cassette");

    const withRecord = await runCommand([flow], baseOptions({ record: cassette }));
    const withReplay = await runCommand([flow], baseOptions({ replay: cassette }));
    const withReport = await runCommand([flow], baseOptions({ report: "junit" }));

    expect([withRecord, withReplay, withReport]).toEqual([2, 2, 2]);
    expect(stdoutSpy.join("")).toBe("");
    expect(stderrSpy.join("")).toContain("--dry-run cannot be combined with --record or --replay");
    expect(stderrSpy.join("")).toContain("--dry-run cannot be combined with --report");
  });

  it("フロー定義のパースエラーは通常の run と同じく exit 2", async () => {
    const flow = await writeFlow("broken.yaml", "name: broken\nsteps: []\n");

    const code = await runCommand([flow], baseOptions());

    expect(code).toBe(2);
    expect(stderrSpy.join("")).toContain("parse error");
  });

  it("存在しない環境ファイルは exit 2", async () => {
    const flow = await writeFlow("chain.yaml", CHAIN_FLOW(fixture.baseUrl));

    const code = await runCommand([flow], baseOptions({ envFile: join(workDir, "none.yaml") }));

    expect(code).toBe(2);
    expect(stderrSpy.join("")).toContain("parse error");
  });

  it("{{env.X}} のシークレットは既定でマスクされ、mask: false では生の値が出る", async () => {
    process.env.KLAUS_DRYRUN_CLI_SECRET = "dry-cli-secret-9876";
    try {
      const flow = await writeFlow(
        "sec.yaml",
        `name: sec\nsteps:\n  - name: s\n    request:\n      method: GET\n      url: "${fixture.baseUrl}/x"\n      headers: { X-Key: "{{env.KLAUS_DRYRUN_CLI_SECRET}}" }\n`,
      );

      await runCommand([flow], baseOptions());
      expect(stdoutSpy.join("")).not.toContain("dry-cli-secret-9876");
      expect(readJson().flows[0]?.steps[0]?.request?.headers["X-Key"]).toBe("***");

      stdoutSpy.length = 0;
      await runCommand([flow], baseOptions({ mask: false }));
      expect(readJson().flows[0]?.steps[0]?.request?.headers["X-Key"]).toBe("dry-cli-secret-9876");
    } finally {
      delete process.env.KLAUS_DRYRUN_CLI_SECRET;
    }
  });

  it("展開後のボディは切り詰めない(dry-run は履歴から全文を引けないため)", async () => {
    const flow = await writeFlow(
      "big.yaml",
      `name: big\nsteps:\n  - name: s\n    request:\n      method: POST\n      url: "${fixture.baseUrl}/x"\n      body: "${"y".repeat(1200)}"\n`,
    );

    await runCommand([flow], baseOptions());

    expect(readJson().flows[0]?.steps[0]?.request?.body).toHaveLength(1200);
  });

  it("--text では各ステップの展開後リクエスト・unresolved・conditional・guard とサマリーを出す", async () => {
    const flow = await writeFlow("chain.yaml", CHAIN_FLOW(fixture.baseUrl));

    const code = await runCommand(
      [flow],
      baseOptions({ text: true, guard: { allowedHosts: ["api.example.com"] } }),
    );

    expect(code).toBe(3);
    const out = stdoutSpy.join("");
    expect(out).toContain(`  login: POST ${fixture.baseUrl}/login`);
    expect(out).toContain("    > Authorization: Bearer {{token}}");
    expect(out).toContain("    unresolved: token (depends on an earlier capture)");
    expect(out).toContain('    conditional: if steps.login.status == "passed"');
    expect(out).toContain("    guard: REFUSED - host");
    expect(out).toContain("dry run (nothing was sent): 1 flow, 2 steps: 2 refused");
  });
});
