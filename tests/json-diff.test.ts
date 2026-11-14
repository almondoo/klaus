import { describe, expect, it } from "vitest";
import {
  diffJson,
  exceedsDepth,
  formatJsonPath,
  MAX_DESCENDANT_OPERATORS,
  parseJsonPathPattern,
} from "../src/core/json-diff.js";
import { diffLines } from "../src/core/text-diff.js";

function patterns(...sources: string[]) {
  return sources.map((source) => {
    const pattern = parseJsonPathPattern(source);
    if (!pattern) throw new Error(`invalid pattern: ${source}`);
    return pattern;
  });
}

describe("diffJson", () => {
  it("同一の値は差分なし(オブジェクトのキー順の違いも無視する)", () => {
    expect(diffJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toEqual([]);
    expect(diffJson("***", "***")).toEqual([]);
    expect(diffJson(null, null)).toEqual([]);
  });

  it("changed / added / removed を JSONPath 風のパスつきで出現順に返す", () => {
    const result = diffJson(
      { name: "a", nested: { n: 1, gone: true }, list: [1, 2] },
      { name: "b", nested: { n: 1, extra: "x" }, list: [1, 2] },
    );
    expect(result).toEqual([
      { path: "$.name", kind: "changed", before: "a", after: "b" },
      { path: "$.nested.gone", kind: "removed", before: true },
      { path: "$.nested.extra", kind: "added", after: "x" },
    ]);
  });

  it("型が違う場合は type-changed を1件だけ報告し配下は辿らない(null・配列・オブジェクト・数値文字列の区別)", () => {
    expect(
      diffJson({ a: 1, b: null, c: [], d: { x: 1 } }, { a: "1", b: {}, c: {}, d: [1] }),
    ).toEqual([
      { path: "$.a", kind: "type-changed", before: 1, after: "1" },
      { path: "$.b", kind: "type-changed", before: null, after: {} },
      { path: "$.c", kind: "type-changed", before: [], after: {} },
      { path: "$.d", kind: "type-changed", before: { x: 1 }, after: [1] },
    ]);
  });

  it("配列は順序依存でインデックス比較し、長さの差は added / removed になる", () => {
    expect(diffJson([1, 2, 3], [1, 3, 2])).toEqual([
      { path: "$[1]", kind: "changed", before: 2, after: 3 },
      { path: "$[2]", kind: "changed", before: 3, after: 2 },
    ]);
    expect(diffJson({ l: [1] }, { l: [1, { id: 2 }] })).toEqual([
      { path: "$.l[1]", kind: "added", after: { id: 2 } },
    ]);
    expect(diffJson([1, 2], [1])).toEqual([{ path: "$[1]", kind: "removed", before: 2 }]);
  });

  it("root が undefined の場合は added / removed になる", () => {
    expect(diffJson(undefined, { a: 1 })).toEqual([{ path: "$", kind: "added", after: { a: 1 } }]);
    expect(diffJson("x", undefined)).toEqual([{ path: "$", kind: "removed", before: "x" }]);
    expect(diffJson(undefined, undefined)).toEqual([]);
  });

  it("識別子でないキーは括弧記法のパスになる", () => {
    expect(diffJson({ "a-b": { "it's": 1 } }, { "a-b": { "it's": 2 } })[0]?.path).toBe(
      "$['a-b']['it\\'s']",
    );
    expect(formatJsonPath(["items", 0, "id"])).toBe("$.items[0].id");
  });

  it("ignorePaths: 完全一致・ワイルドカード・任意の深さ・括弧記法で除外する(added / removed も対象)", () => {
    const before = {
      id: 1,
      items: [
        { id: 1, name: "a", at: "t1" },
        { id: 2, name: "b", at: "t2" },
      ],
      meta: { updatedAt: "x", keep: 1 },
      "a-b": 1,
    };
    const after = {
      id: 2,
      items: [
        { id: 9, name: "a", at: "t3" },
        { id: 8, name: "c", at: "t4" },
      ],
      meta: { updatedAt: "y", keep: 2 },
      "a-b": 2,
      extra: 1,
    };
    const result = diffJson(before, after, {
      ignorePaths: patterns(
        "$.id",
        "$.items[*].id",
        "$.items.*.at",
        "$..updatedAt",
        "$['a-b']",
        "$.extra",
      ),
    });
    expect(result).toEqual([
      { path: "$.items[1].name", kind: "changed", before: "b", after: "c" },
      { path: "$.meta.keep", kind: "changed", before: 1, after: 2 },
    ]);
  });

  it("ignorePaths: 親パスを指定すると配下すべてを除外し、特定インデックスだけも指定できる", () => {
    expect(
      diffJson(
        { a: { x: 1 }, b: [1, 2] },
        { a: { x: 2 }, b: [9, 2] },
        { ignorePaths: patterns("$.a", "$.b[0]") },
      ),
    ).toEqual([]);
  });
});

describe("diffJson: 深い入れ子と病的な除外パターン", () => {
  const nested = (depth: number, leaf: unknown, wrap: "object" | "array"): unknown => {
    let value: unknown = leaf;
    for (let i = 0; i < depth; i++) value = wrap === "object" ? { a: value } : [value];
    return value;
  };

  it("深さ 20000 のオブジェクト・深さ 6000 の配列でもスタックを溢れさせず、異なる場合は too-deep を1件返す", () => {
    for (const [depth, wrap] of [
      [20000, "object"],
      [6000, "array"],
    ] as const) {
      const result = diffJson(nested(depth, 1, wrap), nested(depth, 2, wrap));
      expect(result).toHaveLength(1);
      expect(result[0]?.kind).toBe("too-deep");
      expect(result[0]?.before).toBeUndefined();
      // 深すぎるサブツリーまでのパスは打ち切り位置で止まる
      expect(result[0]?.path.length).toBeLessThan(2000);
    }
  });

  it("深くても同一の値は差分なし(等価判定は反復で行う)で、キー順の違いも無視する", () => {
    const left = nested(20000, { x: 1, y: 2 }, "object");
    const right = nested(20000, { y: 2, x: 1 }, "object");
    expect(diffJson(left, right)).toEqual([]);
  });

  it("差分に載せる深い値(added / removed / type-changed)は表示用の文字列に置き換える(JSON 化で溢れない)", () => {
    const deep = nested(20000, 1, "object");
    const added = diffJson({}, { deep });
    expect(added).toEqual([{ path: "$.deep", kind: "added", after: "[too deep to display]" }]);
    const changed = diffJson({ deep: 1 }, { deep });
    expect(changed[0]).toMatchObject({ kind: "type-changed", after: "[too deep to display]" });
    expect(() => JSON.stringify(added)).not.toThrow();
  });

  it("exceedsDepth は反復で入れ子の深さを数える", () => {
    expect(exceedsDepth(nested(20000, 1, "array"), 100)).toBe(true);
    expect(exceedsDepth(nested(5, 1, "array"), 100)).toBe(false);
    expect(exceedsDepth("x", 0)).toBe(false);
  });

  it("`..` を複数含む除外パターンでも深い本文で多項式時間に収まる", () => {
    const body = nested(40, "leaf", "object");
    const pattern = parseJsonPathPattern("$..a..zzz");
    expect(pattern).toBeDefined();
    const started = Date.now();
    diffJson(body, nested(40, "other", "object"), { ignorePaths: [pattern as never] });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("`..` の個数が上限を超えるパターンと、長すぎるパターンは解釈できない", () => {
    expect(MAX_DESCENDANT_OPERATORS).toBe(2);
    expect(parseJsonPathPattern("$..a..b")).toBeDefined();
    expect(parseJsonPathPattern("$..a..b..c")).toBeUndefined();
    expect(parseJsonPathPattern(`$.${"a".repeat(300)}`)).toBeUndefined();
  });
});

describe("parseJsonPathPattern", () => {
  it("解釈できない式は undefined を返す", () => {
    for (const source of ["", "data.id", "$.", "$..", "$[abc]", "$['a'", "$.a[", "$x"]) {
      expect(parseJsonPathPattern(source)).toBeUndefined();
    }
  });

  it("$ のみは root 全体の除外として解釈できる", () => {
    expect(diffJson({ a: 1 }, { a: 2 }, { ignorePaths: patterns("$") })).toEqual([]);
  });
});

describe("diffLines", () => {
  it("同一テキストは差分なし", () => {
    expect(diffLines("a\nb", "a\nb")).toEqual({ added: 0, removed: 0, changes: [] });
  });

  it("変更・追加・削除した行だけを元の順序で返す", () => {
    const result = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne");
    expect(result).toEqual({
      added: 2,
      removed: 1,
      changes: [
        { op: "-", line: "b" },
        { op: "+", line: "B" },
        { op: "+", line: "e" },
      ],
    });
  });

  it("CRLF と LF の改行差は行内容の差として扱わない", () => {
    expect(diffLines("a\r\nb", "a\nb").changes).toEqual([]);
  });

  it("中間部が大きすぎる場合は全行置換として扱う", () => {
    const before = Array.from({ length: 1100 }, (_, i) => `a${i}`).join("\n");
    const after = Array.from({ length: 1100 }, (_, i) => `b${i}`).join("\n");
    const result = diffLines(before, after);
    expect(result.removed).toBe(1100);
    expect(result.added).toBe(1100);
  });
});
