import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendHistory, historyFilePath } from "../src/core/history.js";

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
