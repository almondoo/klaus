import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promoteCommand, registerPromoteCommand } from "../../src/cli/promote.js";
import { validateFlowFile } from "../../src/core/loader.js";
import { runFlows } from "../../src/core/runner.js";

const tmpRoot = join(__dirname, "..", "..", "tmp");

// biome-ignore lint/suspicious/noExplicitAny: テストでは JSON の形を緩く参照するため any を使う
type Loose = any;

function line(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    v: 1,
    flow: "login flow",
    durationMs: 5,
    status: "passed",
    assertions: [],
    ...overrides,
  });
}

describe("klaus promote", () => {
  let workDir: string;
  let out: string[];
  let err: string[];
  let stdoutWrite: typeof process.stdout.write;
  let stderrWrite: typeof process.stderr.write;
  let isTty: boolean | undefined;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    workDir = await mkdtemp(join(tmpRoot, "klaus-promote-cli-"));
    await mkdir(join(workDir, ".klaus", "history"), { recursive: true });
    const lines = [
      line({
        runId: "run-1",
        step: "login",
        startedAt: "2026-11-15T00:00:01.000Z",
        request: {
          method: "POST",
          url: "http://127.0.0.1:4000/login",
          headers: { authorization: "Basic ***" },
          body: { user: "alice" },
        },
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { token: "tok-1234567890abcdef", role: "admin" },
        },
      }),
      line({
        runId: "run-1",
        step: "me",
        startedAt: "2026-11-15T00:00:02.000Z",
        request: {
          method: "GET",
          url: "http://127.0.0.1:4000/me",
          headers: { authorization: "Bearer tok-1234567890abcdef" },
        },
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { name: "alice" },
        },
      }),
      line({
        runId: "run-2",
        flow: "(single)",
        step: "request",
        source: "single",
        startedAt: "2026-11-15T01:00:00.000Z",
        request: { method: "GET", url: "http://127.0.0.1:4000/health", headers: {} },
        response: { status: 200, headers: {}, body: { ok: true } },
      }),
      line({
        runId: "run-3",
        flow: "a",
        step: "s",
        startedAt: "2026-11-15T02:00:00.000Z",
        request: { method: "GET", url: "http://h/", headers: {} },
        response: { status: 200, headers: {}, body: 1 },
      }),
      line({
        runId: "run-3",
        flow: "b",
        step: "s",
        startedAt: "2026-11-15T02:00:01.000Z",
        request: { method: "GET", url: "http://h/", headers: {} },
        response: { status: 200, headers: {}, body: 1 },
      }),
    ];
    await writeFile(
      join(workDir, ".klaus", "history", "2026-11-15.jsonl"),
      `${lines.join("\n")}\n`,
      "utf-8",
    );

    out = [];
    err = [];
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    isTty = process.stdout.isTTY;
    process.stdout.isTTY = undefined as unknown as true;
    process.stdout.write = ((chunk: string) => {
      out.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      err.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.stdout.isTTY = isTty as true;
    await rm(workDir, { recursive: true, force: true });
  });

  const json = () => JSON.parse(out.join("")) as Loose;

  it("複数ステップの run を flows/ に書き込み、validateFlowFile を通り、JSON サマリーを出す", async () => {
    const code = await promoteCommand(["run-1"], {}, workDir);
    expect(code).toBe(0);

    const report = json();
    expect(report).toMatchObject({
      version: 1,
      status: "ok",
      written: true,
      file: "flows/login-flow.yaml",
      flow: "login flow",
      assert: "schema",
      placeholders: [{ name: "TODO_AUTHORIZATION" }],
      captures: [{ name: "token", from: { step: "login", path: "$.token" } }],
      skipped: [],
    });
    expect(report.steps.map((s: Loose) => s.name)).toEqual(["login", "me"]);

    const file = join(workDir, "flows", "login-flow.yaml");
    const yaml = await readFile(file, "utf-8");
    expect(yaml).not.toContain("***");
    expect(yaml).toContain("authorization: Basic {{env.TODO_AUTHORIZATION}}");
    expect((await validateFlowFile(file)).valid).toBe(true);
  });

  it("単一ステップは api/ に書き、--out と --base-url-var を反映し、text 出力に埋めるべき値を示す", async () => {
    const code = await promoteCommand(
      ["run-2"],
      { out: "checks/health.yaml", baseUrlVar: "baseUrl", text: true },
      workDir,
    );
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("wrote checks/health.yaml");
    expect(text).toContain("baseUrl: http://127.0.0.1:4000");
    expect(text).toContain("run it with: klaus run checks/health.yaml");
    expect(await readFile(join(workDir, "checks", "health.yaml"), "utf-8")).toContain(
      'url: "{{baseUrl}}/health"',
    );

    out.length = 0;
    await promoteCommand(["run-2"], { json: true }, workDir);
    expect(json().file).toBe("api/promoted-127-0-0-1.yaml");
  });

  it("既存ファイルは --force なしでは上書きせず exit 2、--force なら上書きする", async () => {
    const target = join(workDir, "flows", "login-flow.yaml");
    await mkdir(join(workDir, "flows"), { recursive: true });
    await writeFile(target, "keep", "utf-8");

    expect(await promoteCommand(["run-1"], {}, workDir)).toBe(2);
    expect(err.join("")).toContain(
      '"flows/login-flow.yaml" already exists (use --force to overwrite)',
    );
    expect(await readFile(target, "utf-8")).toBe("keep");
    expect(out.join("")).toBe("");

    expect(await promoteCommand(["run-1"], { force: true }, workDir)).toBe(0);
    expect(await readFile(target, "utf-8")).toContain("name: login flow");
  });

  it("--stdout は YAML だけを stdout に出し(ファイルは書かない)、サマリーは stderr に出す", async () => {
    expect(await promoteCommand(["run-2"], { stdout: true }, workDir)).toBe(0);
    const yaml = out.join("");
    expect(yaml.startsWith("# yaml-language-server: $schema=")).toBe(true);
    expect(yaml).toContain("name: promoted 127.0.0.1");
    expect(JSON.parse(err.join(""))).toMatchObject({ written: false });
    await expect(readFile(join(workDir, "api"), "utf-8")).rejects.toThrow();
  });

  it("cwd の外(.. やシンボリックリンク経由)への出力は exit 2 で拒否する", async () => {
    const outside = await mkdtemp(join(tmpRoot, "klaus-promote-outside-"));
    try {
      await symlink(outside, join(workDir, "link"));
      expect(await promoteCommand(["run-2"], { out: "../escape.yaml" }, workDir)).toBe(2);
      expect(await promoteCommand(["run-2"], { out: join(outside, "x.yaml") }, workDir)).toBe(2);
      expect(await promoteCommand(["run-2"], { out: "link/x.yaml" }, workDir)).toBe(2);
      expect(await promoteCommand(["run-2"], { out: "." }, workDir)).toBe(2);
      expect(err.join("")).toContain("resolves outside the current directory");
      await expect(readFile(join(outside, "x.yaml"), "utf-8")).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("不明な run・複数フローの run・引数不正は exit 1(klaus history show と同じ)", async () => {
    expect(await promoteCommand(["nope"], {}, workDir)).toBe(1);
    expect(err.join("")).toContain('no history entries found for runId "nope"');

    expect(await promoteCommand(["run-3"], {}, workDir)).toBe(1);
    expect(err.join("")).toContain("pick one with --flow <name>");
    expect(await promoteCommand(["run-3"], { flow: "b", stdout: true }, workDir)).toBe(0);

    for (const [ids, options] of [
      [[], {}],
      [["run-2"], { json: true, text: true }],
      [["run-2"], { stdout: true, out: "x.yaml" }],
      [["run-2"], { stdout: true, force: true }],
      [["run-2"], { assert: "everything" }],
      [["run-2"], { baseUrlVar: "base.url" }],
    ] as const) {
      expect(await promoteCommand([...ids], { ...options } as never, workDir)).toBe(1);
    }
  });

  it("--assert / --no-chain を反映する", async () => {
    await promoteCommand(["run-1"], { assert: "status", chain: false, stdout: true }, workDir);
    const yaml = out.join("");
    expect(yaml).not.toContain("bodySchema");
    expect(yaml).not.toContain("capture:");
    // 秘密情報を示すヘッダーなので、チェインしない場合もリテラルは残らない
    expect(yaml).toContain("authorization: Bearer {{env.TODO_AUTHORIZATION}}");
    expect(yaml).not.toContain("tok-1234567890abcdef");
  });

  it("同一ミリ秒に開始したステップの順序を履歴の行順で確定し、チェインが成立して平文トークンが残らない", async () => {
    const at = "2026-11-16T00:00:00.000Z";
    const token = "tok-aaaabbbbccccdddd";
    const rows = [
      line({
        runId: "tie-1",
        step: "login",
        startedAt: at,
        request: { method: "POST", url: "http://h/login", headers: {} },
        response: { status: 200, headers: {}, body: { token } },
      }),
      line({
        runId: "tie-1",
        step: "me",
        startedAt: at,
        request: { method: "GET", url: "http://h/me", headers: { "x-session": token } },
        response: { status: 200, headers: {}, body: { ok: true } },
      }),
    ];
    await writeFile(
      join(workDir, ".klaus", "history", "2026-11-16.jsonl"),
      `${rows.join("\n")}\n`,
      "utf-8",
    );
    expect(await promoteCommand(["tie-1"], { stdout: true }, workDir)).toBe(0);
    const yaml = out.join("");
    expect(yaml.indexOf("name: login")).toBeLessThan(yaml.indexOf("name: me"));
    expect(yaml).toMatch(/x-session: ["']\{\{token\}\}["']/);
    expect(yaml).not.toContain(token);
  });

  it("出力に NOTICE と、秘密情報らしい値の置き換え一覧(redacted)が含まれる", async () => {
    expect(await promoteCommand(["run-1"], { chain: false, json: true }, workDir)).toBe(0);
    const report = json();
    expect(report.notice).toContain("review this file for sensitive data");
    expect(report.redacted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "TODO_AUTHORIZATION", reason: "sensitive key" }),
      ]),
    );
    const yaml = await readFile(join(workDir, "flows", "login-flow.yaml"), "utf-8");
    expect(yaml).toContain("# NOTICE: Generated from recorded traffic");

    out.length = 0;
    await promoteCommand(["run-2"], { text: true, out: "t.yaml" }, workDir);
    expect(out.join("")).toContain("NOTICE: Generated from recorded traffic");
  });

  describe("出力先のシンボリックリンク", () => {
    let outside: string;

    beforeEach(async () => {
      outside = await mkdtemp(join(tmpRoot, "klaus-promote-outside-"));
    });

    afterEach(async () => {
      await rm(outside, { recursive: true, force: true });
    });

    const exists = async (path: string) =>
      stat(path).then(
        () => true,
        () => false,
      );

    it("cwd 外を指す宙づりのファイルリンクは --force の有無にかかわらず拒否し、外側にファイルを作らない", async () => {
      const escaped = join(outside, "new.yaml");
      await symlink(escaped, join(workDir, "dangling.yaml"));
      expect(await promoteCommand(["run-2"], { out: "dangling.yaml" }, workDir)).toBe(2);
      expect(await promoteCommand(["run-2"], { out: "dangling.yaml", force: true }, workDir)).toBe(
        2,
      );
      expect(err.join("")).toContain('"dangling.yaml" is a symbolic link');
      expect(await exists(escaped)).toBe(false);
    });

    it("cwd 外の既存ファイルを指すリンクは --force でも書き換えない", async () => {
      const victim = join(outside, "victim.yaml");
      await writeFile(victim, "keep", "utf-8");
      await symlink(victim, join(workDir, "to-victim.yaml"));
      expect(await promoteCommand(["run-2"], { out: "to-victim.yaml", force: true }, workDir)).toBe(
        2,
      );
      expect(await readFile(victim, "utf-8")).toBe("keep");
    });

    it("cwd 内の既存ファイルを指すリンクも最終要素なら拒否する(行き先は書き換えない)", async () => {
      await writeFile(join(workDir, "real.yaml"), "keep", "utf-8");
      await symlink(join(workDir, "real.yaml"), join(workDir, "inside.yaml"));
      expect(await promoteCommand(["run-2"], { out: "inside.yaml", force: true }, workDir)).toBe(2);
      expect(await readFile(join(workDir, "real.yaml"), "utf-8")).toBe("keep");
    });

    it("宙づりのディレクトリリンク(外向き・内向き)は exit 1 の未処理エラーではなく exit 2 で拒否する", async () => {
      await symlink(join(outside, "missing-dir"), join(workDir, "dir-out"));
      await symlink(join(workDir, "missing-inside"), join(workDir, "dir-in"));
      expect(await promoteCommand(["run-2"], { out: "dir-out/x.yaml" }, workDir)).toBe(2);
      expect(err.join("")).toContain('"dir-out" is a dangling symbolic link');
      expect(await promoteCommand(["run-2"], { out: "dir-in/x.yaml" }, workDir)).toBe(2);
      expect(await exists(join(outside, "missing-dir"))).toBe(false);
    });

    it("cwd 内の実在ディレクトリを指す途中のリンクは許可し、実体に書き込む", async () => {
      await mkdir(join(workDir, "real-dir"));
      await symlink(join(workDir, "real-dir"), join(workDir, "alias"));
      expect(await promoteCommand(["run-2"], { out: "alias/x.yaml" }, workDir)).toBe(0);
      expect(await readFile(join(workDir, "real-dir", "x.yaml"), "utf-8")).toContain("name:");
    });

    it("途中が通常ファイルの場合は exit 1 の未処理エラーではなく exit 2 で拒否する", async () => {
      await writeFile(join(workDir, "plain-file"), "x", "utf-8");
      expect(await promoteCommand(["run-2"], { out: "plain-file/x.yaml" }, workDir)).toBe(2);
    });
  });

  describe("記録値のテンプレート式(環境変数の流出経路)", () => {
    let server: Server;
    let received: Array<{ url: string; headers: Record<string, unknown>; body: string }>;
    let baseUrl: string;
    const canary = "canary-value-do-not-send";

    beforeEach(async () => {
      received = [];
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          received.push({ url: req.url ?? "", headers: req.headers, body });
          res.setHeader("content-type", "application/json");
          // 敵対的なサーバー: 応答に環境変数参照を仕込む
          res.end(JSON.stringify({ note: "{{env.KLAUS_CANARY}}", ok: true }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      process.env.KLAUS_CANARY = canary;
    });

    afterEach(async () => {
      // process.env への undefined 代入は文字列 "undefined" になるため delete で消す
      delete process.env.KLAUS_CANARY;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const everythingSent = () => JSON.stringify(received);

    it("応答の {{env.X}} が後続リクエストに入っても、既定では生成を拒否し(exit 2・ファイルなし)、カナリアはどこにも送られない", async () => {
      const flowPath = join(workDir, "explore.yaml");
      await writeFile(
        flowPath,
        [
          "name: exfil",
          "steps:",
          "  - name: first",
          "    request:",
          "      method: GET",
          '      url: "{{baseUrl}}/a"',
          "    capture:",
          '      note: "$.note"',
          "  - name: second",
          "    request:",
          "      method: POST",
          '      url: "{{baseUrl}}/b"',
          "      headers:",
          '        x-note: "{{note}}"',
          "      body:",
          '        text: "{{note}}"',
          "",
        ].join("\n"),
        "utf-8",
      );
      const run = await runFlows([flowPath], { cwd: workDir, variables: { baseUrl } });
      expect(run.status).toBe("passed");
      // 探索の実行自体では、取得した値は再展開されないのでカナリアは送られない
      expect(everythingSent()).not.toContain(canary);

      const code = await promoteCommand(
        [run.runId],
        { out: "flows/exfil.yaml", baseUrlVar: "baseUrl" },
        workDir,
      );
      expect(code).toBe(2);
      expect(err.join("")).toContain('step "second" header "x-note"');
      expect(err.join("")).toContain("--allow-template-literals");
      await expect(stat(join(workDir, "flows", "exfil.yaml"))).rejects.toThrow();
      expect(everythingSent()).not.toContain(canary);

      // 明示的な許可がある場合だけ出力される。チェインが効けば {{note}} になって流出しないが、
      // チェインしない(--no-chain)場合は記録値がそのまま残り、実行するとカナリアが実際に送られる
      // (だからこそ既定では拒否している)
      out.length = 0;
      err.length = 0;
      const allowed = await promoteCommand(
        [run.runId],
        { out: "flows/exfil.yaml", baseUrlVar: "baseUrl", allowTemplateLiterals: true, json: true },
        workDir,
      );
      expect(allowed).toBe(0);
      expect(json().templateLiterals).toEqual([
        { step: "second", location: 'header "x-note"' },
        { step: "second", location: "body $.text" },
      ]);
      expect(json().notes.join("\n")).toContain("WARNING:");
      const yaml = await readFile(join(workDir, "flows", "exfil.yaml"), "utf-8");
      expect(yaml).toContain("# WARNING: these recorded values contain a literal");
      received.length = 0;
      await runFlows([join(workDir, "flows", "exfil.yaml")], {
        cwd: workDir,
        variables: { baseUrl },
        history: false,
      });
      expect(everythingSent()).not.toContain(canary);

      out.length = 0;
      await promoteCommand(
        [run.runId],
        {
          out: "flows/exfil-literal.yaml",
          baseUrlVar: "baseUrl",
          allowTemplateLiterals: true,
          chain: false,
        },
        workDir,
      );
      received.length = 0;
      await runFlows([join(workDir, "flows", "exfil-literal.yaml")], {
        cwd: workDir,
        variables: { baseUrl },
        history: false,
      });
      expect(everythingSent()).toContain(canary);
    });
  });

  it("registerPromoteCommand: commander の引数・オプションが promoteCommand に渡り、--assert の既定は schema", async () => {
    const program = new Command().exitOverride();
    registerPromoteCommand(program);
    const original = process.cwd();
    process.chdir(workDir);
    try {
      await program.parseAsync(["promote", "run-2", "--no-chain", "--json", "--out", "x.yaml"], {
        from: "user",
      });
      expect(process.exitCode ?? 0).toBe(0);
      expect(json()).toMatchObject({ file: "x.yaml", assert: "schema" });
    } finally {
      process.chdir(original);
      process.exitCode = undefined;
    }
  });
});
