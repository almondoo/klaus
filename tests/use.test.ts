import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ParseError } from "../src/core/errors.js";
import { loadFlow, validateFlowFile } from "../src/core/loader.js";
import { runFlow } from "../src/core/runner.js";
import { closeServer, listenEphemeral } from "./support/net.js";

/**
 * ステップ参照(use:)の単体テスト・統合テスト。
 * 対象は src/core/schema.ts の use 排他検証と、src/core/loader.ts の materializeFlow/resolveUseStep/mergeAssert。
 */

const tmpRoot = join(process.cwd(), "tmp");

describe("use: ステップ参照", () => {
  let dir: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-use-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** dir 基準の相対パスに YAML を書き込み、絶対パスを返す */
  async function writeYaml(relPath: string, content: string): Promise<string> {
    const filePath = join(dir, relPath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  it("参照先の request/assert を取り込み、name/capture は呼び出し側のまま、env は取り込まない", async () => {
    await writeYaml(
      "api/login.yaml",
      `
name: login check
env: should-not-leak
steps:
  - name: login-check
    request:
      method: POST
      url: "https://example.com/login"
    assert:
      status: 200
      body:
        - path: "$.token"
          exists: true
`,
    );
    const callerPath = await writeYaml(
      "flows/auth.yaml",
      `
name: auth flow
steps:
  - name: login
    use: ../api/login.yaml
    capture:
      token: "$.token"
`,
    );

    const flow = await loadFlow(callerPath);
    expect(flow.env).toBeUndefined();
    expect(flow.steps).toHaveLength(1);
    const step = flow.steps[0];
    expect(step?.name).toBe("login");
    expect(step?.use).toBeUndefined();
    expect(step?.request).toEqual({
      method: "POST",
      url: "https://example.com/login",
      timeoutMs: 30000,
    });
    expect(step?.capture).toEqual({ token: "$.token" });
    expect(step?.assert).toEqual({ status: 200, body: [{ path: "$.token", exists: true }] });
  });

  it("呼び出し側の assert は参照先の assert に加算マージされる(配列は参照先→呼び出し側の順に連結)", async () => {
    await writeYaml(
      "api/ep.yaml",
      `
name: ep check
steps:
  - name: check
    request:
      method: GET
      url: "https://example.com/ep"
    assert:
      status: 200
      body:
        - path: "$.a"
          exists: true
`,
    );
    const callerPath = await writeYaml(
      "flows/f.yaml",
      `
name: f
steps:
  - name: step1
    use: ../api/ep.yaml
    assert:
      body:
        - path: "$.b"
          exists: true
`,
    );

    const flow = await loadFlow(callerPath);
    expect(flow.steps[0]?.assert).toEqual({
      status: 200,
      body: [
        { path: "$.a", exists: true },
        { path: "$.b", exists: true },
      ],
    });
  });

  it("assert のスカラーフィールドが両方で定義されていると FlowIssue になる(保証を弱める置換を拒否)", async () => {
    await writeYaml(
      "api/ep.yaml",
      `
name: ep
steps:
  - name: check
    request:
      method: GET
      url: "https://example.com/ep"
    assert:
      status: 200
`,
    );
    const callerPath = await writeYaml(
      "flows/f.yaml",
      `
name: f
steps:
  - name: step1
    use: ../api/ep.yaml
    assert:
      status: 201
`,
    );

    const result = await validateFlowFile(callerPath);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("steps.0.assert");
    expect(result.errors[0]?.message).toContain("status");
  });

  it("参照切れは hint 付き FlowIssue になる", async () => {
    const callerPath = await writeYaml(
      "flows/f.yaml",
      `
name: f
steps:
  - name: step1
    use: ../api/missing.yaml
`,
    );

    const result = await validateFlowFile(callerPath);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.path).toBe("steps.0.use");
    expect(result.errors[0]?.message).toContain("not found");
    expect(result.errors[0]?.hint).toBeDefined();
  });

  it("複数ステップの参照先は hint 付き FlowIssue になる", async () => {
    await writeYaml(
      "api/multi.yaml",
      `
name: multi
steps:
  - name: a
    request:
      method: GET
      url: "https://example.com/a"
  - name: b
    request:
      method: GET
      url: "https://example.com/b"
`,
    );
    const callerPath = await writeYaml(
      "flows/f.yaml",
      `
name: f
steps:
  - name: step1
    use: ../api/multi.yaml
`,
    );

    const result = await validateFlowFile(callerPath);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.message).toContain("exactly one step");
    expect(result.errors[0]?.hint).toBeDefined();
  });

  it("循環参照は hint 付き FlowIssue になる", async () => {
    await writeYaml(
      "api/a.yaml",
      `
name: a
steps:
  - name: step-a
    use: ./b.yaml
`,
    );
    const bPath = await writeYaml(
      "api/b.yaml",
      `
name: b
steps:
  - name: step-b
    use: ./a.yaml
`,
    );

    const result = await validateFlowFile(bPath);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.message).toContain("circular");
    expect(result.errors[0]?.hint).toBeDefined();
  });

  it("assert のスカラーフィールド(bodyText/duration/eventCount/messageCount/bodySchema)が両方で定義されていると全て conflicts に含まれる", async () => {
    await writeYaml(
      "api/ep.yaml",
      `
name: ep
steps:
  - name: check
    request:
      method: GET
      url: "https://example.com/ep"
    assert:
      bodyText:
        equals: referenced-text
      duration:
        maxMs: 1000
      eventCount:
        min: 1
      messageCount:
        min: 1
      bodySchema:
        type: object
`,
    );
    const callerPath = await writeYaml(
      "flows/f.yaml",
      `
name: f
steps:
  - name: step1
    use: ../api/ep.yaml
    assert:
      bodyText:
        equals: caller-text
      duration:
        maxMs: 2000
      eventCount:
        min: 2
      messageCount:
        min: 2
      bodySchema:
        type: array
`,
    );

    const result = await validateFlowFile(callerPath);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toHaveLength(1);
    const message = result.errors[0]?.message ?? "";
    expect(message).toContain("bodyText");
    expect(message).toContain("duration");
    expect(message).toContain("eventCount");
    expect(message).toContain("messageCount");
    expect(message).toContain("bodySchema");
  });

  it("参照先ファイルの YAML が不正な場合、use ステップは hint なしの FlowIssue で拒否される", async () => {
    await writeYaml("api/broken.yaml", "name: broken\nsteps: [\n");
    const callerPath = await writeYaml(
      "flows/f.yaml",
      `
name: f
steps:
  - name: step1
    use: ../api/broken.yaml
`,
    );

    const result = await validateFlowFile(callerPath);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.path).toBe("steps.0.use");
    expect(result.errors[0]?.message).toContain("step.use target is invalid");
    expect(result.errors[0]?.hint).toBeUndefined();
  });

  it("参照先が ws ステップの場合は hint なしで拒否される(v1 は HTTP request ステップのみ対応)", async () => {
    await writeYaml(
      "api/ws-ep.yaml",
      `
name: ws ep
steps:
  - name: connect
    ws:
      url: "wss://example.com/socket"
`,
    );
    const callerPath = await writeYaml(
      "flows/f.yaml",
      `
name: f
steps:
  - name: step1
    use: ../api/ws-ep.yaml
`,
    );

    const result = await validateFlowFile(callerPath);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.message).toContain("ws steps are not supported");
  });

  it("絶対パスは hint 付き FlowIssue で拒否される", async () => {
    const callerPath = await writeYaml(
      "flows/f.yaml",
      `
name: f
steps:
  - name: step1
    use: "/etc/passwd.yaml"
`,
    );

    const result = await validateFlowFile(callerPath);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.message).toContain("absolute path");
    expect(result.errors[0]?.hint).toBeDefined();
  });

  it("process.cwd() の外を指す参照は hint 付き FlowIssue で拒否される", async () => {
    // dir(tmp/klaus-use-xxxx)/flows から4段上がるとリポジトリルート(process.cwd())の外に出る
    const callerPath = await writeYaml(
      "flows/f.yaml",
      `
name: f
steps:
  - name: step1
    use: ../../../../outside.yaml
`,
    );

    const result = await validateFlowFile(callerPath);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.message).toContain("outside the project directory");
    expect(result.errors[0]?.hint).toBeDefined();
  });

  it("スカラー競合は loadFlow では ParseError になる(validateFlowFile と同じ判定を共有する)", async () => {
    await writeYaml(
      "api/ep.yaml",
      `
name: ep
steps:
  - name: check
    request:
      method: GET
      url: "https://example.com/ep"
    assert:
      status: 200
`,
    );
    const callerPath = await writeYaml(
      "flows/f.yaml",
      `
name: f
steps:
  - name: step1
    use: ../api/ep.yaml
    assert:
      status: 201
`,
    );

    await expect(loadFlow(callerPath)).rejects.toThrow(ParseError);
  });

  it("参照先の sse ブロックが materialize 後のステップに取り込まれる", async () => {
    await writeYaml(
      "api/stream.yaml",
      `
name: stream check
steps:
  - name: check
    request:
      method: GET
      url: "https://example.com/stream"
    sse:
      maxEvents: 5
      maxDurationMs: 2000
`,
    );
    const callerPath = await writeYaml(
      "flows/f.yaml",
      `
name: f
steps:
  - name: step1
    use: ../api/stream.yaml
`,
    );

    const flow = await loadFlow(callerPath);
    expect(flow.steps[0]?.sse).toEqual({ maxEvents: 5, maxDurationMs: 2000 });
  });

  it("use: が自分自身のファイルを指す直接自己参照は循環として検出される", async () => {
    const selfPath = await writeYaml(
      "api/self.yaml",
      `
name: self
steps:
  - name: step1
    use: ./self.yaml
`,
    );

    const result = await validateFlowFile(selfPath);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.path).toBe("steps.0.use");
    expect(result.errors[0]?.message).toContain("circular");
    expect(result.errors[0]?.hint).toBeDefined();
  });

  it("入れ子 use チェーンの奥で起きたエラーはエントリファイル基準の issuePath と、実際に問題が起きたファイルパスを含む message になる", async () => {
    // c.yaml: 単体で完結する参照先
    await writeYaml(
      "api/c.yaml",
      `
name: c
steps:
  - name: check
    request:
      method: GET
      url: "https://example.com/c"
    assert:
      status: 200
`,
    );
    // b.yaml: c.yaml を参照しつつ、自身も status を指定してスカラー競合を起こす
    const bPath = await writeYaml(
      "api/b.yaml",
      `
name: b
steps:
  - name: step-b
    use: ./c.yaml
    assert:
      status: 201
`,
    );
    // a.yaml: steps[1] が b.yaml を参照する(competing assert は b/c 間)
    const aPath = await writeYaml(
      "flows/a.yaml",
      `
name: a
steps:
  - name: step0
    request:
      method: GET
      url: "https://example.com/step0"
  - name: step1
    use: ../api/b.yaml
`,
    );

    const result = await validateFlowFile(aPath);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toBe("steps.1.use");
    expect(result.errors[0]?.message).toContain("status");
    expect(result.errors[0]?.message).toContain(bPath.replace(`${process.cwd()}/`, ""));
  });

  it("参照先ファイル自体は従来どおり単体で読み込める(use を使わない普通のフロー)", async () => {
    const targetPath = await writeYaml(
      "api/ep.yaml",
      `
name: ep check
steps:
  - name: check
    request:
      method: GET
      url: "https://example.com/ep"
    assert:
      status: 200
`,
    );

    const flow = await loadFlow(targetPath);
    expect(flow.name).toBe("ep check");
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0]?.request?.url).toBe("https://example.com/ep");
  });

  describe("use: シンボリックリンク境界(isRealPathWithinDir)", () => {
    let outsideDir: string;

    beforeEach(async () => {
      outsideDir = await mkdtemp(join(tmpRoot, "klaus-use-symlink-outside-"));
    });

    afterEach(async () => {
      await rm(outsideDir, { recursive: true, force: true });
    });

    it("プロジェクト配下のシンボリックリンクが cwd の外を指す場合は hint 付き FlowIssue で拒否する(readFile が追随する前に検知する)", async () => {
      await writeFile(
        join(outsideDir, "outside.yaml"),
        `
name: outside
steps:
  - name: check
    request:
      method: GET
      url: "https://example.com/outside"
`,
        "utf-8",
      );
      await mkdir(join(dir, "api"), { recursive: true });
      await symlink(join(outsideDir, "outside.yaml"), join(dir, "api", "linked.yaml"));
      const callerPath = await writeYaml(
        "flows/f.yaml",
        `
name: f
steps:
  - name: step1
    use: ../api/linked.yaml
`,
      );

      // resolveUseStep の境界は process.cwd() 基準のため、テストの隔離のため
      // process.cwd() を一時的にこの fixture の dir へ差し替える(tests/cli/run.test.ts と同じ作法)
      const cwdSpy = process.cwd;
      process.cwd = () => dir;
      try {
        const result = await validateFlowFile(callerPath);
        expect(result.valid).toBe(false);
        if (result.valid) return;
        expect(result.errors[0]?.message).toContain("outside the project directory");
        expect(result.errors[0]?.hint).toBeDefined();
      } finally {
        process.cwd = cwdSpy;
      }
    });

    it("プロジェクト配下の通常ファイル(シンボリックリンクでない)は従来どおり use: で解決される", async () => {
      await writeYaml(
        "api/ep.yaml",
        `
name: ep
steps:
  - name: check
    request:
      method: GET
      url: "https://example.com/ep"
`,
      );
      const callerPath = await writeYaml(
        "flows/f.yaml",
        `
name: f
steps:
  - name: step1
    use: ../api/ep.yaml
`,
      );

      const cwdSpy = process.cwd;
      process.cwd = () => dir;
      try {
        const flow = await loadFlow(callerPath);
        expect(flow.steps[0]?.request?.url).toBe("https://example.com/ep");
      } finally {
        process.cwd = cwdSpy;
      }
    });

    it("cwd 自身がシンボリックリンク経由で到達される場合でも誤って拒否しない(境界ディレクトリの realpath 解決)", async () => {
      await writeYaml(
        "api/ep.yaml",
        `
name: ep
steps:
  - name: check
    request:
      method: GET
      url: "https://example.com/ep"
`,
      );
      await writeYaml(
        "flows/f.yaml",
        `
name: f
steps:
  - name: step1
    use: ../api/ep.yaml
`,
      );
      // dir 自体をシンボリックリンク経由(linkedDir)で参照し、process.cwd() をそちらに差し替える
      const linkedDir = join(tmpRoot, `klaus-use-symlink-link-${process.pid}-${Date.now()}`);
      await symlink(dir, linkedDir, "dir");
      const linkedCallerPath = join(linkedDir, "flows", "f.yaml");

      const cwdSpy = process.cwd;
      process.cwd = () => linkedDir;
      try {
        const flow = await loadFlow(linkedCallerPath);
        expect(flow.steps[0]?.request?.url).toBe("https://example.com/ep");
      } finally {
        process.cwd = cwdSpy;
        await rm(linkedDir, { force: true });
      }
    });
  });
});

