import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ParseError } from "../src/core/errors.js";
import { readAllHistoryEntries } from "../src/core/history-query.js";
import type { LoadedFlowEntry } from "../src/core/runner.js";
import { executeFlow, runLoadedFlows } from "../src/core/runner.js";
import { type Flow, flowSchema } from "../src/core/schema.js";
import {
  acceptSnapshot,
  buildSnapshotCandidate,
  buildSnapshotKey,
  compareSnapshot,
  listSnapshotMismatches,
  normalizeSnapshotSpec,
  SNAPSHOT_PLACEHOLDER,
  serializeSnapshotFile,
  snapshotFilePath,
} from "../src/core/snapshot.js";
import { closeServer, listenEphemeral } from "./support/net.js";

/** レスポンスを差し替えられるローカルサーバー */
function startFixture() {
  const state = {
    body: { id: 1, name: "alice", token: "tok-secret-value", at: "2026-01-01" } as unknown,
    status: 200,
    contentType: "application/json",
    requests: 0,
  };
  const server = createServer((_req, res) => {
    state.requests += 1;
    res.writeHead(state.status, { "Content-Type": state.contentType, "X-Trace": "t-1" });
    res.end(typeof state.body === "string" ? state.body : JSON.stringify(state.body));
  });
  return { server, state };
}

