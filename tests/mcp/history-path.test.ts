import { describe, expect, it } from "vitest";
import {
  InvalidPathError,
  parseHistoryPath,
  selectHistoryPath,
} from "../../src/mcp/history-path.js";

describe("parseHistoryPath(受け付ける構文)", () => {
  it.each([
    ["$", []],
    ["$.response", ["response"]],
    ["$.response.body.items[0].id", ["response", "body", "items", 0, "id"]],
    ["$.response.headers.content-type", ["response", "headers", "content-type"]],
    ["$['response']['headers']['content-type']", ["response", "headers", "content-type"]],
    ['$["a b"]', ["a b"]],
    ["$['it\\'s']", ["it's"]],
    ['$["q\\"x"]', ['q"x']],
    ["$['a\\\\b']", ["a\\b"]],
    ["$[0][12]", [0, 12]],
    ["$.a['b'][3].c", ["a", "b", 3, "c"]],
  ])("%s", (path, expected) => {
    expect(parseHistoryPath(path)).toEqual(expected);
  });
});

describe("parseHistoryPath(拒否する構文)", () => {
  it.each([
    ["空文字列", ""],
    ["$ で始まらない", "response.body"],
    ["閉じていない括弧", "$["],
    ["再帰下降", "$..a"],
    ["再帰下降の連続", "$..a..a..a..a"],
    ["ワイルドカード", "$.*"],
    ["添字のワイルドカード", "$[*]"],
    ["フィルター", "$[?(@.x)]"],
    ["スクリプト式", "$[(1+1)]"],
    ["スライス", "$[0:2]"],
    ["和集合(添字)", "$[0,1]"],
    ["和集合(キー)", "$['a','b']"],
    ["負の添字", "$[-1]"],
    ["先頭がゼロの添字", "$[01]"],
    ["桁数の多すぎる添字", "$[1234567890]"],
    ["閉じていない引用符", "$['a"],
    ["引用符の後ろに ] が無い", "$['a'x"],
    ["未対応のエスケープ", "$['a\\x']"],
    [". の後ろが識別子ではない", "$."],
    [". の後ろが数字", "$.0"],
    ["末尾の余分な文字", "$.a b"],
    ["$ の後ろに . も [ も無い", "$a"],
  ])("%s: %s", (_label, path) => {
    expect(() => parseHistoryPath(path)).toThrow(InvalidPathError);
  });

  it("エラーは受け付ける構文を示し、長い path は切り詰めて載せる", () => {
    const long = `$.${"a".repeat(200)}!`;
    let message = "";
    try {
      parseHistoryPath(long);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("supported forms are");
    expect(message).toContain("recursive descent");
    expect(message.length).toBeLessThan(400);
  });
});

describe("selectHistoryPath", () => {
  const entry = {
    response: { status: 200, headers: { "content-type": "text/plain" }, body: "text" },
    items: [{ id: 1 }, { id: 2 }],
  };
  const select = (path: string) => selectHistoryPath(entry, parseHistoryPath(path));

  it("値を取り出し、無いものは found: false(例外にしない)", () => {
    expect(select("$.response.status")).toEqual({ found: true, value: 200 });
    expect(select("$['response'].headers['content-type']")).toEqual({
      found: true,
      value: "text/plain",
    });
    expect(select("$.items[1].id")).toEqual({ found: true, value: 2 });
    expect(select("$")).toEqual({ found: true, value: entry });
    expect(select("$.missing")).toEqual({ found: false });
    expect(select("$.items[2]")).toEqual({ found: false });
    expect(select("$.response.status.deeper")).toEqual({ found: false });
  });

  it("継承されたプロパティ・配列の length・文字列の文字には到達しない", () => {
    expect(select("$.__proto__")).toEqual({ found: false });
    expect(select("$.constructor")).toEqual({ found: false });
    expect(select("$['__proto__']['x']")).toEqual({ found: false });
    expect(select("$.items.length")).toEqual({ found: false });
    expect(select("$.response.body[0]")).toEqual({ found: false });
  });

  it("512 文字ほどの有効な path を、入れ子が深いエントリに当てても即座に終わる", () => {
    let deep: unknown = { leaf: true };
    for (let i = 0; i < 200; i++) deep = { a: deep };
    const path = `$${".a".repeat(255)}`;
    expect(path.length).toBeGreaterThanOrEqual(510);

    const started = performance.now();
    const found = selectHistoryPath({ root: deep }, parseHistoryPath(`$.root${".a".repeat(200)}`));
    const missing = selectHistoryPath({ root: deep }, parseHistoryPath(path));
    expect(performance.now() - started).toBeLessThan(200);

    expect(found).toEqual({ found: true, value: { leaf: true } });
    expect(missing).toEqual({ found: false });
  });
});