describe("use: 統合実行(examples/ の api/ + flows/ 構成を模した fixture サーバーでの実行)", () => {
  const tmpRoot2 = join(process.cwd(), "tmp");
  let dir: string;
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/login" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token: "tok-123" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    ({ baseUrl } = await listenEphemeral(server));
  });

  afterAll(async () => {
    await closeServer(server);
  });

  beforeEach(async () => {
    await mkdir(tmpRoot2, { recursive: true });
    dir = await mkdtemp(join(tmpRoot2, "klaus-use-integration-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("flows/ から use: で api/ の1ステップフローを参照し、runFlow で実行できる", async () => {
    const apiPath = join(dir, "api", "login-check.yaml");
    await mkdir(dirname(apiPath), { recursive: true });
    await writeFile(
      apiPath,
      `
name: ログイン API 単体チェック
steps:
  - name: login
    request:
      method: POST
      url: "${baseUrl}/login"
    assert:
      status: 200
      body:
        - path: "$.token"
          exists: true
`,
      "utf-8",
    );

    const flowPath = join(dir, "flows", "auth-flow.yaml");
    await mkdir(dirname(flowPath), { recursive: true });
    await writeFile(
      flowPath,
      `
name: 認証フロー
steps:
  - name: login
    use: ../api/login-check.yaml
    capture:
      token: "$.token"
`,
      "utf-8",
    );

    const result = await runFlow(flowPath, { cwd: dir, history: false });

    expect(result.status).toBe("passed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.name).toBe("login");
    expect(result.steps[0]?.status).toBe("passed");
    expect(result.steps[0]?.response?.body).toEqual({ token: "tok-123" });
  });
});