describe("snapshot (pure functions)", () => {
  it("キーはステップ名に反復番号と name を足して作る", () => {
    expect(buildSnapshotKey("login", undefined, undefined)).toBe("login");
    expect(buildSnapshotKey("login", 2, undefined)).toBe("login #2");
    expect(buildSnapshotKey("login", 2, "v2")).toBe("login #2 :: v2");
    expect(buildSnapshotKey("login", undefined, "v2")).toBe("login :: v2");
  });

  it("スナップショットファイルはフローファイルの隣の __snapshots__ に置く", () => {
    expect(snapshotFilePath("/work", "flows/login.yaml")).toBe(
      "/work/flows/__snapshots__/login.yaml.snap.json",
    );
    expect(snapshotFilePath("/work", "/work/a.yaml")).toBe("/work/__snapshots__/a.yaml.snap.json");
  });

  it("既定は status と body。headers は指定した名前(小文字化)だけを、存在するものに限って保存する", () => {
    const response = {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Trace": "t" },
      body: { a: 1 },
    };
    expect(buildSnapshotCandidate(normalizeSnapshotSpec(true), response, [])).toEqual({
      status: 200,
      body: { a: 1 },
    });
    const withHeaders = normalizeSnapshotSpec({
      include: ["headers"],
      headers: ["CONTENT-TYPE", "x-missing"],
    });
    expect(buildSnapshotCandidate(withHeaders, response, [])).toEqual({
      headers: { "content-type": "application/json" },
    });
    // headers の名前を省略すると content-type だけ
    expect(
      buildSnapshotCandidate(normalizeSnapshotSpec({ include: ["headers"] }), response, []),
    ).toEqual({ headers: { "content-type": "application/json" } });
  });

  it("秘密値は履歴と同じマスクを通して保存し、ignore に一致した値は固定値にする", () => {
    const spec = normalizeSnapshotSpec({ ignore: ["$.items[*].id", "$..at"] });
    const candidate = buildSnapshotCandidate(
      spec,
      {
        status: 200,
        headers: {},
        body: { token: "tok-secret-value", items: [{ id: 1 }, { id: 2 }], meta: { at: "now" } },
      },
      ["tok-secret-value"],
    );
    expect(candidate.body).toEqual({
      token: "***",
      items: [{ id: SNAPSHOT_PLACEHOLDER }, { id: SNAPSHOT_PLACEHOLDER }],
      meta: { at: SNAPSHOT_PLACEHOLDER },
    });
  });

  it("入れ子が深すぎる・大きすぎる応答は基準にしない", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 300; i++) deep = { a: deep };
    const spec = normalizeSnapshotSpec(true);
    expect(() =>
      buildSnapshotCandidate(spec, { status: 200, headers: {}, body: deep }, []),
    ).toThrow(/nested deeper/);
    expect(() =>
      buildSnapshotCandidate(
        spec,
        { status: 200, headers: {}, body: "x".repeat(1024 * 1024 + 1) },
        [],
      ),
    ).toThrow(/larger than/);
  });

  it("比較は status / headers / body の構造差分で、基準側の body にも現在の ignore を適用する", () => {
    const spec = normalizeSnapshotSpec({ ignore: ["$.id"] });
    const baseline = { status: 200, body: { id: 1, name: "a" } };
    // 基準に ignore 追加前の実値が残っていても、現在の ignore で同じ扱いになる
    expect(
      compareSnapshot(
        baseline,
        { status: 200, body: { id: SNAPSHOT_PLACEHOLDER, name: "a" } },
        spec,
      ),
    ).toEqual([]);
    expect(
      compareSnapshot(
        baseline,
        { status: 500, body: { id: SNAPSHOT_PLACEHOLDER, name: "b" } },
        spec,
      ),
    ).toEqual([
      { path: "$.status", kind: "changed", before: 200, after: 500 },
      { path: "$.body.name", kind: "changed", before: "a", after: "b" },
    ]);
  });

  it("include に含まれない部分は比較しない。新しく含めた部分が基準に無ければ added になる", () => {
    const bodyOnly = normalizeSnapshotSpec({ include: ["body"] });
    expect(
      compareSnapshot({ status: 200, body: "x" }, { status: 500, body: "x" }, bodyOnly),
    ).toEqual([]);
    const withHeaders = normalizeSnapshotSpec({ include: ["body", "headers"] });
    expect(
      compareSnapshot(
        { body: "x" },
        { body: "x", headers: { "content-type": "text/plain" } },
        withHeaders,
      ),
    ).toEqual([{ path: "$.headers", kind: "added", after: { "content-type": "text/plain" } }]);
  });

  it("ファイルの表現はキー順ソート・2 スペース整形・末尾改行で、空なら {}", () => {
    const text = serializeSnapshotFile(
      new Map([
        ["b", { status: 200, body: { z: 1, a: [2] } }],
        ["a", { body: "x" }],
      ]),
    );
    expect(text).toBe(
      '{\n  "a": {\n    "body": "x"\n  },\n  "b": {\n    "body": {\n      "a": [\n        2\n      ],\n      "z": 1\n    },\n    "status": 200\n  }\n}\n',
    );
    expect(serializeSnapshotFile(new Map())).toBe("{}\n");
  });
});

