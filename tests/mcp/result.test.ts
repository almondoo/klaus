import { describe, expect, it } from "vitest";
import { createSerialQueue } from "../../src/mcp/queue.js";
import {
  MAX_RESULT_BYTES,
  serializeOutcome,
  stringifyWithLimit,
  ToolError,
  toFailure,
} from "../../src/mcp/result.js";

describe("stringifyWithLimit(結果のサイズ上限)", () => {
  it("上限以内の値はそのまま整形した JSON になる", () => {
    const value = { a: 1, nested: { b: "x" } };

    expect(stringifyWithLimit(value)).toBe(JSON.stringify(value, null, 2));
  });

  it("巨大な文字列は元のサイズと取得先を示す印に置き換え、小さな値と構造は残す", () => {
    const huge = "x".repeat(MAX_RESULT_BYTES * 2);
    const text = stringifyWithLimit({
      runId: "r1",
      entries: [{ step: "s", response: { body: huge } }],
    });

    const parsed = JSON.parse(text);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(parsed.runId).toBe("r1");
    expect(parsed.entries[0].step).toBe("s");
    expect(parsed.entries[0].response.body).toContain(`[truncated: ${huge.length} bytes`);
    expect(parsed.entries[0].response.body).toContain("klaus_history_show with step");
    expect(parsed.resultTruncated).toBe(true);
  });

  it("文字列ではない巨大な body(JSON)も印に置き換えて、有効な JSON のまま上限に収める", () => {
    const body = { items: Array.from({ length: 20000 }, (_, i) => ({ id: i, name: `item-${i}` })) };
    const text = stringifyWithLimit({ response: { status: 200, body } });

    const parsed = JSON.parse(text);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(parsed.response.status).toBe(200);
    expect(parsed.response.body).toContain("[truncated: ");
  });

  it("小さな要素が大量にあって印への置き換えでは収まらない場合も、有効な JSON を返す", () => {
    const text = stringifyWithLimit(Array.from({ length: 100000 }, (_, i) => i));

    const parsed = JSON.parse(text);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(parsed.resultTruncated).toBe(true);
    expect(parsed.originalBytes).toBeGreaterThan(MAX_RESULT_BYTES);
  });
});

describe("serializeOutcome", () => {
  it("成功は isError なしの JSON、失敗は isError ありで ok を除いた {error, errorCode, hint} になる", () => {
    expect(serializeOutcome({ ok: true, data: { n: 1 } })).toEqual({
      text: JSON.stringify({ n: 1 }, null, 2),
      isError: false,
    });

    const failure = serializeOutcome(
      toFailure(new ToolError("refused", { errorCode: "guard.protected", hint: "ask the user" })),
    );

    expect(failure.isError).toBe(true);
    expect(JSON.parse(failure.text)).toEqual({
      error: "refused",
      errorCode: "guard.protected",
      hint: "ask the user",
    });
  });
});

describe("createSerialQueue(直列キュー)", () => {
  it("投入順に 1 つずつ実行し、先行タスクが失敗しても後続は実行される", async () => {
    const queue = createSerialQueue();
    const log: string[] = [];
    const task =
      (name: string, ms: number, fail = false) =>
      async () => {
        log.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        log.push(`end ${name}`);
        if (fail) throw new Error(`boom ${name}`);
        return name;
      };

    const results = await Promise.allSettled([
      queue(task("a", 30, true)),
      queue(task("b", 5)),
      queue(task("c", 1)),
    ]);

    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect((results[1] as PromiseFulfilledResult<string>).value).toBe("b");
  });
});
