import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { snapshotAcceptCommand, snapshotListCommand } from "../../src/cli/snapshot.js";
import { runLoadedFlows } from "../../src/core/runner.js";
import { flowSchema } from "../../src/core/schema.js";
import { closeServer, listenEphemeral } from "../support/net.js";

const tmpRoot = join(__dirname, "..", "..", "tmp");

describe("snapshot list / accept", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let body: unknown = { name: "alice" };
  let cwd: string;
  let out: string[];
  let err: string[];
  let stdoutWrite: typeof process.stdout.write;
  let stderrWrite: typeof process.stderr.write;
  let isTty: boolean | undefined;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    ({ baseUrl } = await listenEphemeral(server));
    await mkdir(tmpRoot, { recursive: true });
  });
  afterAll(async () => {
    await closeServer(server);
  });
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-snapshot-cli-"));
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
    isTty = process.stdout.isTTY;
    process.stdout.isTTY = undefined as unknown as true;
    body = { name: "alice" };
  });
  afterEach(async () => {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.stdout.isTTY = isTty as true;
    await rm(cwd, { recursive: true, force: true });
  });

  const flow = flowSchema.parse;
  const twoSteps = () =>
    flow({
      name: "snap flow",
      steps: ["first", "second"].map((name) => ({
        name,
        request: { method: "GET", url: `${baseUrl}/${name}` },
        assert: { snapshot: true },
        continueOnError: true,
      })),
    });

  /** 基準を書いた後に応答を変えて実行し、2 ステップとも不一致の run を履歴に残す */
  async function recordMismatchedRun() {
    const entries = [{ filePath: "snap.yaml", flow: twoSteps() }];
    await runLoadedFlows(entries, { cwd, history: true, snapshots: { ci: false } });
    body = { name: "bob" };
    const result = await runLoadedFlows(entries, { cwd, history: true, snapshots: { ci: false } });
    expect(result.status).toBe("failed");
    return result.runId;
  }

  const snapshotFile = () => join(cwd, "__snapshots__", "snap.yaml.snap.json");

  it("list: 承認待ちを JSON で出し(候補は含めない)、--step で絞り込む。何も書かない", async () => {
    const runId = await recordMismatchedRun();
    const before = await readFile(snapshotFile(), "utf-8");

    expect(await snapshotListCommand(runId, { json: true }, cwd)).toBe(0);
    const report = JSON.parse(out.join(""));
    expect(report).toMatchObject({ version: 1, runId });
    expect(report.mismatches.map((m: { step: string }) => m.step)).toEqual(["first", "second"]);
    expect(report.mismatches[0]).toMatchObject({
      key: "first",
      state: "mismatch",
      snapshotFile: "__snapshots__/snap.yaml.snap.json",
      differences: [{ path: "$.body.name", before: "alice", after: "bob" }],
    });
    expect(JSON.stringify(report)).not.toContain("candidate");

    out.length = 0;
    expect(await snapshotListCommand(runId, { json: true, step: "second" }, cwd)).toBe(0);
    expect(JSON.parse(out.join("")).mismatches).toHaveLength(1);
    expect(await readFile(snapshotFile(), "utf-8")).toBe(before);
  });

  it("list: runId を省略すると、snapshot アサーションを含む最新の run を使う。text でも読める", async () => {
    const runId = await recordMismatchedRun();

    expect(await snapshotListCommand(undefined, { text: true }, cwd)).toBe(0);

    const text = out.join("");
    expect(text).toContain(`run ${runId}: 2 pending snapshot mismatches`);
    expect(text).toContain("MISMATCH first (__snapshots__/snap.yaml.snap.json)");
    expect(text).toContain('$.body.name "alice" -> "bob"');
  });

  it("list: 不明な run・snapshot の履歴が無い・--json と --text の併用は exit 1", async () => {
    expect(await snapshotListCommand(undefined, {}, cwd)).toBe(1);
    expect(err.join("")).toContain("no history entries with snapshot assertions");
    await recordMismatchedRun();
    err.length = 0;
    expect(await snapshotListCommand("no-such-run", {}, cwd)).toBe(1);
    expect(err.join("")).toContain('no history entries found for runId "no-such-run"');
    err.length = 0;
    expect(await snapshotListCommand(undefined, { json: true, text: true }, cwd)).toBe(1);
    expect(err.join("")).toContain("cannot be used together");
  });

  it("accept --step: そのステップだけを基準に書き込み、他のステップは待ちのまま残す", async () => {
    const runId = await recordMismatchedRun();

    expect(await snapshotAcceptCommand(runId, { json: true, step: "first" }, cwd)).toBe(0);

    expect(JSON.parse(out.join(""))).toEqual({
      version: 1,
      runId,
      accepted: [
        { key: "first", snapshotFile: "__snapshots__/snap.yaml.snap.json", state: "updated" },
      ],
      failed: [],
    });
    const written = JSON.parse(await readFile(snapshotFile(), "utf-8"));
    expect(written.first.body).toEqual({ name: "bob" });
    expect(written.second.body).toEqual({ name: "alice" });
  });

  it("accept(--step なし): 承認待ちをすべて書き込み、次の実行は一致する", async () => {
    const runId = await recordMismatchedRun();

    expect(await snapshotAcceptCommand(runId, { text: true }, cwd)).toBe(0);

    expect(out.join("")).toContain("updated: first -> __snapshots__/snap.yaml.snap.json");
    expect(out.join("")).toContain("updated: second -> __snapshots__/snap.yaml.snap.json");
    const rerun = await runLoadedFlows([{ filePath: "snap.yaml", flow: twoSteps() }], {
      cwd,
      history: false,
    });
    expect(rerun.status).toBe("passed");
    expect(rerun.snapshots).toMatchObject({ matched: 2, mismatched: 0 });
  });

  it("accept: 不明な run・承認待ちが無い・存在しないステップ名は exit 1 で何も書かない", async () => {
    const runId = await recordMismatchedRun();
    const before = await readFile(snapshotFile(), "utf-8");

    expect(await snapshotAcceptCommand("no-such-run", {}, cwd)).toBe(1);
    expect(await snapshotAcceptCommand(runId, { step: "nope" }, cwd)).toBe(1);
    expect(err.join("")).toContain('has no pending snapshot for step "nope"');
    expect(await readFile(snapshotFile(), "utf-8")).toBe(before);

    // 承認済みの run をもう一度承認しても、待ちはまだ履歴に残っているため再度書ける(冪等)。
    // 一致した実行(待ちなし)の run は exit 1 になる
    await snapshotAcceptCommand(runId, {}, cwd);
    const matched = await runLoadedFlows([{ filePath: "snap.yaml", flow: twoSteps() }], {
      cwd,
      history: true,
    });
    err.length = 0;
    expect(await snapshotAcceptCommand(matched.runId, {}, cwd)).toBe(1);
    expect(err.join("")).toContain("has no pending snapshot mismatches");
  });

  it("accept: 壊れたスナップショットファイルは exit 2 で、書き換えない", async () => {
    const runId = await recordMismatchedRun();
    await writeFile(snapshotFile(), "not json", "utf-8");

    expect(await snapshotAcceptCommand(runId, { json: true }, cwd)).toBe(2);

    const report = JSON.parse(out.join(""));
    expect(report.accepted).toEqual([]);
    expect(report.failed).toHaveLength(2);
    expect(report.failed[0]).toMatchObject({ kind: "corrupt" });
    expect(await readFile(snapshotFile(), "utf-8")).toBe("not json");
  });

  it("他のアサーションが失敗したステップの候補は、list に otherAssertionsFailed で出し、accept は failed-step で拒否する(exit 2)", async () => {
    const failing = flow({
      name: "snap flow",
      steps: [
        {
          name: "first",
          request: { method: "GET", url: `${baseUrl}/first` },
          assert: { status: 500, snapshot: true },
          continueOnError: true,
        },
      ],
    });
    const entries = [{ filePath: "snap.yaml", flow: failing }];
    // 基準は、他のアサーションが通る状態で先に書いておく
    await runLoadedFlows([{ filePath: "snap.yaml", flow: twoSteps() }], {
      cwd,
      history: false,
      snapshots: { ci: false },
    });
    body = { name: "bob" };
    const result = await runLoadedFlows(entries, { cwd, history: true, snapshots: { ci: false } });
    const before = await readFile(snapshotFile(), "utf-8");

    expect(await snapshotListCommand(result.runId, { json: true }, cwd)).toBe(0);
    expect(JSON.parse(out.join("")).mismatches[0]).toMatchObject({
      key: "first",
      otherAssertionsFailed: true,
    });
    out.length = 0;
    expect(await snapshotListCommand(result.runId, { text: true }, cwd)).toBe(0);
    expect(out.join("")).toContain("cannot be accepted");

    out.length = 0;
    expect(await snapshotAcceptCommand(result.runId, { json: true }, cwd)).toBe(2);
    expect(JSON.parse(out.join(""))).toMatchObject({
      accepted: [],
      failed: [{ key: "first", kind: "failed-step" }],
    });
    expect(await readFile(snapshotFile(), "utf-8")).toBe(before);
  });
});
