import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { formatGithubAnnotations, formatGithubSummary } from "../src/cli/reporters/github.js";
import { formatHtml } from "../src/cli/reporters/html.js";
import { cassetteFilePath } from "../src/core/cassette.js";
import type { HistoryEntry } from "../src/core/history.js";
import { promoteRuns, renderPromotedYaml } from "../src/core/promote.js";
import { executeFlow } from "../src/core/runner.js";
import { flowSchema } from "../src/core/schema.js";
import { closeServer, listenEphemeral } from "./support/net.js";

/** 秘密値として登録されない短い cookie 値(16 文字未満) */
const SHORT_SID = "SESSION1";
/** jar が秘密値として登録する長い cookie 値(16 文字以上) */
const LONG_SID = "sess-0123456789abcdef-XYZ";

const state = { version: "1" };
const seen: { path: string; cookie: string | undefined }[] = [];

function sidOf(req: IncomingMessage): string | undefined {
  return /sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
}

describe("Set-Cookie は実行時に生の値、出力ではマスク", () => {
  let server: Server;
  let baseUrl: string;
  const tmpRoot = join(process.cwd(), "tmp");
  let cwd: string;
  let cassetteDir: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? "";
      seen.push({ path, cookie: req.headers.cookie });
      if (path === "/login-short" || path === "/login-long") {
        const value = path === "/login-short" ? SHORT_SID : LONG_SID;
        res.writeHead(200, {
          "Set-Cookie": [`sid=${value}; Path=/; HttpOnly`, "fmt=json; Path=/"],
          "Content-Type": "application/json",
          "X-Version": state.version,
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // 値が普通の内容(content-type)と同じ長い cookie 値を設定する
      if (path === "/login-ct") {
        res.writeHead(200, {
          "Set-Cookie": "ct=application/json; Path=/",
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // env の秘密値を構造的ヘッダー(content-type)にエコーする
      if (path === "/ct-echo") {
        res.writeHead(200, {
          "Content-Type": `text/plain; note=${req.headers["x-token"] ?? ""}`,
        });
        res.end("ok");
        return;
      }
      if (path === "/plain" || path.startsWith("/plain?")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, accept: req.headers.accept ?? null }));
        return;
      }
      // 受け取った sid を本文・ヘッダーにエコーする(cookie 以外の場所に値が出る状況)
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Session-Echo": sidOf(req) ?? "none",
      });
      res.end(JSON.stringify({ session: sidOf(req) ?? null, accept: req.headers.accept ?? null }));
    });
    ({ baseUrl } = await listenEphemeral(server));
    await mkdir(tmpRoot, { recursive: true });
  });
  afterAll(async () => {
    await closeServer(server);
  });
  afterEach(async () => {
    state.version = "1";
    seen.length = 0;
    if (cwd) await rm(cwd, { recursive: true, force: true });
    if (cassetteDir) await rm(cassetteDir, { recursive: true, force: true });
  });

  async function setup() {
    cwd = await mkdtemp(join(tmpRoot, "klaus-cookie-mask-"));
    cassetteDir = await mkdtemp(join(tmpRoot, "klaus-cookie-mask-cassette-"));
    await mkdir(join(cwd, "flows"), { recursive: true });
  }

  const snapFile = () => join(cwd, "flows", "__snapshots__", "snap.yaml.snap.json");

  async function run(
    flow: ReturnType<typeof flowSchema.parse>,
    extra: Record<string, unknown> = {},
  ) {
    const entries: HistoryEntry[] = [];
    const secrets: string[] = [];
    const result = await executeFlow(flow, "flows/snap.yaml", {
      cwd,
      history: (entry) => {
        entries.push(entry);
      },
      onSecrets: (values) => secrets.push(...values),
      snapshots: { ci: false },
      ...extra,
    });
    return { result, entries, secrets };
  }

  it("jar なしで set-cookie を capture して Cookie に再送でき、ヘッダーアサーションは生の値で通る", async () => {
    await setup();
    const flow = flowSchema.parse({
      name: "raw",
      steps: [
        {
          name: "login",
          request: { method: "GET", url: `${baseUrl}/login-short` },
          capture: { raw: { header: "set-cookie" } },
          assert: {
            status: 200,
            headers: [{ name: "set-cookie", regex: "^sid=SESSION" }],
          },
        },
        {
          name: "me",
          request: { method: "GET", url: `${baseUrl}/plain`, headers: { Cookie: "{{raw}}" } },
          assert: { status: 200 },
        },
      ],
    });
    const { result, entries } = await run(flow);
    expect(result.status).toBe("passed");
    // 実行時の応答ヘッダーとフィクスチャが受け取った Cookie は生の値
    expect(result.steps[0]?.response?.headers["set-cookie"]).toContain(`sid=${SHORT_SID}`);
    expect(seen.find((s) => s.path === "/plain")?.cookie).toBe(
      `sid=${SHORT_SID}; Path=/; HttpOnly, fmt=json; Path=/`,
    );
    // 履歴は位置でマスクされる(秘密値が未登録でも)
    expect(JSON.stringify(entries)).not.toContain(SHORT_SID);
    expect(entries[0]?.response?.headers["set-cookie"]).toBe(
      "sid=***; Path=/; HttpOnly, fmt=***; Path=/",
    );
  });

  it("set-cookie の失敗アサーションは、保存・出力される message と actual が *** になる", async () => {
    await setup();
    const flow = flowSchema.parse({
      name: "fail",
      steps: [
        {
          name: "login",
          request: { method: "GET", url: `${baseUrl}/login-short` },
          assert: {
            headers: [
              { name: "set-cookie", regex: "^nomatch" },
              { name: "Set-Cookie", contains: "zzz" },
              { name: "set-cookie", equals: "x" },
            ],
          },
        },
      ],
    });
    const { result, entries } = await run(flow);
    expect(result.status).toBe("failed");
    for (const assertions of [result.steps[0]?.assertions, entries[0]?.assertions]) {
      const text = JSON.stringify(assertions);
      expect(text).not.toContain(SHORT_SID);
      expect(assertions?.[0]?.actual).toBe("sid=***; Path=/; HttpOnly, fmt=***; Path=/");
      expect(assertions?.[0]?.message).toContain('but got "sid=***; Path=/; HttpOnly');
    }
  });

  it("履歴・カセット(record)・スナップショット(基準と候補)に、秘密値が未登録でも生の Set-Cookie が残らない", async () => {
    await setup();
    const flow = flowSchema.parse({
      name: "outputs",
      steps: [
        {
          name: "login",
          request: { method: "GET", url: `${baseUrl}/login-short` },
          assert: {
            snapshot: { include: ["status", "headers"], headers: ["set-cookie", "x-version"] },
          },
        },
      ],
    });
    const first = await run(flow, { recording: { mode: "record", dir: cassetteDir } });
    expect(first.result.status).toBe("passed");
    const cassette = await readFile(cassetteFilePath(cassetteDir), "utf-8");
    expect(cassette).not.toContain(SHORT_SID);
    expect(JSON.parse(cassette.trim()).headers["set-cookie"]).toBe(
      "sid=***; Path=/; HttpOnly, fmt=***; Path=/",
    );
    const baseline = await readFile(snapFile(), "utf-8");
    expect(baseline).not.toContain(SHORT_SID);
    expect(JSON.parse(baseline).login.headers["set-cookie"]).toBe(
      "sid=***; Path=/; HttpOnly, fmt=***; Path=/",
    );

    // 応答が変わって不一致になったときの候補・差分・履歴にも生の値は出ない
    state.version = "2";
    const second = await run(flow);
    expect(second.result.status).toBe("failed");
    const assertion = second.result.steps[0]?.assertions[0];
    expect(assertion?.snapshot?.state).toBe("mismatch");
    expect(JSON.stringify(second.result.steps[0]?.assertions)).not.toContain(SHORT_SID);
    expect(JSON.stringify(second.entries)).not.toContain(SHORT_SID);
    expect(JSON.stringify(first.entries)).not.toContain(SHORT_SID);
  });

  it("replay はカセットのマスク済み Set-Cookie でも動き、jar は *** を保存しても壊れない", async () => {
    await setup();
    const flow = flowSchema.parse({
      name: "replay",
      http: { cookies: true },
      steps: [
        {
          name: "login",
          request: { method: "GET", url: `${baseUrl}/login-short` },
          capture: { raw: { header: "set-cookie" } },
          assert: { status: 200 },
        },
        {
          name: "me",
          request: { method: "GET", url: `${baseUrl}/plain` },
          assert: { status: 200, body: [{ path: "$.accept", exists: true }] },
        },
      ],
    });
    const recorded = await run(flow, { recording: { mode: "record", dir: cassetteDir } });
    expect(recorded.result.status).toBe("passed");
    seen.length = 0;
    const replayed = await run(flow, { recording: { mode: "replay", dir: cassetteDir } });
    expect(replayed.result.status).toBe("passed");
    // 実ネットワークへは出ない。再生された Set-Cookie はマスク済み
    expect(seen).toHaveLength(0);
    expect(replayed.result.steps[0]?.response?.headers["set-cookie"]).toBe(
      "sid=***; Path=/; HttpOnly, fmt=***; Path=/",
    );
  });

  it("値が content-type と同じ長い cookie 値でも、record したカセットの content-type は壊れず replay できる", async () => {
    await setup();
    const flow = flowSchema.parse({
      name: "ct",
      steps: [
        {
          name: "login",
          request: { method: "GET", url: `${baseUrl}/login-ct` },
          assert: { status: 200, body: [{ path: "$.ok", equals: true }] },
        },
      ],
    });
    const recorded = await run(flow, { recording: { mode: "record", dir: cassetteDir } });
    expect(recorded.result.status).toBe("passed");
    // cookie 値(application/json)が秘密値として登録されても、構造的ヘッダーはそのまま記録する
    expect(recorded.secrets).toContain("application/json");
    const entry = JSON.parse((await readFile(cassetteFilePath(cassetteDir), "utf-8")).trim());
    expect(entry.headers["content-type"]).toBe("application/json");
    expect(entry.headers["set-cookie"]).toBe("ct=***; Path=/");
    // replay は本文を JSON として読めるので、body アサーションも通る
    const replayed = await run(flow, { recording: { mode: "replay", dir: cassetteDir } });
    expect(replayed.result.status).toBe("passed");
    expect(replayed.result.steps[0]?.response?.body).toEqual({ ok: true });
  });

  it("構造的ヘッダーに env の秘密値が含まれるときは、カセットでもマスクされたまま残る", async () => {
    await setup();
    const KEY = "KLAUS_TEST_CT_SECRET";
    process.env[KEY] = "env-secret-ct-value-9876";
    try {
      const flow = flowSchema.parse({
        name: "snap",
        steps: [
          {
            name: "echo",
            request: {
              method: "GET",
              url: `${baseUrl}/ct-echo`,
              headers: { "X-Token": `{{env.${KEY}}}` },
            },
            assert: { status: 200 },
          },
        ],
      });
      const recorded = await run(flow, { recording: { mode: "record", dir: cassetteDir } });
      expect(recorded.result.status).toBe("passed");
      const raw = await readFile(cassetteFilePath(cassetteDir), "utf-8");
      expect(raw).not.toContain("env-secret-ct-value-9876");
      const entry = JSON.parse(raw.trim());
      expect(entry.headers["content-type"]).toBe("text/plain; note=***");
    } finally {
      delete process.env[KEY];
    }
  });

  describe("capture した Set-Cookie を別の場所に入れても、長い cookie 値は秘密値として登録されている", () => {
    const leakFlow = (login: string) =>
      flowSchema.parse({
        name: "leak",
        steps: [
          {
            name: "login",
            request: { method: "GET", url: `${baseUrl}/${login}` },
            capture: { sc: { header: "set-cookie" } },
          },
          {
            name: "reuse",
            request: {
              method: "POST",
              url: `${baseUrl}/plain?x={{sc}}`,
              headers: { "X-Session": "{{sc}}" },
              body: { s: "{{sc}}" },
            },
            assert: { status: 200 },
          },
        ],
      });

    it("jar なしでも、履歴・カセット・html / github レポート・promote の出力に 20 文字以上の値が残らない", async () => {
      await setup();
      const flow = leakFlow("login-long");
      const { result, entries, secrets } = await run(flow, {
        recording: { mode: "record", dir: cassetteDir },
      });
      expect(result.status).toBe("passed");
      expect(secrets).toContain(LONG_SID);
      // 変数そのものは生のまま使える(フィクスチャは本物の値を受け取る)
      expect(seen.find((x) => x.path.startsWith("/plain?"))?.path).toContain(
        "sess-0123456789abcdef",
      );

      expect(JSON.stringify(entries)).not.toContain(LONG_SID);
      expect(JSON.stringify(entries[1]?.request)).toContain("***");
      expect(await readFile(cassetteFilePath(cassetteDir), "utf-8")).not.toContain(LONG_SID);

      const runResult = {
        runId: "r",
        startedAt: "2026-11-15T00:00:00.000Z",
        durationMs: 1,
        status: "passed" as const,
        flows: [result],
      };
      expect(formatHtml(runResult, { secrets })).not.toContain(LONG_SID);
      expect(formatGithubSummary(runResult, { secrets })).not.toContain(LONG_SID);
      expect(formatGithubAnnotations(runResult, { secrets }).join("\n")).not.toContain(LONG_SID);

      const outcome = promoteRuns([{ runId: "r", entries }], { assert: "status", chain: false });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(renderPromotedYaml(outcome.result, ["r"])).not.toContain(LONG_SID);
      }
    });

    it("16 文字未満の値は登録せず、従来どおり Cookie / Set-Cookie ヘッダー内の位置マスクだけ", async () => {
      await setup();
      const { result, entries, secrets } = await run(leakFlow("login-short"));
      expect(result.status).toBe("passed");
      expect(secrets).not.toContain(SHORT_SID);
      expect(entries[0]?.response?.headers["set-cookie"]).toBe(
        "sid=***; Path=/; HttpOnly, fmt=***; Path=/",
      );
    });
  });

  describe("jar の cookie 値(16 文字以上)は秘密値として登録する", () => {
    it("長い値が JSON ボディ・他のヘッダーにエコーされても、履歴・スナップショット・カセットで ***", async () => {
      await setup();
      const flow = flowSchema.parse({
        name: "long",
        http: { cookies: true },
        steps: [
          { name: "login", request: { method: "GET", url: `${baseUrl}/login-long` } },
          {
            name: "echo",
            request: { method: "GET", url: `${baseUrl}/echo` },
            assert: {
              snapshot: { include: ["status", "headers", "body"], headers: ["x-session-echo"] },
            },
          },
          {
            name: "echo-fail",
            request: { method: "GET", url: `${baseUrl}/echo` },
            assert: { body: [{ path: "$.session", equals: "other" }] },
          },
        ],
      });
      const { result, entries, secrets } = await run(flow, {
        recording: { mode: "record", dir: cassetteDir },
      });
      expect(result.steps[1]?.status).toBe("passed");
      expect(result.steps[2]?.status).toBe("failed");
      expect(secrets).toContain(LONG_SID);
      // 実行時のレスポンスは本物(エコーされた値)
      expect(result.steps[1]?.response?.body).toMatchObject({ session: LONG_SID });

      const historyText = JSON.stringify(entries);
      expect(historyText).not.toContain(LONG_SID);
      expect(entries[1]?.response?.body).toMatchObject({ session: "***" });
      expect(entries[1]?.response?.headers["X-Session-Echo"] ?? "").not.toContain(LONG_SID);
      // 失敗したアサーションのメッセージにも残らない
      expect(entries[2]?.assertions[0]?.message).toContain('but got "***"');

      const baseline = await readFile(snapFile(), "utf-8");
      expect(baseline).not.toContain(LONG_SID);
      expect(JSON.parse(baseline).echo.body.session).toBe("***");
      expect(JSON.parse(baseline).echo.headers["x-session-echo"]).toBe("***");

      const cassette = await readFile(cassetteFilePath(cassetteDir), "utf-8");
      expect(cassette).not.toContain(LONG_SID);
      expect(cassette).toContain('\\"session\\":\\"***\\"');
    });

    it("短い値(json)は秘密値にせず、Accept・content-type・本文を壊さない(履歴・スナップショット・カセット)", async () => {
      await setup();
      const flow = flowSchema.parse({
        name: "short",
        http: { cookies: true },
        steps: [
          { name: "login", request: { method: "GET", url: `${baseUrl}/login-short` } },
          {
            name: "api",
            request: {
              method: "GET",
              url: `${baseUrl}/echo`,
              headers: { Accept: "application/json" },
            },
            assert: {
              headers: [{ name: "content-type", contains: "json" }],
              snapshot: { include: ["status", "headers", "body"], headers: ["content-type"] },
            },
          },
        ],
      });
      const { result, entries, secrets } = await run(flow, {
        recording: { mode: "record", dir: cassetteDir },
      });
      expect(result.steps[1]?.status).toBe("passed");
      expect(secrets).not.toContain("json");
      expect(entries[1]?.request?.headers.Accept).toBe("application/json");
      expect(entries[1]?.response?.headers["content-type"]).toBe("application/json");
      expect(entries[1]?.response?.body).toMatchObject({ accept: "application/json" });

      const baseline = JSON.parse(await readFile(snapFile(), "utf-8"));
      expect(baseline.api.headers["content-type"]).toBe("application/json");
      expect(baseline.api.body.accept).toBe("application/json");

      const cassette = (await readFile(cassetteFilePath(cassetteDir), "utf-8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(cassette[1].headers["content-type"]).toBe("application/json");
      expect(JSON.parse(cassette[1].bodyText).accept).toBe("application/json");
    });

    it("capture: {cookie} で取り出した短い値(json)も秘密値にせず出力を壊さない。長い値は登録する", async () => {
      await setup();
      const flow = flowSchema.parse({
        name: "capture",
        http: { cookies: true },
        steps: [
          {
            name: "login",
            request: { method: "GET", url: `${baseUrl}/login-long` },
            capture: { fmt: { cookie: "fmt" }, sid: { cookie: "sid" } },
          },
          {
            name: "api",
            request: {
              method: "GET",
              url: `${baseUrl}/echo`,
              headers: { Accept: "application/json", "X-Fmt": "{{fmt}}", "X-Sid": "{{sid}}" },
            },
            assert: { status: 200 },
          },
        ],
      });
      const { result, entries, secrets } = await run(flow, {
        recording: { mode: "record", dir: cassetteDir },
      });
      expect(result.status).toBe("passed");
      expect(secrets).not.toContain("json");
      expect(secrets).toContain(LONG_SID);
      expect(entries[1]?.request?.headers.Accept).toBe("application/json");
      expect(entries[1]?.request?.headers["X-Fmt"]).toBe("json");
      expect(entries[1]?.request?.headers["X-Sid"]).toBe("***");
      expect(entries[1]?.response?.headers["content-type"]).toBe("application/json");
      const cassette = await readFile(cassetteFilePath(cassetteDir), "utf-8");
      expect(cassette).not.toContain(LONG_SID);
      expect(cassette).toContain("application/json");
    });
  });
});