describe("snapshot assertions (executeFlow)", () => {
  let fixture: ReturnType<typeof startFixture>;
  let baseUrl: string;
  const tmpRoot = join(process.cwd(), "tmp");
  let cwd: string;

  beforeAll(async () => {
    fixture = startFixture();
    ({ baseUrl } = await listenEphemeral(fixture.server));
    await mkdir(tmpRoot, { recursive: true });
  });
  afterAll(async () => {
    await closeServer(fixture.server);
  });
  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
    fixture.state.body = { id: 1, name: "alice", token: "tok-secret-value", at: "2026-01-01" };
    fixture.state.status = 200;
    fixture.state.contentType = "application/json";
  });

  async function newCwd() {
    cwd = await mkdtemp(join(tmpRoot, "klaus-snapshot-"));
    await mkdir(join(cwd, "flows"), { recursive: true });
    return cwd;
  }

  function flowWith(snapshot: unknown, extra: Record<string, unknown> = {}): Flow {
    return flowSchema.parse({
      name: "snap flow",
      steps: [
        {
          name: "get-user",
          request: { method: "GET", url: `${baseUrl}/user` },
          assert: { snapshot, ...extra },
        },
      ],
    });
  }

  const snapFile = () => join(cwd, "flows", "__snapshots__", "snap.yaml.snap.json");
  const readSnap = async () => JSON.parse(await readFile(snapFile(), "utf-8"));
  const options = (extra: Record<string, unknown> = {}) => ({
    cwd,
    history: false as const,
    ...extra,
  });

  it("基準が無ければ書き込んで成功にし、2 回目は一致し、応答が変わると構造差分つきで失敗する", async () => {
    await newCwd();
    const flow = flowWith({ ignore: ["$.at"] });

    // 初回: 基準を書き込む(実際のファイル書き込みは実行の終了時)
    const first = await executeFlow(flow, "flows/snap.yaml", options({ snapshots: { ci: false } }));
    expect(first.status).toBe("passed");
    expect(first.steps[0]?.assertions[0]).toMatchObject({
      ok: true,
      kind: "snapshot",
      snapshot: {
        state: "written",
        key: "get-user",
        file: "flows/__snapshots__/snap.yaml.snap.json",
      },
    });
    expect(await readSnap()).toEqual({
      "get-user": {
        body: { at: SNAPSHOT_PLACEHOLDER, id: 1, name: "alice", token: "tok-secret-value" },
        status: 200,
      },
    });

    // 揮発する値(ignore)だけが変わっても一致する
    fixture.state.body = { id: 1, name: "alice", token: "tok-secret-value", at: "2026-02-02" };
    const second = await executeFlow(flow, "flows/snap.yaml", options());
    expect(second.steps[0]?.assertions[0]?.snapshot?.state).toBe("matched");

    // 応答が変わる → 失敗。差分は基準 → 今回で、候補(承認用)も持つ
    fixture.state.body = { id: 1, name: "bob", token: "tok-secret-value", at: "x" };
    const third = await executeFlow(flow, "flows/snap.yaml", options());
    expect(third.status).toBe("failed");
    const assertion = third.steps[0]?.assertions[0];
    expect(assertion?.ok).toBe(false);
    expect(assertion?.snapshot).toMatchObject({
      state: "mismatch",
      differenceCount: 1,
      differences: [{ path: "$.body.name", kind: "changed", before: "alice", after: "bob" }],
      candidate: { status: 200, body: { name: "bob" } },
    });
    expect(assertion?.message).toContain('$.body.name "alice" -> "bob"');
    // 不一致のままでは基準を書き換えない
    expect((await readSnap())["get-user"].body.name).toBe("alice");
  });

  it("update(-u)は不一致の基準を書き換え、未記録の基準も書き込む(CI でも)", async () => {
    await newCwd();
    const flow = flowWith(true);
    await executeFlow(flow, "flows/snap.yaml", options({ snapshots: { ci: false } }));

    fixture.state.body = { changed: true };
    const updated = await executeFlow(
      flow,
      "flows/snap.yaml",
      options({ snapshots: { update: true, ci: true } }),
    );
    expect(updated.status).toBe("passed");
    expect(updated.steps[0]?.assertions[0]?.snapshot?.state).toBe("updated");
    expect((await readSnap())["get-user"].body).toEqual({ changed: true });

    // 未記録のキー(ステップ名を変えた)は written になる
    const renamed = flowSchema.parse({
      name: "snap flow",
      steps: [
        {
          name: "renamed",
          request: { method: "GET", url: `${baseUrl}/user` },
          assert: { snapshot: true },
        },
      ],
    });
    const written = await executeFlow(
      renamed,
      "flows/snap.yaml",
      options({ snapshots: { update: true, ci: true } }),
    );
    expect(written.steps[0]?.assertions[0]?.snapshot?.state).toBe("written");
    // 古いキーは取り除かれる(全ステップを実行した実行なので)
    expect(Object.keys(await readSnap())).toEqual(["renamed"]);
  });

  it("CI では基準が無いと書き込まずに失敗する。replay・保護環境でも暗黙には書かない", async () => {
    await newCwd();
    const flow = flowWith(true);

    const ci = await executeFlow(flow, "flows/snap.yaml", options({ snapshots: { ci: true } }));
    expect(ci.status).toBe("failed");
    expect(ci.steps[0]?.assertions[0]?.snapshot?.state).toBe("missing");
    expect(ci.steps[0]?.assertions[0]?.message).toContain("not recorded in CI");
    await expect(readFile(snapFile(), "utf-8")).rejects.toThrow();

    // 保護環境(環境ファイルの $protected: readonly)へ GET する実行
    await mkdir(join(cwd, "environments"), { recursive: true });
    await writeFile(join(cwd, "environments", "prod.yaml"), "$protected: readonly\n", "utf-8");
    const protectedRun = await executeFlow(
      flow,
      "flows/snap.yaml",
      options({ envNameOverride: "prod", snapshots: { ci: false } }),
    );
    expect(protectedRun.steps[0]?.assertions[0]?.message).toContain("protected environment");
    expect(protectedRun.status).toBe("failed");
    await expect(readFile(snapFile(), "utf-8")).rejects.toThrow();

    // 保護環境でも --update-snapshots 相当を明示すれば書ける
    const explicit = await executeFlow(
      flow,
      "flows/snap.yaml",
      options({ envNameOverride: "prod", snapshots: { update: true } }),
    );
    expect(explicit.status).toBe("passed");
    expect(await readSnap()).toHaveProperty("get-user");
  });

  it("replay では基準を書かず、update も無視する。基準があれば比較できる", async () => {
    await newCwd();
    const flow = flowWith(true);
    const cassetteDir = join(cwd, "cassette");
    // まず実送信で記録(基準も書く)
    await executeFlow(
      flow,
      "flows/snap.yaml",
      options({ recording: { mode: "record", dir: cassetteDir }, snapshots: { ci: false } }),
    );
    const requestsAfterRecord = fixture.state.requests;

    // 基準がある状態で replay → 一致(ネットワークには出ない)
    const matched = await executeFlow(
      flow,
      "flows/snap.yaml",
      options({ recording: { mode: "replay", dir: cassetteDir } }),
    );
    expect(matched.steps[0]?.assertions[0]?.snapshot?.state).toBe("matched");
    expect(fixture.state.requests).toBe(requestsAfterRecord);

    // 基準を消して replay → 書かずに失敗。update を渡しても書かない
    await rm(join(cwd, "flows", "__snapshots__"), { recursive: true });
    const missing = await executeFlow(
      flow,
      "flows/snap.yaml",
      options({ recording: { mode: "replay", dir: cassetteDir }, snapshots: { update: true } }),
    );
    expect(missing.steps[0]?.assertions[0]?.snapshot?.state).toBe("missing");
    expect(missing.steps[0]?.assertions[0]?.message).toContain("--replay");
    await expect(readFile(snapFile(), "utf-8")).rejects.toThrow();
  });

  it("他のアサーションが失敗したステップの応答は、暗黙には基準にしない", async () => {
    await newCwd();
    fixture.state.status = 500;
    const flow = flowWith(true, { status: 200 });

    const result = await executeFlow(
      flow,
      "flows/snap.yaml",
      options({ snapshots: { ci: false } }),
    );

    expect(result.status).toBe("failed");
    const snapshot = result.steps[0]?.assertions.find((a) => a.kind === "snapshot");
    expect(snapshot).toMatchObject({ ok: true, snapshot: { state: "missing" } });
    await expect(readFile(snapFile(), "utf-8")).rejects.toThrow();
  });

  it("秘密値(環境変数経由)は基準に平文で残らず、履歴の承認用の候補も同様にマスクされる", async () => {
    await newCwd();
    process.env.KLAUS_SNAPSHOT_TEST_TOKEN = "tok-secret-value";
    try {
      const flow = flowSchema.parse({
        name: "snap flow",
        steps: [
          {
            name: "get-user",
            request: {
              method: "GET",
              url: `${baseUrl}/user`,
              headers: { Authorization: "Bearer {{env.KLAUS_SNAPSHOT_TEST_TOKEN}}" },
            },
            assert: { snapshot: true },
          },
        ],
      });
      await executeFlow(flow, "flows/snap.yaml", { cwd, history: true, snapshots: { ci: false } });
      const raw = await readFile(snapFile(), "utf-8");
      expect(raw).not.toContain("tok-secret-value");
      expect(raw).toContain('"token": "***"');

      fixture.state.body = { token: "tok-secret-value", other: 1 };
      await executeFlow(flow, "flows/snap.yaml", { cwd, history: true, snapshots: { ci: false } });
      const history = await readAllHistoryEntries(cwd);
      expect(JSON.stringify(history)).not.toContain("tok-secret-value");
    } finally {
      delete process.env.KLAUS_SNAPSHOT_TEST_TOKEN;
    }
  });

  it("--data の反復番号と name がキーに入り、古いキーは警告されるが update なしでは削除しない", async () => {
    await newCwd();
    const flow = flowWith({ name: "v1" });
    const entries: LoadedFlowEntry[] = [{ filePath: "flows/snap.yaml", flow }];

    await runLoadedFlows(entries, {
      cwd,
      history: false,
      dataRows: [{ n: "1" }, { n: "2" }],
      snapshots: { ci: false },
    });
    expect(Object.keys(await readSnap())).toEqual(["get-user #1 :: v1", "get-user #2 :: v1"]);

    // 1 行だけで再実行 → #2 が古いエントリ。警告のみで、ファイルはそのまま
    const warnings: string[] = [];
    const result = await runLoadedFlows(entries, {
      cwd,
      history: false,
      dataRows: [{ n: "1" }],
      snapshots: { ci: false },
      onWarning: (message) => warnings.push(message),
    });
    expect(result.status).toBe("passed");
    expect(result.snapshots).toMatchObject({
      matched: 1,
      obsolete: 1,
      obsoleteEntries: [
        { file: "flows/__snapshots__/snap.yaml.snap.json", keys: ["get-user #2 :: v1"] },
      ],
    });
    expect(warnings.join("\n")).toContain("1 obsolete entry");
    expect(Object.keys(await readSnap())).toHaveLength(2);

    // update なら取り除く
    const updated = await runLoadedFlows(entries, {
      cwd,
      history: false,
      dataRows: [{ n: "1" }],
      snapshots: { update: true },
    });
    expect(updated.snapshots?.files).toEqual(["flows/__snapshots__/snap.yaml.snap.json"]);
    expect(Object.keys(await readSnap())).toEqual(["get-user #1 :: v1"]);
  });

  it("フローが最後まで実行されなかった(スキップがある)場合は、古いエントリを判定しない", async () => {
    await newCwd();
    const flow = flowSchema.parse({
      name: "snap flow",
      steps: [
        { name: "boom", request: { method: "GET", url: `${baseUrl}/x` }, assert: { status: 999 } },
        {
          name: "get-user",
          request: { method: "GET", url: `${baseUrl}/user` },
          assert: { snapshot: true },
        },
      ],
    });
    await mkdir(join(cwd, "flows", "__snapshots__"), { recursive: true });
    await writeFile(snapFile(), '{"gone":{"body":"x"}}\n', "utf-8");

    const result = await runLoadedFlows([{ filePath: "flows/snap.yaml", flow }], {
      cwd,
      history: false,
      snapshots: { update: true },
    });

    expect(result.flows[0]?.steps[1]?.status).toBe("skipped");
    // 後続がスキップされたので "gone" は古いとみなさず、update でも消さない
    expect(result.snapshots).toBeUndefined();
    expect(await readSnap()).toHaveProperty("gone");
  });

  it("snapshot を使わなくなったフローの既存ファイルも、全ステップ実行後に古いエントリとして報告する", async () => {
    await newCwd();
    const flow = flowSchema.parse({
      name: "snap flow",
      steps: [{ name: "get-user", request: { method: "GET", url: `${baseUrl}/user` } }],
    });
    await mkdir(join(cwd, "flows", "__snapshots__"), { recursive: true });
    await writeFile(snapFile(), '{"get-user":{"body":"x"}}\n', "utf-8");

    const result = await runLoadedFlows([{ filePath: "flows/snap.yaml", flow }], {
      cwd,
      history: false,
      snapshots: { update: true },
    });

    expect(result.snapshots).toMatchObject({
      obsolete: 1,
      files: ["flows/__snapshots__/snap.yaml.snap.json"],
    });
    // 全エントリが古い → ファイル自体を削除する
    await expect(readFile(snapFile(), "utf-8")).rejects.toThrow();
  });

  it("壊れたスナップショットファイルは何も実行せず ParseError(内容は出さない)。update なら作り直す", async () => {
    await newCwd();
    const flow = flowWith(true);
    await mkdir(join(cwd, "flows", "__snapshots__"), { recursive: true });
    await writeFile(snapFile(), "SECRET-CONTENT{not json", "utf-8");
    const entries: LoadedFlowEntry[] = [{ filePath: "flows/snap.yaml", flow }];
    const requestsBefore = fixture.state.requests;

    const error = await runLoadedFlows(entries, { cwd, history: false }).catch((e) => e);
    expect(error).toBeInstanceOf(ParseError);
    expect((error as Error).message).toContain("is corrupt");
    expect((error as Error).message).not.toContain("SECRET-CONTENT");
    expect(fixture.state.requests).toBe(requestsBefore);

    // 形が違う(エントリが snapshot でない)ファイルも壊れているとみなす
    await writeFile(snapFile(), '{"get-user": 5}', "utf-8");
    await expect(runLoadedFlows(entries, { cwd, history: false })).rejects.toBeInstanceOf(
      ParseError,
    );

    const warnings: string[] = [];
    const recreated = await runLoadedFlows(entries, {
      cwd,
      history: false,
      snapshots: { update: true },
      onWarning: (message) => warnings.push(message),
    });
    expect(recreated.status).toBe("passed");
    expect(warnings.join("\n")).toContain("recreating");
    expect(await readSnap()).toHaveProperty("get-user");
  });

  it("書き込み先がシンボリックリンクなら、ステップを error にして何も書かない", async () => {
    await newCwd();
    const outside = await mkdtemp(join(tmpRoot, "klaus-snapshot-outside-"));
    try {
      await mkdir(join(cwd, "flows", "__snapshots__"), { recursive: true });
      await symlink(join(outside, "target.json"), snapFile());

      const result = await executeFlow(
        flowWith(true),
        "flows/snap.yaml",
        options({ snapshots: { ci: false } }),
      );

      expect(result.status).toBe("error");
      expect(result.steps[0]?.error).toContain("symbolic link");
      await expect(readFile(join(outside, "target.json"), "utf-8")).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("cwd の外のフローファイルに対しては、ステップを error にして書かない", async () => {
    await newCwd();
    const outside = await mkdtemp(join(tmpRoot, "klaus-snapshot-outside-"));
    try {
      const result = await executeFlow(
        flowWith(true),
        join(outside, "x.yaml"),
        options({ snapshots: { ci: false } }),
      );
      expect(result.status).toBe("error");
      expect(result.steps[0]?.error).toContain("outside the current directory");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("SSE ステップに指定すると失敗する(黙って無視しない)", async () => {
    await newCwd();
    const sse = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('data: {"a":1}\n\n');
    });
    const { baseUrl: sseUrl } = await listenEphemeral(sse);
    try {
      const flow = flowSchema.parse({
        name: "sse flow",
        steps: [
          {
            name: "events",
            request: {
              method: "GET",
              url: `${sseUrl}/s`,
              headers: { Accept: "text/event-stream" },
            },
            sse: { maxEvents: 1, maxDurationMs: 2000 },
            assert: { snapshot: true },
          },
        ],
      });
      const result = await executeFlow(flow, "flows/sse.yaml", options());
      expect(result.status).toBe("failed");
      expect(result.steps[0]?.assertions.find((a) => a.kind === "snapshot")?.message).toContain(
        "not supported for SSE",
      );
    } finally {
      await closeServer(sse);
    }
  });
});

describe("listSnapshotMismatches / acceptSnapshot", () => {
  let fixture: ReturnType<typeof startFixture>;
  let baseUrl: string;
  const tmpRoot = join(process.cwd(), "tmp");
  let cwd: string;

  beforeAll(async () => {
    fixture = startFixture();
    ({ baseUrl } = await listenEphemeral(fixture.server));
    await mkdir(tmpRoot, { recursive: true });
  });
  afterAll(async () => {
    await closeServer(fixture.server);
  });
  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  const flow = () =>
    flowSchema.parse({
      name: "snap flow",
      steps: [
        {
          name: "get-user",
          request: { method: "GET", url: `${baseUrl}/user` },
          assert: { snapshot: { ignore: ["$.at"] } },
        },
      ],
    });

  async function recordMismatch() {
    cwd = await mkdtemp(join(tmpRoot, "klaus-snapshot-accept-"));
    fixture.state.body = { id: 1, name: "alice", at: "t1" };
    await executeFlow(flow(), "snap.yaml", { cwd, history: true, snapshots: { ci: false } });
    fixture.state.body = { id: 1, name: "bob", at: "t2" };
    const result = await runLoadedFlows([{ filePath: "snap.yaml", flow: flow() }], {
      cwd,
      history: true,
      snapshots: { ci: false },
    });
    expect(result.status).toBe("failed");
    return result.runId;
  }

  it("履歴から、承認待ち(不一致)の差分を実行順に列挙し、何も書かない", async () => {
    const runId = await recordMismatch();
    const before = await readFile(join(cwd, "__snapshots__", "snap.yaml.snap.json"), "utf-8");

    const mismatches = await listSnapshotMismatches(cwd, runId);

    expect(mismatches).toEqual([
      expect.objectContaining({
        runId,
        flow: "snap flow",
        step: "get-user",
        flowFile: "snap.yaml",
        snapshotFile: "__snapshots__/snap.yaml.snap.json",
        key: "get-user",
        state: "mismatch",
        differenceCount: 1,
        differences: [{ path: "$.body.name", kind: "changed", before: "alice", after: "bob" }],
      }),
    ]);
    expect(await readFile(join(cwd, "__snapshots__", "snap.yaml.snap.json"), "utf-8")).toBe(before);
    expect(await listSnapshotMismatches(cwd, "no-such-run")).toEqual([]);
  });

  it("承認すると、履歴のマスク済みの候補が基準になり、次の実行は一致する。他のキーは変えない", async () => {
    const runId = await recordMismatch();
    const file = join(cwd, "__snapshots__", "snap.yaml.snap.json");
    const existing = JSON.parse(await readFile(file, "utf-8"));
    existing.other = { body: "keep me" };
    await writeFile(file, `${JSON.stringify(existing)}\n`, "utf-8");

    const outcome = await acceptSnapshot(cwd, runId, {
      snapshotFile: "__snapshots__/snap.yaml.snap.json",
      key: "get-user",
    });

    expect(outcome).toEqual({
      ok: true,
      state: "updated",
      snapshotFile: "__snapshots__/snap.yaml.snap.json",
      key: "get-user",
    });
    const written = JSON.parse(await readFile(file, "utf-8"));
    expect(written["get-user"].body).toEqual({ at: SNAPSHOT_PLACEHOLDER, id: 1, name: "bob" });
    expect(written.other).toEqual({ body: "keep me" });
    // キー順ソート・整形済み
    expect(Object.keys(written)).toEqual(["get-user", "other"]);

    const rerun = await executeFlow(flow(), "snap.yaml", { cwd, history: false });
    expect(rerun.steps[0]?.assertions[0]?.snapshot?.state).toBe("matched");
  });

  it("基準が無く書かれなかったもの(CI)も承認でき、その場合は written になる", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-snapshot-accept-"));
    fixture.state.body = { id: 1, name: "alice", at: "t1" };
    const result = await runLoadedFlows([{ filePath: "snap.yaml", flow: flow() }], {
      cwd,
      history: true,
      snapshots: { ci: true },
    });
    expect(result.status).toBe("failed");

    const outcome = await acceptSnapshot(cwd, result.runId, {
      snapshotFile: "__snapshots__/snap.yaml.snap.json",
      key: "get-user",
    });

    expect(outcome).toMatchObject({ ok: true, state: "written" });
    expect(
      JSON.parse(await readFile(join(cwd, "__snapshots__", "snap.yaml.snap.json"), "utf-8")),
    ).toHaveProperty("get-user");
  });

  it("承認待ちが無いキー・__snapshots__ 外や cwd 外のパス・壊れたファイルは拒否し、何も書かない", async () => {
    const runId = await recordMismatch();

    expect(
      await acceptSnapshot(cwd, runId, {
        snapshotFile: "__snapshots__/snap.yaml.snap.json",
        key: "nope",
      }),
    ).toMatchObject({ ok: false, kind: "not-found" });
    expect(
      await acceptSnapshot(cwd, "no-such-run", {
        snapshotFile: "__snapshots__/snap.yaml.snap.json",
        key: "get-user",
      }),
    ).toMatchObject({ ok: false, kind: "not-found" });

    // 履歴の file 以外を指定する(履歴にないパスは not-found)。履歴を偽装した場合の防御は unsafe で受ける
    const file = join(cwd, "__snapshots__", "snap.yaml.snap.json");
    await writeFile(file, "not json", "utf-8");
    expect(
      await acceptSnapshot(cwd, runId, {
        snapshotFile: "__snapshots__/snap.yaml.snap.json",
        key: "get-user",
      }),
    ).toMatchObject({ ok: false, kind: "corrupt" });
    expect(await readFile(file, "utf-8")).toBe("not json");
  });

  it("履歴が書き換えられていても、__snapshots__ の外・cwd の外・リンクには書かない", async () => {
    cwd = await mkdtemp(join(tmpRoot, "klaus-snapshot-accept-"));
    const outside = await mkdtemp(join(tmpRoot, "klaus-snapshot-outside-"));
    try {
      const forged = (file: string) => ({
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
            message: "forged",
            snapshot: { key: "s", file, state: "mismatch", candidate: { body: "PWNED" } },
          },
        ],
      });
      const targets = [
        "../outside.snap.json",
        "notes.txt",
        "__snapshots__/../escape.snap.json",
        `${outside}/__snapshots__/x.snap.json`,
        "link/__snapshots__/x.snap.json",
      ];
      await symlink(outside, join(cwd, "link"));
      await mkdir(join(cwd, ".klaus", "history"), { recursive: true });
      await writeFile(
        join(cwd, ".klaus", "history", "2026-11-15.jsonl"),
        `${targets.map((t) => JSON.stringify(forged(t))).join("\n")}\n`,
        "utf-8",
      );

      for (const target of targets) {
        const outcome = await acceptSnapshot(cwd, "forged", { snapshotFile: target, key: "s" });
        expect(outcome, target).toMatchObject({ ok: false, kind: "unsafe" });
      }
      await expect(
        readFile(join(outside, "__snapshots__", "x.snap.json"), "utf-8"),
      ).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
