import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getHistoryPage, readAllHistoryEntries } from "../src/core/history-query.js";

const tmpRoot = join(process.cwd(), "tmp");

/** entries を JSON Lines として1ファイルに書き込む(行は書いた順=古い→新しいとみなす) */
async function writeHistoryFile(cwd: string, fileName: string, lines: unknown[]): Promise<void> {
  const dir = join(cwd, ".klaus", "history");
  await mkdir(dir, { recursive: true });
  const content = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  await writeFile(join(dir, fileName), content, "utf-8");
}

function entry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1,
    runId: "run-1",
    flow: "sample flow",
    step: "step",
    startedAt: "2026-08-07T00:00:00.000Z",
    durationMs: 1,
    assertions: [],
    ...overrides,
  };
}

describe("getHistoryPage / readAllHistoryEntries", () => {
  let dir: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-history-query-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("履歴が無いディレクトリでは空配列を返す", async () => {
    const page = await getHistoryPage(dir, {});
    expect(page.entries).toEqual([]);
    expect(page.nextBefore).toBeUndefined();
  });

  it("ファイル名降順 x ファイル内行逆順で新しい順に読み出す", async () => {
    await writeHistoryFile(dir, "2026-08-07.jsonl", [
      entry({ step: "a", startedAt: "2026-08-07T00:00:00.000Z" }),
      entry({ step: "b", startedAt: "2026-08-07T00:00:01.000Z" }),
    ]);
    await writeHistoryFile(dir, "2026-08-08.jsonl", [
      entry({ step: "c", startedAt: "2026-08-08T00:00:00.000Z" }),
    ]);

    const entries = await readAllHistoryEntries(dir);

    // 新しい日付ファイル(08-08)が先、同一ファイル内は逆順(b が a より先)
    expect(entries.map((e) => e.step)).toEqual(["c", "b", "a"]);
  });

  it("壊れた JSON 行と未知の v の行をスキップする", async () => {
    const dirPath = join(dir, ".klaus", "history");
    await mkdir(dirPath, { recursive: true });
    const raw = `${JSON.stringify(entry({ step: "ok" }))}\nnot-json\n${JSON.stringify({ v: 2, step: "unknown-version" })}\n`;
    await writeFile(join(dirPath, "2026-08-07.jsonl"), raw, "utf-8");

    const entries = await readAllHistoryEntries(dir);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.step).toBe("ok");
  });

  it("flow で完全一致フィルタする", async () => {
    await writeHistoryFile(dir, "2026-08-07.jsonl", [
      entry({ flow: "flow-a", step: "a" }),
      entry({ flow: "flow-b", step: "b" }),
    ]);

    const page = await getHistoryPage(dir, { flow: "flow-a" });

    expect(page.entries.map((e) => e.step)).toEqual(["a"]);
  });

  it("before より startedAt が小さいエントリのみに絞り込む(文字列比較)", async () => {
    await writeHistoryFile(dir, "2026-08-07.jsonl", [
      entry({ step: "early", startedAt: "2026-08-07T00:00:00.000Z" }),
      entry({ step: "late", startedAt: "2026-08-07T00:00:02.000Z" }),
    ]);

    const page = await getHistoryPage(dir, { before: "2026-08-07T00:00:01.000Z" });

    expect(page.entries.map((e) => e.step)).toEqual(["early"]);
  });

  it("failed: true で status が failed のエントリのみに絞り込む", async () => {
    await writeHistoryFile(dir, "2026-08-07.jsonl", [
      entry({ step: "passed-step", status: "passed" }),
      entry({ step: "failed-step", status: "failed" }),
      entry({ step: "skipped-step", status: "skipped" }),
    ]);

    const page = await getHistoryPage(dir, { failed: true });

    expect(page.entries.map((e) => e.step)).toEqual(["failed-step"]);
  });

  it("failed: true は status フィールドが無い旧エントリも assertions から導出して判定する", async () => {
    await writeHistoryFile(dir, "2026-08-07.jsonl", [
      entry({
        step: "legacy-failed",
        assertions: [{ ok: false, kind: "status", expected: 200, actual: 500, message: "ng" }],
      }),
      entry({
        step: "legacy-passed",
        assertions: [{ ok: true, kind: "status", expected: 200, actual: 200, message: "ok" }],
      }),
    ]);

    const page = await getHistoryPage(dir, { failed: true });

    expect(page.entries.map((e) => e.step)).toEqual(["legacy-failed"]);
  });

  it("limit のデフォルトは50件", async () => {
    const lines = Array.from({ length: 60 }, (_, i) =>
      entry({
        step: `step-${i}`,
        startedAt: `2026-08-07T00:00:${String(i).padStart(2, "0")}.000Z`,
      }),
    );
    await writeHistoryFile(dir, "2026-08-07.jsonl", lines);

    const page = await getHistoryPage(dir, {});

    expect(page.entries).toHaveLength(50);
    expect(page.nextBefore).toBeDefined();
  });

  it("limit を明示指定すると nextBefore が最後のエントリの startedAt になる", async () => {
    await writeHistoryFile(dir, "2026-08-07.jsonl", [
      entry({ step: "a", startedAt: "2026-08-07T00:00:00.000Z" }),
      entry({ step: "b", startedAt: "2026-08-07T00:00:01.000Z" }),
      entry({ step: "c", startedAt: "2026-08-07T00:00:02.000Z" }),
    ]);

    const page = await getHistoryPage(dir, { limit: 2 });

    expect(page.entries.map((e) => e.step)).toEqual(["c", "b"]);
    expect(page.nextBefore).toBe("2026-08-07T00:00:01.000Z");
  });

  it("limit ちょうどで件数が収まる場合 nextBefore は undefined", async () => {
    await writeHistoryFile(dir, "2026-08-07.jsonl", [entry({ step: "a" }), entry({ step: "b" })]);

    const page = await getHistoryPage(dir, { limit: 2 });

    expect(page.entries).toHaveLength(2);
    expect(page.nextBefore).toBeUndefined();
  });

  describe("--jobs>1 による完了順追記(ファイル内行順 != startedAt 順)", () => {
    // 実行完了順に追記されたことを模して、意図的に startedAt の昇順とは異なる行順で書く
    const outOfOrderLines = [
      entry({ step: "s2", startedAt: "2026-08-07T00:00:02.000Z" }),
      entry({ step: "s0", startedAt: "2026-08-07T00:00:00.000Z" }),
      entry({ step: "s4", startedAt: "2026-08-07T00:00:04.000Z" }),
      entry({ step: "s1", startedAt: "2026-08-07T00:00:01.000Z" }),
      entry({ step: "s3", startedAt: "2026-08-07T00:00:03.000Z" }),
    ];

    it("readAllHistoryEntries は行の追記順によらず startedAt 降順(新しい順)で返す", async () => {
      await writeHistoryFile(dir, "2026-08-07.jsonl", outOfOrderLines);

      const entries = await readAllHistoryEntries(dir);

      expect(entries.map((e) => e.step)).toEqual(["s4", "s3", "s2", "s1", "s0"]);
    });

    it("limit + before によるページングが、行の追記順によらず欠落・重複なく全件を復元できる", async () => {
      await writeHistoryFile(dir, "2026-08-07.jsonl", outOfOrderLines);

      const seenSteps: string[] = [];
      let before: string | undefined;
      // limit を小さくし、複数ページに跨って before カーソルを渡す(完了順追記でも
      // 正しく1件ずつ、スキップ・重複なく取得できることを検証する)
      for (let i = 0; i < outOfOrderLines.length; i++) {
        const page = await getHistoryPage(dir, { limit: 2, before });
        for (const e of page.entries) seenSteps.push(e.step);
        if (!page.nextBefore) break;
        before = page.nextBefore;
      }

      // 欠落・重複なく、新しい順の全件と一致する(union が全体集合と一致することを確認)
      expect(seenSteps).toEqual(["s4", "s3", "s2", "s1", "s0"]);
      expect(new Set(seenSteps).size).toBe(outOfOrderLines.length);
    });

    it(
      "startedAt が同一のエントリは before カーソル境界を跨ぐと欠落しうる(既存の `<` 厳密比較カーソルの" +
        "既知の限界であり、本修正のスコープ外。並び順の安定ソートにより取りこぼす2件の相対順序自体は決定的になる)",
      async () => {
        await writeHistoryFile(dir, "2026-08-07.jsonl", [
          entry({ step: "tie-a", startedAt: "2026-08-07T00:00:01.000Z" }),
          entry({ step: "tie-b", startedAt: "2026-08-07T00:00:01.000Z" }),
        ]);

        // limit: 1 でページングすると、1ページ目でどちらか1件のみ返り(安定ソートにより
        // ファイル内行順の逆順 = tie-b が先になる)、before はその startedAt(もう一方と同一)
        // になるため、2ページ目は `startedAt < before` の厳密比較によりもう一方を取りこぼす
        const firstPage = await getHistoryPage(dir, { limit: 1 });
        expect(firstPage.entries.map((e) => e.step)).toEqual(["tie-b"]);
        expect(firstPage.nextBefore).toBe("2026-08-07T00:00:01.000Z");

        const secondPage = await getHistoryPage(dir, {
          limit: 1,
          before: firstPage.nextBefore,
        });
        expect(secondPage.entries).toEqual([]); // tie-a が既知の限界により取りこぼされる
      },
    );
  });
});
