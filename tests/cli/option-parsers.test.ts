import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import {
  collectHeaderOption,
  collectQueryOption,
  collectVarOption,
  parseActorOption,
  parseMethodArgument,
  parseTimeoutOption,
} from "../../src/cli/option-parsers.js";

describe("collectHeaderOption", () => {
  it("最初の ':' で分割し、名前と値の前後の空白を除去する(値側の ':' は保持)", () => {
    expect(collectHeaderOption("Authorization:  Bearer a:b ", {})).toEqual({
      Authorization: "Bearer a:b",
    });
  });

  it("同名ヘッダー(大文字小文字を区別しない)は後勝ちになり、他のヘッダーは保持される", () => {
    const first = collectHeaderOption("X-A: 1", {});
    const second = collectHeaderOption("Accept: */*", first);
    expect(collectHeaderOption("x-a: 2", second)).toEqual({ Accept: "*/*", "x-a": "2" });
  });

  it("空の値は許可する", () => {
    expect(collectHeaderOption("X-Empty:", {})).toEqual({ "X-Empty": "" });
  });

  it.each(["novalue", ":value", " :v", "bad name: v", "X-A: a\r\nX-B: b"])(
    "不正な値 %j は InvalidArgumentError",
    (value) => {
      expect(() => collectHeaderOption(value, {})).toThrow(InvalidArgumentError);
    },
  );
});

describe("collectQueryOption / collectVarOption", () => {
  it("最初の '=' で分割し、値側の '=' と空の値は許可する。同名キーは後勝ち", () => {
    expect(collectQueryOption("q=a=b", {})).toEqual({ q: "a=b" });
    expect(collectQueryOption("q=", { q: "old" })).toEqual({ q: "" });
    expect(collectVarOption("k=v=w", {})).toEqual({ k: "v=w" });
  });

  it.each(["novalue", "=v"])("区切りが無い・キーが空の %j は InvalidArgumentError", (value) => {
    expect(() => collectQueryOption(value, {})).toThrow(InvalidArgumentError);
    expect(() => collectVarOption(value, {})).toThrow(InvalidArgumentError);
  });
});

describe("parseMethodArgument / parseTimeoutOption / parseActorOption", () => {
  it("メソッドは token 文字のみ許可する", () => {
    expect(parseMethodArgument("patch")).toBe("patch");
    expect(() => parseMethodArgument("GE T")).toThrow(InvalidArgumentError);
  });

  it("timeout は正の整数のみ許可する", () => {
    expect(parseTimeoutOption("1500")).toBe(1500);
    for (const value of ["0", "-1", "1.5", "abc", ""]) {
      expect(() => parseTimeoutOption(value)).toThrow(InvalidArgumentError);
    }
  });

  it("actor は前後の空白を除去し、空文字・長すぎる値を拒否する", () => {
    expect(parseActorOption("  bot ")).toBe("bot");
    expect(() => parseActorOption("  ")).toThrow(InvalidArgumentError);
    expect(() => parseActorOption("a".repeat(101))).toThrow(InvalidArgumentError);
  });
});
