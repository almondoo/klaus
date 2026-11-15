import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ParseError } from "../src/core/errors.js";
import { loadFlow } from "../src/core/loader.js";
import { OpenApiValidator } from "../src/core/openapi.js";
import type { LoadedFlowEntry } from "../src/core/runner.js";
import { executeFlow, runLoadedFlows } from "../src/core/runner.js";
import { type Flow, flowSchema } from "../src/core/schema.js";
import {
  acceptSnapshot,
  findSnapshotKeyProblem,
  findUnsafeSnapshotPath,
  LOCK_STALE_MS,
  LOCK_TIMEOUT_MS,
  listSnapshotMismatches,
  withFileLock,
} from "../src/core/snapshot.js";
import { closeServer, listenEphemeral } from "./support/net.js";

/** 応答を差し替えられるローカルサーバー */
const state = { body: { id: 1, name: "alice" } as unknown, raw: undefined as string | undefined };

describe("snapshot の堅牢化", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  const tmpRoot = join(process.cwd(), "tmp");
  let cwd: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(state.raw ?? JSON.stringify(state.body));
    });
    ({ baseUrl } = await listenEphemeral(server));
    await mkdir(tmpRoot, { recursive: true });
  });
  afterAll(async () => {
    await closeServer(server);
  });
  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
    state.body = { id: 1, name: "alice" };
    state.raw = undefined;
  });

  async function newCwd() {
    cwd = await mkdtemp(join(tmpRoot, "klaus-snapshot-hard-"));
    await mkdir(join(cwd, "flows"), { recursive: true });
    return cwd;
  }

  const flowOf = (steps: Record<string, unknown>[]): Flow =>
    flowSchema.parse({ name: "snap flow", steps });
  const getStep = (name: string, assert: Record<string, unknown>) => ({
    name,
    request: { method: "GET", url: `${baseUrl}/user` },
    assert,
  });
  const snapFile = (rel = "flows") => join(cwd, rel, "__snapshots__", "snap.yaml.snap.json");
  const options = (extra: Record<string, unknown> = {}) => ({
    cwd,
    history: false as const,
    snapshots: { ci: false },
    ...extra,
  });

  it("OpenAPI の検証に失敗した応答は、基準として書かない(-u でも)", async () => {
    await newCwd();
    const spec = join(cwd, "api.json");
    await writeFile(
      spec,
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "t", version: "1" },
        paths: {
          "/user": {
            get: {
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      schema: { type: "object", properties: { id: { type: "string" } } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    const openapi = await OpenApiValidator.load([spec], { cwd });
    try {
      const flow = flowOf([getStep("get-user", { snapshot: true })]);
      for (const snapshots of [{ ci: false }, { update: true }]) {
        const result = await executeFlow(flow, "flows/snap.yaml", options({ openapi, snapshots }));
        expect(result.status).toBe("failed");
        const assertions = result.steps[0]?.assertions ?? [];
        expect(assertions.find((a) => a.kind === "openapi")?.ok).toBe(false);
        expect(assertions.find((a) => a.kind === "snapshot")?.snapshot?.state).toBe("missing");
        await expect(readFile(snapFile(), "utf-8")).rejects.toThrow();
      }
    } finally {
      openapi.close();
    }
  });

  it("キーが曖昧になるステップ名と、同じキーになる複数のステップは定義エラー", async () => {
    const reject = (steps: Record<string, unknown>[]) =>
      findSnapshotKeyProblem(flowOf(steps))?.message;
    // `s :: v` のステップと、step `s` の name: v は、どちらも `s :: v` になってしまう
    expect(reject([getStep("s :: v", { snapshot: true })])).toContain('must not contain " :: "');
    expect(reject([getStep("s #2", { snapshot: true })])).toContain("#<number>");
    // 同じキーになる複数のステップ(ステップ名の重複はスキーマが弾くため、スキーマを通さずに確かめる)
    const raw = [
      getStep("s", { snapshot: { name: "v" } }),
      getStep("s", { snapshot: { name: "v" } }),
    ] as unknown as Flow["steps"];
    expect(findSnapshotKeyProblem({ steps: raw })?.message).toContain('same snapshot key "s :: v"');
    // snapshot を使わないステップの名前は自由
    expect(reject([getStep("s :: v", { status: 200 })])).toBeUndefined();

    await newCwd();
    const entries: LoadedFlowEntry[] = [
      { filePath: "flows/snap.yaml", flow: flowOf([getStep("a :: b", { snapshot: true })]) },
    ];
    await expect(runLoadedFlows(entries, options())).rejects.toBeInstanceOf(ParseError);
    // ファイルから読み込む場合も同じ(validate / run の前に弾く)
    await writeFile(
      join(cwd, "flows", "dup.yaml"),
      [
        "name: dup",
        "steps:",
        ...["one", "two"].flatMap(() => [
          "  - name: same",
          "    request: {method: GET, url: 'http://127.0.0.1:1/x'}",
          "    assert: {snapshot: true}",
        ]),
        "",
      ].join("\n"),
    );
    await expect(loadFlow(join(cwd, "flows", "dup.yaml"))).rejects.toThrow(/duplicated/);
  });

  it("名前付きパイプ(FIFO)が基準のパスにあっても、ブロックせずに壊れたファイルとして扱う", async () => {
    await newCwd();
    await mkdir(join(cwd, "flows", "__snapshots__"), { recursive: true });
    execFileSync("mkfifo", [snapFile()]);
    const flow = flowOf([getStep("get-user", { snapshot: true })]);

    const error = await executeFlow(flow, "flows/snap.yaml", options()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ParseError);
    expect((error as Error).message).toContain("not a regular file");

    const outcome = await acceptSnapshot(cwd, "none", {
      snapshotFile: "flows/__snapshots__/snap.yaml.snap.json",
      key: "get-user",
    });
    expect(outcome).toMatchObject({ ok: false });
  });

  it("__snapshots__ がシンボリックリンクなら、行き先が cwd 内でも読み書きしない", async () => {
    await newCwd();
    await mkdir(join(cwd, "elsewhere"), { recursive: true });
    await symlink(join(cwd, "elsewhere"), join(cwd, "flows", "__snapshots__"));
    const flow = flowOf([getStep("get-user", { snapshot: true })]);

    const result = await executeFlow(flow, "flows/snap.yaml", options());

    expect(result.status).toBe("error");
    expect(result.steps[0]?.error).toContain("symbolic link");
    await expect(
      readFile(join(cwd, "elsewhere", "snap.yaml.snap.json"), "utf-8"),
    ).rejects.toThrow();
    // 基準ファイル自体がリンクでも同じ
    await rm(join(cwd, "flows", "__snapshots__"));
    await mkdir(join(cwd, "flows", "__snapshots__"));
    await writeFile(join(cwd, "target.json"), "{}\n");
    await symlink(join(cwd, "target.json"), snapFile());
    expect(findUnsafeSnapshotPath(cwd, snapFile())).toContain("symbolic link");
  });

  it(".git などの隠しディレクトリの下の __snapshots__ には書かない(accept も)", async () => {
    await newCwd();
    const file = join(cwd, ".git", "__snapshots__", "x.snap.json");
    expect(findUnsafeSnapshotPath(cwd, file)).toContain("hidden directory");
    await mkdir(join(cwd, ".git"), { recursive: true });
    await writeHistory(cwd, ".git/__snapshots__/x.snap.json", { body: "x" });
    const outcome = await acceptSnapshot(cwd, "forged", {
      snapshotFile: ".git/__snapshots__/x.snap.json",
      key: "s",
    });
    expect(outcome).toMatchObject({ ok: false, kind: "unsafe" });
    await expect(readFile(file, "utf-8")).rejects.toThrow();
  });

  it("cwd の外を指すパスのエラーに、cwd の外の絶対パスを載せない", async () => {
    await newCwd();
    const message = findUnsafeSnapshotPath(cwd, "/etc/__snapshots__/x.snap.json");
    expect(message).toContain("outside the current directory");
    expect(message).not.toContain("/etc");
  });

  it("深く入れ子になった基準は壊れたファイル(exit 2 相当)として扱い、クラッシュしない。内容は出さない", async () => {
    await newCwd();
    await mkdir(join(cwd, "flows", "__snapshots__"), { recursive: true });
    const deep = `${"[".repeat(5000)}"deep-secret-marker"${"]".repeat(5000)}`;
    await writeFile(snapFile(), `{"get-user":{"body":${deep}}}\n`);
    const flow = flowOf([getStep("get-user", { snapshot: true })]);

    const error = await executeFlow(flow, "flows/snap.yaml", options()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ParseError);
    expect((error as Error).message).toContain("is not a snapshot");
    expect((error as Error).message).not.toContain("deep-secret-marker");
    // -u なら作り直せる
    const recreated = await executeFlow(
      flow,
      "flows/snap.yaml",
      options({ snapshots: { update: true } }),
    );
    expect(recreated.status).toBe("passed");
    expect(JSON.parse(await readFile(snapFile(), "utf-8"))["get-user"].body.name).toBe("alice");
  });

  it("深すぎる JSON 応答は、パースされずテキストのまま届くため、クラッシュせずテキストの本文として基準になる", async () => {
    await newCwd();
    const deep = `${"[".repeat(1000)}${"]".repeat(1000)}`;
    state.raw = deep;
    const flow = flowOf([getStep("get-user", { snapshot: true })]);

    const result = await executeFlow(flow, "flows/snap.yaml", options());

    expect(result.status).toBe("passed");
    // 入れ子が上限を超える JSON は parseJsonBody がテキストのまま返す(スナップショットの深さの検査まで届かない)
    expect(JSON.parse(await readFile(snapFile(), "utf-8"))["get-user"].body).toBe(deep);
  });

  it("accept は履歴の候補を検証し、形が不正なものは書かない", async () => {
    await newCwd();
    const rel = "flows/__snapshots__/snap.yaml.snap.json";
    for (const candidate of [
      { status: "not-a-number", headers: 5 },
      [1, 2, 3],
      "text",
      { body: deepArray(300) },
    ]) {
      await writeHistory(cwd, rel, candidate);
      const outcome = await acceptSnapshot(cwd, "forged", { snapshotFile: rel, key: "s" });
      expect(outcome, JSON.stringify(candidate).slice(0, 40)).toMatchObject({
        ok: false,
        kind: "corrupt",
      });
      await expect(readFile(snapFile(), "utf-8")).rejects.toThrow();
    }
    // 正しい形なら、余計なキーを落として書く
    await writeHistory(cwd, rel, { status: 200, body: { a: 1 }, extra: "dropped" });
    expect(await acceptSnapshot(cwd, "forged", { snapshotFile: rel, key: "s" })).toMatchObject({
      ok: true,
      state: "written",
    });
    expect(JSON.parse(await readFile(snapFile(), "utf-8"))).toEqual({
      s: { status: 200, body: { a: 1 } },
    });
  });

  it("他のアサーションが失敗したステップは、-u でも基準にせず、accept も拒否する(failed-step)", async () => {
    await newCwd();
    const ok = flowOf([getStep("get-user", { snapshot: true })]);
    await executeFlow(ok, "flows/snap.yaml", options());
    state.body = { id: 2, name: "bob" };

    // -u でも、status アサーションが失敗した応答では書き換えない
    const failing = flowOf([getStep("get-user", { status: 500, snapshot: true })]);
    const updated = await executeFlow(
      failing,
      "flows/snap.yaml",
      options({ snapshots: { update: true } }),
    );
    expect(updated.status).toBe("failed");
    const detail = updated.steps[0]?.assertions.find((a) => a.kind === "snapshot");
    expect(detail?.snapshot?.state).toBe("mismatch");
    expect(detail?.message).toContain("other assertions failed");
    expect(JSON.parse(await readFile(snapFile(), "utf-8"))["get-user"].body.name).toBe("alice");

    // 履歴に残った候補は、承認待ちとして見えるが、otherAssertionsFailed が立ち、accept は拒否する
    const recorded = await executeFlow(failing, "flows/snap.yaml", {
      cwd,
      history: true,
      snapshots: { ci: false },
    });
    expect(recorded.status).toBe("failed");
    const { readAllHistoryEntries } = await import("../src/core/history-query.js");
    const runId = (await readAllHistoryEntries(cwd))[0]?.runId as string;
    const pending = await listSnapshotMismatches(cwd, runId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ key: "get-user", otherAssertionsFailed: true });
    const outcome = await acceptSnapshot(cwd, runId, {
      snapshotFile: pending[0]?.snapshotFile as string,
      key: "get-user",
    });
    expect(outcome).toMatchObject({ ok: false, kind: "failed-step" });
    expect(JSON.parse(await readFile(snapFile(), "utf-8"))["get-user"].body.name).toBe("alice");
  });

  it("別々のストアが同じファイルの別のキーを同時に書いても、互いの書き込みを失わない", async () => {
    for (let round = 0; round < 5; round++) {
      await newCwd();
      const a = flowOf([getStep("step-a", { snapshot: true })]);
      const b = flowOf([getStep("step-b", { snapshot: true })]);
      const [ra, rb] = await Promise.all([
        executeFlow(a, "flows/snap.yaml", options()),
        executeFlow(b, "flows/snap.yaml", options()),
      ]);
      expect([ra.status, rb.status]).toEqual(["passed", "passed"]);
      expect(Object.keys(JSON.parse(await readFile(snapFile(), "utf-8"))).sort()).toEqual([
        "step-a",
        "step-b",
      ]);
      await rm(cwd, { recursive: true, force: true });
    }
    await newCwd();
  });

  it("--jobs の並列実行(--data の反復)が同じファイルへ書いても、すべてのキーが残る", async () => {
    await newCwd();
    const entries: LoadedFlowEntry[] = [
      { filePath: "flows/snap.yaml", flow: flowOf([getStep("get-user", { snapshot: true })]) },
    ];
    const result = await runLoadedFlows(entries, {
      cwd,
      history: false,
      jobs: 4,
      dataRows: Array.from({ length: 8 }, (_, i) => ({ n: String(i) })),
      snapshots: { ci: false },
    });
    expect(result.status).toBe("passed");
    expect(Object.keys(JSON.parse(await readFile(snapFile(), "utf-8")))).toHaveLength(8);
  });
});

function deepArray(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

/** 履歴に、承認待ちの snapshot を 1 件持つ run `forged` を書く(候補は引数のまま) */
async function writeHistory(cwd: string, file: string, candidate: unknown): Promise<void> {
  await mkdir(join(cwd, ".klaus", "history"), { recursive: true });
  const entry = {
    v: 1,
    runId: "forged",
    flow: "f",
    step: "s",
    startedAt: "2026-11-15T00:00:00.000Z",
    durationMs: 1,
    status: "failed",
    assertions: [
      {
        ok: false,
        kind: "snapshot",
        message: "m",
        snapshot: { key: "s", file, state: "mismatch", candidate },
      },
    ],
  };
  await writeFile(
    join(cwd, ".klaus", "history", "2026-11-15.jsonl"),
    `${JSON.stringify(entry)}\n`,
    "utf-8",
  );
}

describe("スナップショットのロック(withFileLock)", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;

  beforeAll(async () => {
    await mkdir(tmpRoot, { recursive: true });
  });
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function lockPathInNewDir() {
    dir = await mkdtemp(join(tmpRoot, "klaus-snapshot-lock-"));
    return join(dir, "snap.json.lock");
  }

  it("待ち時間の上限は stale の閾値より長い(クラッシュで残ったロックは必ず待ち切って奪える)", () => {
    expect(LOCK_STALE_MS).toBe(30_000);
    expect(LOCK_TIMEOUT_MS).toBe(35_000);
    expect(LOCK_TIMEOUT_MS).toBeGreaterThan(LOCK_STALE_MS);
  });

  it("他の実行がロックを持ち続けていると、ロックファイルのパスと削除してよい旨を添えてタイムアウトする", async () => {
    const lockPath = await lockPathInNewDir();
    await writeFile(lockPath, "");
    await expect(
      withFileLock(lockPath, async () => "never", {
        timeoutMs: 80,
        displayPath: "flows/__snapshots__/x.snap.json.lock",
      }),
    ).rejects.toThrow(
      /timed out waiting for another run.*"flows\/__snapshots__\/x\.snap\.json\.lock".*remove the lock file/,
    );
    // 取れなかったロックは消さない
    await stat(lockPath);
  });

  it("stale より古いロックはクラッシュの残りとして奪って実行し、終わったら削除する", async () => {
    const lockPath = await lockPathInNewDir();
    await writeFile(lockPath, "");
    const old = new Date(Date.now() - LOCK_STALE_MS - 1000);
    await utimes(lockPath, old, old);
    await expect(withFileLock(lockPath, async () => "done")).resolves.toBe("done");
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
