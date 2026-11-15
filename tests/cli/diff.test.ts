import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DiffCommandOptions, diffCommand, registerDiffCommand } from "../../src/cli/diff.js";

const tmpRoot = join(__dirname, "..", "..", "tmp");

// biome-ignore lint/suspicious/noExplicitAny: テストでは JSON の形を緩く参照するため any を使う
type Loose = any;

function line(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    v: 1,
    flow: "api",
    durationMs: 5,
    status: "passed",
    request: { method: "GET", url: "http://h/items", headers: {} },
    response: { status: 200, headers: { date: "d" }, body: { id: 1, name: "a", token: "***" } },
    assertions: [],
    ...overrides,
  });
}

describe("klaus diff", () => {
  let workDir: string;
  let out: string[];
  let err: string[];
  let stdoutWrite: typeof process.stdout.write;
  let stderrWrite: typeof process.stderr.write;
  let isTty: boolean | undefined;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    workDir = await mkdtemp(join(tmpRoot, "klaus-diff-cli-"));
    await mkdir(join(workDir, ".klaus", "history"), { recursive: true });
    const lines = [
      // run-1 と run-2 は flow "api"、run-3 は別フロー
      line({ runId: "run-1", step: "list", startedAt: "2026-11-15T00:00:01.000Z" }),
      line({
        runId: "run-1",
        step: "create",
        startedAt: "2026-11-15T00:00:02.000Z",
        request: { method: "POST", url: "http://h/items", headers: {}, body: { n: 1 } },
        env: "local",
        actor: { kind: "agent" },
      }),
      line({
        runId: "run-2",
        step: "list",
        startedAt: "2026-11-15T01:00:01.000Z",
        response: {
          status: 200,
          headers: { date: "d2" },
          body: { id: 2, name: "b", token: "***" },
        },
      }),
      line({
        runId: "run-2",
        step: "create",
        startedAt: "2026-11-15T01:00:02.000Z",
        request: { method: "POST", url: "http://h/items", headers: {}, body: { n: 1 } },
        env: "local",
        actor: { kind: "agent" },
      }),
      line({ runId: "run-3", flow: "other", step: "s", startedAt: "2026-11-15T02:00:00.000Z" }),
      line({ runId: "run-4", step: "list", startedAt: "2026-11-15T03:00:01.000Z" }),
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

  it("差分がなければ exit 0 と status: same(非 TTY の既定は JSON)", async () => {
    const code = await diffCommand(["run-1", "run-1"], {}, workDir);
    expect(code).toBe(0);
    const report = json();
    expect(report).toMatchObject({ version: 1, status: "same", counts: { same: 2 } });
    expect(report.runs.a).toMatchObject({ runId: "run-1", env: "local", actor: { kind: "agent" } });
  });

  it("差分があれば exit 4 で、値の変更とマスク値の同値扱い・既定の除外ヘッダーが反映される", async () => {
    const code = await diffCommand(["run-1", "run-2"], {}, workDir);
    expect(code).toBe(4);
    const report = json();
    expect(report.status).toBe("different");
    expect(report.counts).toEqual({ same: 1, different: 1, added: 0, removed: 0 });
    const list = report.steps.find((s: Loose) => s.step === "list");
    // date ヘッダーは既定で除外され、token(***)は同値、id と name だけが差分
    expect(list.responseHeaders).toBeUndefined();
    expect(list.body.differences.map((d: Loose) => d.path)).toEqual(["$.id", "$.name"]);
  });

  it("--ignore-path / --ignore-header / --no-default-ignores / --max-differences / --max-value-length を反映する", async () => {
    expect(await diffCommand(["run-1", "run-2"], { ignorePath: ["$.id", "$.name"] }, workDir)).toBe(
      0,
    );

    out.length = 0;
    await diffCommand(
      ["run-1", "run-2"],
      { defaultIgnores: false, ignorePath: ["$.id", "$.name"] },
      workDir,
    );
    expect(json().steps.find((s: Loose) => s.step === "list").responseHeaders.changed).toEqual({
      date: { a: "d", b: "d2" },
    });

    out.length = 0;
    expect(
      await diffCommand(
        ["run-1", "run-2"],
        { defaultIgnores: false, ignoreHeader: ["DATE"], ignorePath: ["$.id", "$.name"] },
        workDir,
      ),
    ).toBe(0);

    out.length = 0;
    await diffCommand(["run-1", "run-2"], { maxDifferences: 1, maxValueLength: 1 }, workDir);
    const body = json().steps.find((s: Loose) => s.step === "list").body;
    expect(body).toMatchObject({ total: 2, omitted: 1 });
  });

  it("latest / previous は --flow で解決し、引数なしの --flow は previous と latest を比較する", async () => {
    expect(await diffCommand(["previous", "latest"], { flow: "api" }, workDir)).toBe(4);
    expect(json().runs).toMatchObject({ a: { runId: "run-2" }, b: { runId: "run-4" } });

    out.length = 0;
    expect(await diffCommand([], { flow: "api" }, workDir)).toBe(4);
    expect(json().runs).toMatchObject({ a: { runId: "run-2" }, b: { runId: "run-4" } });
  });

  it("--flow 指定時はそのフローのステップだけを比較し、片側にだけあるステップは added / removed になる", async () => {
    expect(await diffCommand(["run-1", "run-3"], { flow: "api" }, workDir)).toBe(1);
    expect(err.join("")).toContain('run "run-3" has no entries for flow "api"');

    out.length = 0;
    await diffCommand(["run-1", "run-4"], {}, workDir);
    expect(json().counts).toMatchObject({ removed: 1 });
  });

  it("--text は差分のあるステップだけを人間向けに出力する", async () => {
    const code = await diffCommand(["run-1", "run-2"], { text: true }, workDir);
    expect(code).toBe(4);
    const text = out.join("");
    expect(text).toContain("different: 1 of 2 step(s) differ");
    expect(text).toContain("~ api / list");
    expect(text).toContain("~ $.id: 1 -> 2");
    expect(text).not.toContain("api / create");
  });

  it("不明な run・引数不正は exit 1(klaus history show と同じ)で何も出力しない", async () => {
    expect(await diffCommand(["nope", "run-1"], {}, workDir)).toBe(1);
    expect(err.join("")).toContain('no history entries found for runId "nope"');
    const invalid: Array<[string[], DiffCommandOptions]> = [
      [["run-1"], {}],
      [[], {}],
      [["latest", "previous"], {}],
      [["run-1", "run-2"], { json: true, text: true }],
      [["run-1", "run-2"], { ignorePath: ["data.id"] }],
      [["run-1", "run-2"], { ignorePath: ["$..a..b..c"] }],
      [["previous", "latest"], { flow: "other" }],
    ];
    for (const [refs, options] of invalid) {
      expect(await diffCommand(refs, options, workDir)).toBe(1);
    }
    expect(out.join("")).toBe("");
  });

  it("同一ミリ秒に開始したステップも追記順で突き合わせ、深く入れ子になった body でも exit 1 にならない", async () => {
    const at = "2026-11-16T00:00:00.000Z";
    // JSON.stringify では深さ 20000 を作れないため、本文の JSON 文字列を直接組み立てる
    const deepJson = (n: number, leaf: number): string =>
      `${'{"a":'.repeat(n)}{"leaf":${leaf}}${"}".repeat(n)}`;
    const mk = (runId: string, leaf: number) =>
      ["one", "two"].map((step) =>
        line({
          runId,
          step,
          flow: "ties",
          startedAt: at,
          response: { status: 200, headers: {}, body: step === "two" ? "__DEEP__" : { k: 1 } },
        }).replace('"__DEEP__"', deepJson(20000, leaf)),
      );
    await writeFile(
      join(workDir, ".klaus", "history", "2026-11-16.jsonl"),
      `${[...mk("t-1", 1), ...mk("t-2", 2)].join("\n")}\n`,
      "utf-8",
    );
    expect(await diffCommand(["t-1", "t-2"], {}, workDir)).toBe(4);
    const report = json();
    expect(report.steps.map((s: Loose) => [s.step, s.change])).toEqual([
      ["one", "same"],
      ["two", "different"],
    ]);
    expect(report.steps[1].body.differences[0].kind).toBe("too-deep");

    out.length = 0;
    expect(await diffCommand(["t-1", "t-2"], { text: true }, workDir)).toBe(4);
    expect(out.join("")).toContain("too deep to compare");
  });

  it("registerDiffCommand: commander の引数・オプション(--no-default-ignores 等)が diffCommand に渡る", async () => {
    const program = new Command().exitOverride();
    registerDiffCommand(program);
    const original = process.cwd();
    process.chdir(workDir);
    try {
      await program.parseAsync(
        [
          "diff",
          "run-1",
          "run-2",
          "--no-default-ignores",
          "--ignore-path",
          "$.id",
          "--ignore-path",
          "$.name",
        ],
        { from: "user" },
      );
      expect(process.exitCode).toBe(4);
      expect(json().steps.find((s: Loose) => s.step === "list").responseHeaders.changed).toEqual({
        date: { a: "d", b: "d2" },
      });
    } finally {
      process.chdir(original);
      process.exitCode = undefined;
    }
  });
});
