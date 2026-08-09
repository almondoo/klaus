import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { historyListCommand, historyShowCommand } from "../../src/cli/history.js";

const projectRoot = join(__dirname, "..", "..");
const tmpRoot = join(projectRoot, "tmp");

/** 1 run 目(run-2)の1ステップ。他の2件より startedAt が早い */
const ENTRY_PING = {
  v: 1,
  runId: "run-2",
  flow: "other flow",
  step: "ping",
  startedAt: "2026-08-08T09:00:00.000Z",
  durationMs: 1,
  status: "passed",
  request: { method: "GET", url: "http://localhost/ping", headers: {} },
  response: { status: 200, headers: {}, body: null },
  assertions: [],
};

/** run-1(auth flow)の1ステップ目 */
const ENTRY_LOGIN = {
  v: 1,
  runId: "run-1",
  flow: "auth flow",
  step: "login",
  startedAt: "2026-08-08T10:00:00.000Z",
  durationMs: 10,
  status: "passed",
  request: { method: "GET", url: "http://localhost/login", headers: {} },
  response: { status: 200, headers: {}, body: { ok: true } },
  assertions: [{ ok: true, kind: "status", expected: 200, actual: 200, message: "status is 200" }],
};

/** run-1(auth flow)の2ステップ目(failed) */
const ENTRY_GET_ME = {
  v: 1,
  runId: "run-1",
  flow: "auth flow",
  step: "get-me",
  startedAt: "2026-08-08T10:00:01.000Z",
  durationMs: 5,
  status: "failed",
  request: { method: "GET", url: "http://localhost/me", headers: {} },
  response: { status: 200, headers: {}, body: { email: "b@example.com" } },
  assertions: [
    {
      ok: false,
      kind: "body",
      expected: "a@example.com",
      actual: "b@example.com",
      message: "mismatch",
    },
  ],
};

// jsonl への書き込み順は実運用の追記順(startedAt 昇順)に合わせる
// (readAllHistoryEntries はファイル内の行を単純に反転して新しい順にするだけで、
//  startedAt で再ソートはしないため)
const FIXTURE_LINES = [ENTRY_PING, ENTRY_LOGIN, ENTRY_GET_ME];

describe("historyListCommand / historyShowCommand", () => {
  let workDir: string;
  let stdoutSpy: string[];
  let stderrSpy: string[];
  let stdoutWrite: typeof process.stdout.write;
  let stderrWrite: typeof process.stderr.write;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    workDir = await mkdtemp(join(tmpRoot, "klaus-history-cli-"));
    const historyDir = join(workDir, ".klaus", "history");
    await mkdir(historyDir, { recursive: true });
    const content = `${FIXTURE_LINES.map((line) => JSON.stringify(line)).join("\n")}\n`;
    await writeFile(join(historyDir, "2026-08-08.jsonl"), content, "utf-8");

    stdoutSpy = [];
    stderrSpy = [];
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutSpy.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrSpy.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    await rm(workDir, { recursive: true, force: true });
  });

  describe("historyListCommand", () => {
    it("デフォルトフィールドで新しい順に一覧を JSON 出力する", async () => {
      const exitCode = await historyListCommand(
        { last: 20, fields: "startedAt,runId,flow,step,status,durationMs", json: true },
        workDir,
      );

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdoutSpy.join("").trim()) as Array<Record<string, unknown>>;
      expect(output.map((e) => e.step)).toEqual(["get-me", "login", "ping"]);
      expect(output[0]).toEqual({
        startedAt: "2026-08-08T10:00:01.000Z",
        runId: "run-1",
        flow: "auth flow",
        step: "get-me",
        status: "failed",
        durationMs: 5,
      });
      // デフォルトフィールドに request/response のボディは含まれない
      expect(output[0]?.request).toBeUndefined();
      expect(output[0]?.response).toBeUndefined();
    });

    it("--fields で指定したフィールドのみを出力する(request 等も明示指定すれば含められる)", async () => {
      await historyListCommand({ last: 20, fields: "step,request", json: true }, workDir);

      const output = JSON.parse(stdoutSpy.join("").trim()) as Array<Record<string, unknown>>;
      expect(Object.keys(output[0] as object).sort()).toEqual(["request", "step"]);
      expect((output[0] as { request: { method: string } }).request.method).toBe("GET");
    });

    it("--failed で status が failed のエントリのみに絞り込む", async () => {
      await historyListCommand(
        { last: 20, fields: "step,status", failed: true, json: true },
        workDir,
      );

      const output = JSON.parse(stdoutSpy.join("").trim()) as Array<Record<string, unknown>>;
      expect(output).toEqual([{ step: "get-me", status: "failed" }]);
    });

    it("--flow でフロー名の完全一致フィルタをかける", async () => {
      await historyListCommand(
        { last: 20, fields: "step", flow: "other flow", json: true },
        workDir,
      );

      const output = JSON.parse(stdoutSpy.join("").trim()) as Array<Record<string, unknown>>;
      expect(output).toEqual([{ step: "ping" }]);
    });

    it("--last で取得件数を絞り込む", async () => {
      await historyListCommand({ last: 1, fields: "step", json: true }, workDir);

      const output = JSON.parse(stdoutSpy.join("").trim()) as Array<Record<string, unknown>>;
      expect(output).toEqual([{ step: "get-me" }]);
    });

    it("TTY 実行時は簡潔なテキスト表を出力する(--json 未指定)", async () => {
      const originalIsTTY = process.stdout.isTTY;
      process.stdout.isTTY = true;
      try {
        await historyListCommand({ last: 20, fields: "step,status" }, workDir);
      } finally {
        process.stdout.isTTY = originalIsTTY;
      }

      const output = stdoutSpy.join("");
      const lines = output.trim().split("\n");
      expect(lines[0]).toBe("step    status");
      expect(lines).toContain("get-me  failed");
    });
  });

  describe("historyShowCommand", () => {
    it("runId が一致する全エントリを実行順(startedAt 昇順)の JSON で出力する", async () => {
      const exitCode = await historyShowCommand("run-1", {}, workDir);

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdoutSpy.join("").trim()) as Array<Record<string, unknown>>;
      expect(output.map((e) => e.step)).toEqual(["login", "get-me"]);
      // 保存されたままの形(v・assertions を含む全フィールド)で出力される
      expect(output[0]?.v).toBe(1);
      expect(output[1]?.assertions).toEqual(ENTRY_GET_ME.assertions);
    });

    it("--step で該当 runId 内のステップをさらに絞り込む", async () => {
      const exitCode = await historyShowCommand("run-1", { step: "get-me" }, workDir);

      expect(exitCode).toBe(0);
      const output = JSON.parse(stdoutSpy.join("").trim()) as Array<Record<string, unknown>>;
      expect(output.map((e) => e.step)).toEqual(["get-me"]);
    });

    it("該当エントリが無い場合は stderr にメッセージを出して exit 1", async () => {
      const exitCode = await historyShowCommand("run-missing", {}, workDir);

      expect(exitCode).toBe(1);
      expect(stdoutSpy.join("")).toBe("");
      expect(stderrSpy.join("")).toContain('no history entries found for runId "run-missing"');
    });

    it("runId は一致するが --step に一致するエントリが無い場合も exit 1", async () => {
      const exitCode = await historyShowCommand("run-1", { step: "not-a-step" }, workDir);

      expect(exitCode).toBe(1);
      expect(stderrSpy.join("")).toContain("run-1");
      expect(stderrSpy.join("")).toContain("not-a-step");
    });
  });
});
