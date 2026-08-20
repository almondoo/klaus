import { describe, expect, it } from "vitest";
import { type ConditionContext, evaluateCondition } from "../src/core/condition.js";
import { RuntimeError } from "../src/core/errors.js";

function makeContext(overrides?: Partial<ConditionContext>): ConditionContext {
  return {
    stepStatuses: new Map([["login", "ok"]]),
    captures: { token: "abc123" },
    ...overrides,
  };
}

describe("evaluateCondition", () => {
  describe("steps.<name>.status", () => {
    it("== で一致すれば true", () => {
      expect(evaluateCondition("steps.login.status == 'ok'", makeContext())).toBe(true);
    });

    it("== で不一致なら false", () => {
      expect(evaluateCondition("steps.login.status == 'error'", makeContext())).toBe(false);
    });

    it("!= で不一致なら true", () => {
      expect(evaluateCondition("steps.login.status != 'error'", makeContext())).toBe(true);
    });

    it("!= で一致なら false", () => {
      expect(evaluateCondition("steps.login.status != 'ok'", makeContext())).toBe(false);
    });

    it("未知のステップ名は RuntimeError(利用可能なステップ名一覧つき)", () => {
      expect(() => evaluateCondition("steps.unknown.status == 'ok'", makeContext())).toThrow(
        RuntimeError,
      );
      expect(() => evaluateCondition("steps.unknown.status == 'ok'", makeContext())).toThrow(
        /unknown step "unknown" in condition \(available steps: login\)/,
      );
    });

    it("ステップが1つもない場合は available steps: none", () => {
      expect(() =>
        evaluateCondition("steps.unknown.status == 'ok'", makeContext({ stepStatuses: new Map() })),
      ).toThrow(/available steps: none/);
    });
  });

  describe("captures.<name>", () => {
    it("文字列 capture が一致すれば true", () => {
      expect(evaluateCondition("captures.token == 'abc123'", makeContext())).toBe(true);
    });

    it("文字列 capture が不一致なら false", () => {
      expect(evaluateCondition("captures.token == 'xyz'", makeContext())).toBe(false);
    });

    it("数値 capture は String() で強制変換してから比較する", () => {
      const context = makeContext({ captures: { count: 3 } });
      expect(evaluateCondition("captures.count == '3'", context)).toBe(true);
      expect(evaluateCondition("captures.count == 3", context)).toBe(true);
      expect(evaluateCondition("captures.count != '4'", context)).toBe(true);
    });

    it("未知の capture 名は RuntimeError(利用可能な capture 名一覧つき、値は含まない)", () => {
      const context = makeContext({ captures: { token: "secret-value-should-not-leak" } });
      expect(() => evaluateCondition("captures.unknown == 'x'", context)).toThrow(RuntimeError);
      try {
        evaluateCondition("captures.unknown == 'x'", context);
        expect.unreachable();
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toMatch(
          /unknown capture "unknown" in condition \(available captures: token\)/,
        );
        expect(message).not.toContain("secret-value-should-not-leak");
      }
    });

    it("capture が1つもない場合は available captures: none", () => {
      expect(() =>
        evaluateCondition("captures.unknown == 'x'", makeContext({ captures: {} })),
      ).toThrow(/available captures: none/);
    });
  });

  describe("リテラルの形式", () => {
    it("ダブルクォート文字列(スペース含む)を扱える", () => {
      const context = makeContext({ captures: { message: "hello world" } });
      expect(evaluateCondition('captures.message == "hello world"', context)).toBe(true);
    });

    it("シングルクォート文字列(スペース含む)を扱える", () => {
      const context = makeContext({ captures: { message: "hello world" } });
      expect(evaluateCondition("captures.message == 'hello world'", context)).toBe(true);
    });

    it("ベアトークン(クォートなし)を扱える", () => {
      expect(evaluateCondition("steps.login.status == ok", makeContext())).toBe(true);
    });
  });

  describe("空白の寛容さ", () => {
    it("演算子の前後にスペースがなくても解釈できる", () => {
      expect(evaluateCondition("steps.login.status=='ok'", makeContext())).toBe(true);
    });

    it("前後・余分な空白があっても解釈できる", () => {
      expect(evaluateCondition("  steps.login.status   ==   'ok'  ", makeContext())).toBe(true);
    });
  });

  describe("不正な式", () => {
    it("演算子がない場合は RuntimeError", () => {
      expect(() => evaluateCondition("steps.login.status 'ok'", makeContext())).toThrow(
        RuntimeError,
      );
    });

    it("不正な ref プレフィックスは RuntimeError", () => {
      expect(() => evaluateCondition("foo.login.status == 'ok'", makeContext())).toThrow(
        RuntimeError,
      );
    });

    it("末尾に余分なトークンがある場合は RuntimeError", () => {
      expect(() => evaluateCondition("steps.login.status == ok extra", makeContext())).toThrow(
        RuntimeError,
      );
    });

    it("リテラルが欠落している場合は RuntimeError", () => {
      expect(() => evaluateCondition("steps.login.status ==", makeContext())).toThrow(RuntimeError);
    });

    it("空文字列は RuntimeError", () => {
      expect(() => evaluateCondition("", makeContext())).toThrow(RuntimeError);
    });

    it("エラーメッセージに式そのものと文法ヒントを含める", () => {
      expect(() => evaluateCondition("nonsense", makeContext())).toThrow(
        /invalid condition expression: "nonsense" \(expected "ref op literal"/,
      );
    });
  });
});
