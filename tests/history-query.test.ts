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

  describe("新しいファイルからの早期打ち切り", () => {
    /** 早期打ち切り前の実装(全件読み込み → 安定ソート → フィルタ → slice)と同じ手順で期待値を作る */
    async function referencePage(
      cwd: string,
      query: { flow?: string; limit?: number; before?: string; failed?: boolean },
    ) {
      const limit = query.limit && query.limit > 0 ? query.limit : 50;
      let all = await readAllHistoryEntries(cwd);
      if (query.flow) all = all.filter((e) => e.flow === query.flow);
      if (query.before) {
        const before = query.before;
        all = all.filter((e) => e.startedAt < before);
      }
      if (query.failed) all = all.filter((e) => e.status === "failed");
      const page = all.slice(0, limit);
      return {
        entries: page,
        nextBefore: all.length > limit ? page[page.length - 1]?.startedAt : undefined,
      };
    }

    async function writeThreeDays(cwd: string): Promise<void> {
      await writeHistoryFile(cwd, "2026-08-06.jsonl", [
        entry({ step: "d6-a", startedAt: "2026-08-06T10:00:00.000Z" }),
        entry({ step: "d6-b", startedAt: "2026-08-06T11:00:00.000Z", status: "failed" }),
      ]);
      await writeHistoryFile(cwd, "2026-08-07.jsonl", [
        // 日付をまたいだ実行: 前日の startedAt のエントリが翌日のファイルに書かれている
        entry({ step: "d7-prev", startedAt: "2026-08-06T23:59:59.000Z" }),
        entry({ step: "d7-a", startedAt: "2026-08-07T01:00:00.000Z", status: "failed" }),
        entry({ step: "d7-tie1", startedAt: "2026-08-07T02:00:00.000Z" }),
        entry({ step: "d7-tie2", startedAt: "2026-08-07T02:00:00.000Z" }),
      ]);
      await writeHistoryFile(cwd, "2026-08-08.jsonl", [
        entry({ step: "d8-prev", startedAt: "2026-08-07T02:00:00.000Z" }),
        entry({ step: "d8-a", startedAt: "2026-08-08T00:00:00.000Z" }),
        entry({ step: "d8-b", startedAt: "2026-08-08T05:00:00.000Z", status: "failed" }),
      ]);
    }

    it("limit・before・failed の各組み合わせで全件読み込みと同じページを返す", async () => {
      await writeThreeDays(dir);
      const queries = [
        { limit: 1 },
        { limit: 2 },
        { limit: 3 },
        { limit: 4 },
        { limit: 5 },
        { limit: 20 },
        { limit: 2, before: "2026-08-08T00:00:00.000Z" },
        { limit: 2, before: "2026-08-07T02:00:00.000Z" },
        { limit: 1, before: "2026-08-07T00:00:00.000Z" },
        { limit: 1, failed: true },
        { limit: 2, failed: true },
      ];
      for (const query of queries) {
        expect(await getHistoryPage(dir, query), JSON.stringify(query)).toEqual(
          await referencePage(dir, query),
        );
      }
    });

    it("前日の startedAt を持つエントリが新しい日付のファイルにあっても、同時刻の並びを含め全件読み込みと一致する", async () => {
      await writeThreeDays(dir);

      const page = await getHistoryPage(dir, { limit: 4 });

      // d8-prev(08-08 ファイル)は d7-tie1/d7-tie2(08-07 ファイル)と同時刻で、ファイル名降順の連結順により先に並ぶ
      expect(page.entries.map((e) => e.step)).toEqual(["d8-b", "d8-a", "d8-prev", "d7-tie2"]);
      expect(page.nextBefore).toBe("2026-08-07T02:00:00.000Z");
    });

    it("先頭 limit+1 件が確定した時点で、それより古い日付のファイルを読まない", async () => {
      await writeThreeDays(dir);
      // 読み込むと EISDIR で失敗する古い日付の「ファイル」を置き、読まれていないことを確認する
      await mkdir(join(dir, ".klaus", "history", "2026-08-01.jsonl"));

      const page = await getHistoryPage(dir, { limit: 1 });

      expect(page.entries.map((e) => e.step)).toEqual(["d8-b"]);
      expect(page.nextBefore).toBe("2026-08-08T05:00:00.000Z");
    });

    it("次のファイルに上位へ入り得るエントリがある間は打ち切らない", async () => {
      await writeThreeDays(dir);
      // limit+1 件目(d8-prev: 08-07T02:00)が 08-07 ファイルの上限(08-08T00:00)未満のため 08-07 も読む必要がある
      const page = await getHistoryPage(dir, { limit: 2 });

      expect(page.entries.map((e) => e.step)).toEqual(["d8-b", "d8-a"]);
      expect(page.nextBefore).toBe("2026-08-08T00:00:00.000Z");
      expect(page).toEqual(await referencePage(dir, { limit: 2 }));
    });

    it("時計の巻き戻りで前日ファイルに翌日の startedAt があっても、nextBefore ページングが全件読み込みと一致する", async () => {
      // 2026-01-01 ファイルに翌日境界より後の startedAt(24 時間未満の巻き戻りを模擬)を置く
      await writeHistoryFile(dir, "2026-01-01.jsonl", [
        entry({ step: "d1-a", startedAt: "2026-01-01T10:00:00.000Z" }),
        entry({ step: "d1-skew", startedAt: "2026-01-02T00:00:05.500Z" }),
      ]);
      await writeHistoryFile(dir, "2026-01-02.jsonl", [
        entry({ step: "d2-a", startedAt: "2026-01-02T00:00:01.000Z" }),
        entry({ step: "d2-a2", startedAt: "2026-01-02T00:00:02.000Z" }),
        entry({ step: "d2-a3", startedAt: "2026-01-02T00:00:03.000Z" }),
        entry({ step: "d2-b", startedAt: "2026-01-02T00:00:10.000Z" }),
        entry({ step: "d2-c", startedAt: "2026-01-02T05:00:00.000Z" }),
        entry({ step: "d2-d", startedAt: "2026-01-02T06:00:00.000Z" }),
      ]);

      // マージンが翌日境界(+1 日)だけだと、2 ページ目で 2026-01-01 ファイルを読まずに打ち切り d1-skew を取りこぼす
      const steps: string[] = [];
      let before: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const query = before === undefined ? { limit: 2 } : { limit: 2, before };
        const page = await getHistoryPage(dir, query);
        expect(page, JSON.stringify(query)).toEqual(await referencePage(dir, query));
        steps.push(...page.entries.map((e) => e.step));
        if (page.nextBefore === undefined) break;
        before = page.nextBefore;
      }
      expect(steps).toEqual(["d2-d", "d2-c", "d2-b", "d1-skew", "d2-a3", "d2-a2", "d2-a", "d1-a"]);
    });
  });
});
