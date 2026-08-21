import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { historyListCommand, historyShowCommand } from "../../src/cli/history.js";
import { sanitizeForTerminal } from "../../src/cli/reporters/sanitize.js";

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

    it("テキスト表では数値・配列のセルもそれぞれ文字列化される(formatCell の分岐)", async () => {
      const originalIsTTY = process.stdout.isTTY;
      process.stdout.isTTY = true;
      try {
        await historyListCommand({ last: 20, fields: "step,durationMs,assertions" }, workDir);
      } finally {
        process.stdout.isTTY = originalIsTTY;
      }

      const output = stdoutSpy.join("");
      const getMeRow = output
        .trim()
        .split("\n")
        .find((line) => line.startsWith("get-me"));
      // durationMs(数値)はそのまま文字列化される
      expect(getMeRow).toContain("5");
      // assertions(配列)は compact JSON 文字列化される
      expect(getMeRow).toContain(JSON.stringify(ENTRY_GET_ME.assertions));
    });
  });

  describe("historyListCommand: 制御文字のサニタイズ", () => {
    /** flow/step に ANSI エスケープと改行を仕込んだ悪性エントリ */
    const ENTRY_MALICIOUS = {
      v: 1,
      runId: "run-3",
      flow: "evil\x1b[32mPASS fake\x1b[0m",
      step: "step\nPASS injected\r\x07",
      startedAt: "2026-08-08T11:00:00.000Z",
      durationMs: 3,
      status: "passed",
      request: { method: "GET", url: "http://localhost/evil", headers: {} },
      response: { status: 200, headers: {}, body: null },
      assertions: [],
    };
    let maliciousWorkDir: string;

    beforeEach(async () => {
      const historyDir = join(workDir, ".klaus", "history");
      await writeFile(
        join(historyDir, "2026-08-08-malicious.jsonl"),
        `${JSON.stringify(ENTRY_MALICIOUS)}\n`,
        "utf-8",
      );
      maliciousWorkDir = workDir;
    });

    it("テキスト表では flow/step の制御文字が可視エスケープに変換され、列幅も崩れない", async () => {
      const originalIsTTY = process.stdout.isTTY;
      process.stdout.isTTY = true;
      try {
        await historyListCommand(
          { last: 20, fields: "flow,step", flow: ENTRY_MALICIOUS.flow },
          maliciousWorkDir,
        );
      } finally {
        process.stdout.isTTY = originalIsTTY;
      }

      const output = stdoutSpy.join("");
      // 表は行区切りに本物の改行(\n = 0x0A)を使うため、制御バイト不在の検証は
      // 行に分割してから各行の「中身」に対して行う(改行そのものは判定対象に含めない)
      const lines = output.trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: 生の制御バイトが残っていないことを検証する意図的な正規表現
        expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
      }
      expect(output).toContain("\\x1B[32m");
      expect(output).toContain("\\n");
      expect(output).toContain("\\r");
      expect(output).toContain("\\x07");

      // 列幅はサニタイズ後のセル文字列から計算されているため、ヘッダーとデータ行の
      // 対応する列は同じ長さに揃う(サニタイズ前の長さで幅計算するとここがずれる)
      const flowCell = sanitizeForTerminal(ENTRY_MALICIOUS.flow);
      const stepCell = sanitizeForTerminal(ENTRY_MALICIOUS.step);
      const flowWidth = Math.max("flow".length, flowCell.length);
      const stepWidth = Math.max("step".length, stepCell.length);
      expect(lines[0]).toBe(`${"flow".padEnd(flowWidth)}  ${"step".padEnd(stepWidth)}`);
      expect(lines[1]).toBe(
        `${flowCell.padEnd(flowWidth)}  ${stepCell.padEnd(stepWidth)}`.trimEnd(),
      );
    });

    it("JSON モードでは flow/step がサニタイズされず生の値のまま出力される", async () => {
      await historyListCommand(
        { last: 20, fields: "flow,step", flow: ENTRY_MALICIOUS.flow, json: true },
        maliciousWorkDir,
      );

      const output = JSON.parse(stdoutSpy.join("").trim()) as Array<Record<string, unknown>>;
      expect(output).toEqual([{ flow: ENTRY_MALICIOUS.flow, step: ENTRY_MALICIOUS.step }]);
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
