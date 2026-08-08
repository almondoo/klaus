import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendHistory, historyFilePath, maskHistoryEntry } from "../src/core/history.js";

describe("history", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-history-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("historyFilePath は .klaus/history/<YYYY-MM-DD>.jsonl を返す", () => {
    const date = new Date("2026-08-07T12:00:00Z");
    expect(historyFilePath(dir, date)).toBe(join(dir, ".klaus", "history", "2026-08-07.jsonl"));
  });

  it("ディレクトリが無くても自動作成して1行追記する", async () => {
    await appendHistory(dir, {
      v: 1,
      runId: "run-1",
      flow: "sample flow",
      step: "step1",
      startedAt: "2026-08-07T12:00:00.000Z",
      durationMs: 42,
      request: { method: "GET", url: "http://localhost/x", headers: {} },
      response: { status: 200, headers: {}, body: { ok: true } },
      assertions: [
        { ok: true, kind: "status", expected: 200, actual: 200, message: "status is 200" },
      ],
    });

    // appendHistory は実行時点の日付ファイルに書くため、読み出しも引数なし(= 今日)で解決する
    const filePath = historyFilePath(dir);
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.v).toBe(1);
    expect(parsed.runId).toBe("run-1");
    expect(parsed.flow).toBe("sample flow");
    expect(parsed.response.status).toBe(200);
  });

  it("request/response を省略した skipped 相当のエントリも追記できる", async () => {
    await appendHistory(dir, {
      v: 1,
      runId: "run-1",
      flow: "sample flow",
      step: "skipped-step",
      startedAt: "2026-08-07T12:00:00.000Z",
      durationMs: 0,
      status: "skipped",
      assertions: [],
    });

    const filePath = historyFilePath(dir);
    const content = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.status).toBe("skipped");
    expect(parsed.request).toBeUndefined();
    expect(parsed.response).toBeUndefined();
  });

  it("複数回追記すると行が積み重なる(1ステップ=1行)", async () => {
    for (let i = 0; i < 3; i += 1) {
      await appendHistory(dir, {
        v: 1,
        runId: "run-1",
        flow: "sample flow",
        step: `step${i}`,
        startedAt: new Date().toISOString(),
        durationMs: 1,
        request: { method: "GET", url: "http://localhost/x", headers: {} },
        response: { status: 200, headers: {}, body: null },
        assertions: [],
      });
    }

    const filePath = historyFilePath(dir);
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
  });
});

describe("maskHistoryEntry", () => {
  const base = {
    v: 1 as const,
    runId: "run-1",
    flow: "sample flow",
    step: "step1",
    startedAt: "2026-08-07T12:00:00.000Z",
    durationMs: 1,
    status: "passed" as const,
    assertions: [],
  };

  it("request/response の url・headers・body に含まれる秘密情報を *** に置換する", () => {
    const entry = {
      ...base,
      request: {
        method: "GET",
        url: "http://localhost/x?token=secret-token-1",
        headers: { Authorization: "Bearer secret-token-1" },
        body: { password: "secret-token-1" },
      },
      response: {
        status: 200,
        headers: { "X-Echo": "secret-token-1" },
        body: { echoed: "secret-token-1", ok: true },
      },
    };

    const masked = maskHistoryEntry(entry, ["secret-token-1"]);
    expect(masked.request?.url).toBe("http://localhost/x?token=***");
    expect(masked.request?.headers.Authorization).toBe("Bearer ***");
    expect(masked.request?.body).toEqual({ password: "***" });
    expect(masked.response?.headers["X-Echo"]).toBe("***");
    expect(masked.response?.body).toEqual({ echoed: "***", ok: true });
  });

  it("4文字未満の値はマスクしない", () => {
    const entry = {
      ...base,
      request: {
        method: "GET",
        url: "http://localhost/x",
        headers: { "X-Short": "abc" },
      },
    };

    const masked = maskHistoryEntry(entry, ["abc"]);
    expect(masked.request?.headers["X-Short"]).toBe("abc");
  });

  it("events の data も秘密情報をマスクする", () => {
    const entry = {
      ...base,
      events: [{ event: "message", data: '{"token":"secret-token-1"}' }],
    };

    const masked = maskHistoryEntry(entry, ["secret-token-1"]);
    expect(masked.events?.[0]?.data).toBe('{"token":"***"}');
  });

  it("events の id・event フィールドも秘密情報をマスクする", () => {
    const entry = {
      ...base,
      events: [{ event: "secret-token-1", id: "secret-token-1", data: "secret-token-1" }],
    };

    const masked = maskHistoryEntry(entry, ["secret-token-1"]);
    expect(masked.events?.[0]?.event).toBe("***");
    expect(masked.events?.[0]?.id).toBe("***");
    expect(masked.events?.[0]?.data).toBe("***");
  });

  it("assertions の expected・actual・message に含まれる秘密情報をマスクする(元の配列は変更しない)", () => {
    const assertions = [
      {
        ok: false,
        kind: "header.equals",
        expected: "Bearer secret-token-1",
        actual: "Bearer wrong-value",
        message:
          'header "Authorization": expected "Bearer secret-token-1" but got "Bearer wrong-value"',
      },
    ];
    const entry = { ...base, assertions };

    const masked = maskHistoryEntry(entry, ["secret-token-1"]);
    expect(masked.assertions[0]?.expected).toBe("Bearer ***");
    expect(masked.assertions[0]?.actual).toBe("Bearer wrong-value");
    expect(masked.assertions[0]?.message).toBe(
      'header "Authorization": expected "Bearer ***" but got "Bearer wrong-value"',
    );
    // 元の配列・要素は変更されない(StepResult と共有しているため)
    expect(assertions[0]?.expected).toBe("Bearer secret-token-1");
  });

  it("assertions の expected・actual がオブジェクト/配列でも深く辿ってマスクする", () => {
    const assertions = [
      {
        ok: true,
        kind: "body.equals",
        expected: { token: "secret-token-1" },
        actual: ["secret-token-1", "other"],
        message: "body matches",
      },
    ];
    const entry = { ...base, assertions };

    const masked = maskHistoryEntry(entry, ["secret-token-1"]);
    expect(masked.assertions[0]?.expected).toEqual({ token: "***" });
    expect(masked.assertions[0]?.actual).toEqual(["***", "other"]);
  });

  it("secrets が空配列の場合は entry をそのまま返す", () => {
    const entry = {
      ...base,
      request: {
        method: "GET",
        url: "http://localhost/x",
        headers: {},
      },
    };

    expect(maskHistoryEntry(entry, [])).toBe(entry);
  });

  it("request/response が省略された(skipped)エントリはそのまま扱える", () => {
    const entry = { ...base, status: "skipped" as const };

    const masked = maskHistoryEntry(entry, ["secret-token-1"]);
    expect(masked.request).toBeUndefined();
    expect(masked.response).toBeUndefined();
  });
});
