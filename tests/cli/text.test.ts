import { afterEach, describe, expect, it } from "vitest";
import {
  createTextReporter,
  formatFlowHeader,
  formatStepLine,
  formatSummary,
  MAX_DETAIL_LENGTH,
  resolveUseColor,
  truncate,
} from "../../src/cli/reporters/text.js";
import type { RunResult, StepResult } from "../../src/core/index.js";
import { buildStep } from "./reporters-fixtures.js";

describe("truncate", () => {
  it("上限以下ならそのまま返す", () => {
    expect(truncate("short")).toBe("short");
  });

  it("上限を超えると切り詰めて末尾にマーカーを付ける", () => {
    const long = "a".repeat(MAX_DETAIL_LENGTH + 100);
    const result = truncate(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result.startsWith("a".repeat(MAX_DETAIL_LENGTH))).toBe(true);
    expect(result).toContain("...(truncated)");
  });
});

describe("resolveUseColor", () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = originalForceColor;
  });

  it("NO_COLOR=1 のときは TTY でも false になる", () => {
    process.env.NO_COLOR = "1";
    delete process.env.FORCE_COLOR;
    expect(resolveUseColor(true)).toBe(false);
  });

  it("FORCE_COLOR=1 のときは非 TTY でも true になる(最優先)", () => {
    process.env.FORCE_COLOR = "1";
    delete process.env.NO_COLOR;
    expect(resolveUseColor(false)).toBe(true);
  });

  it("FORCE_COLOR=0 のときは false になる(chalk の慣習に合わせ無効化扱い)", () => {
    process.env.FORCE_COLOR = "0";
    delete process.env.NO_COLOR;
    expect(resolveUseColor(true)).toBe(false);
  });

  it("FORCE_COLOR=false のときも false になる(supports-color の慣習)", () => {
    process.env.FORCE_COLOR = "false";
    delete process.env.NO_COLOR;
    expect(resolveUseColor(true)).toBe(false);
  });

  it("どちらも未定義のときは isTTY にそのまま従う", () => {
    delete process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    expect(resolveUseColor(true)).toBe(true);
    expect(resolveUseColor(false)).toBe(false);
  });
});

describe("formatFlowHeader", () => {
  it("フロー名とファイルを含む", () => {
    expect(formatFlowHeader("認証フロー", "api/auth-flow.yaml")).toBe(
      "認証フロー (api/auth-flow.yaml)",
    );
  });
});

describe("formatStepLine", () => {
  it("PASS: ステータスコードと所要時間を含む", () => {
    const line = formatStepLine(
      buildStep({
        name: "login",
        status: "passed",
        durationMs: 45,
        response: { status: 200, headers: {}, body: {} },
      }),
      false,
    );
    expect(line).toBe("  PASS login (200, 45ms)");
  });

  it("FAIL: 失敗アサーションの message を追加行として含む", () => {
    const line = formatStepLine(
      buildStep({
        name: "get-me",
        status: "failed",
        durationMs: 30,
        response: { status: 200, headers: {}, body: {} },
        assertions: [
          { ok: true, kind: "status", expected: 200, actual: 200, message: "status is 200" },
          {
            ok: false,
            kind: "body.equals",
            expected: "a@b.com",
            actual: "c@d.com",
            message: 'body path "$.email": expected "a@b.com" but got "c@d.com"',
          },
        ],
      }),
      false,
    );
    const lines = line.split("\n");
    expect(lines[0]).toBe("  FAIL get-me (200, 30ms)");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('expected "a@b.com" but got "c@d.com"');
  });

  it("FAIL: 長いメッセージは 500 文字程度で切り詰める", () => {
    const longActual = "x".repeat(1000);
    const line = formatStepLine(
      buildStep({
        name: "big-body",
        status: "failed",
        assertions: [
          {
            ok: false,
            kind: "bodyText",
            expected: "y",
            actual: longActual,
            message: `body text: expected to contain "y" but got "${longActual}"`,
          },
        ],
      }),
      false,
    );
    const detailLine = line.split("\n")[1] ?? "";
    expect(detailLine).toContain("...(truncated)");
    expect(detailLine.length).toBeLessThan(longActual.length);
  });

  it("SKIP: 理由があれば含む", () => {
    const line = formatStepLine(
      buildStep({
        name: "get-me",
        status: "skipped",
        error: "skipped because a previous step failed",
      }),
      false,
    );
    expect(line).toBe("  SKIP get-me: skipped because a previous step failed");
  });

  it("ERROR: エラーメッセージを含む", () => {
    const line = formatStepLine(
      buildStep({ name: "ping", status: "error", error: "connect ECONNREFUSED 127.0.0.1:1" }),
      false,
    );
    expect(line).toBe("  ERROR ping: connect ECONNREFUSED 127.0.0.1:1");
  });

  it("useColor=true の場合は ANSI エスケープシーケンスを含む", () => {
    const line = formatStepLine(buildStep({ name: "login", status: "passed" }), true);
    expect(line).toContain("\x1b[32m");
    expect(line).toContain("\x1b[0m");
  });

  it("useColor=false の場合は ANSI エスケープシーケンスを含まない", () => {
    const line = formatStepLine(buildStep({ name: "login", status: "passed" }), false);
    expect(line).not.toContain("\x1b[");
  });
});

describe("formatStepLine: 制御文字のサニタイズ", () => {
  it("FAIL: assertion.message に ANSI エスケープや制御文字(改行含む)が含まれても、生の制御バイトのまま出力せず可視エスケープに変換する", () => {
    const line = formatStepLine(
      buildStep({
        name: "malicious",
        status: "failed",
        assertions: [
          {
            ok: false,
            kind: "bodyText",
            expected: "ok",
            actual: "injected",
            message:
              'body text: expected "ok" but got "\x1b[32mPASS fake\x1b[0m\nPASS injected\r\x07"',
          },
        ],
      }),
      false,
    );
    const lines = line.split("\n");
    // 生の改行は仕込めないため、行は「FAIL ヘッダー」「詳細1行」の2行のまま
    expect(lines).toHaveLength(2);
    const detailLine = lines[1] ?? "";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 生の制御バイトが残っていないことを検証する意図的な正規表現
    expect(detailLine).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(detailLine).toContain("\\x1B[32m");
    expect(detailLine).toContain("\\n");
    expect(detailLine).toContain("\\r");
    expect(detailLine).toContain("\\x07");
  });

  it("ERROR: result.error に制御文字が含まれても可視エスケープに変換する", () => {
    const line = formatStepLine(
      buildStep({
        name: "ping",
        status: "error",
        error: "connect refused\x1b[31m\nfake PASS line",
      }),
      false,
    );
    expect(line.split("\n")).toHaveLength(1);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 生の制御バイトが残っていないことを検証する意図的な正規表現
    expect(line).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(line).toContain("\\x1B[31m");
    expect(line).toContain("\\n");
  });
});

describe("formatSummary", () => {
  function buildRunResult(steps: StepResult[]): RunResult {
    return {
      runId: "run-1",
      startedAt: new Date().toISOString(),
      durationMs: 320,
      flows: [
        {
          name: "flow-a",
          file: "a.yaml",
          status: "passed",
          steps: steps.slice(0, 3),
          durationMs: 200,
        },
        {
          name: "flow-b",
          file: "b.yaml",
          status: "passed",
          steps: steps.slice(3),
          durationMs: 120,
        },
      ],
      status: "passed",
    };
  }

  it("例: 2 flows, 5 steps: 4 passed, 1 failed (320ms)", () => {
    const steps = [
      buildStep({ status: "passed" }),
      buildStep({ status: "passed" }),
      buildStep({ status: "passed" }),
      buildStep({ status: "passed" }),
      buildStep({ status: "failed" }),
    ];
    const summary = formatSummary(buildRunResult(steps));
    expect(summary).toBe("2 flows, 5 steps: 4 passed, 1 failed (320ms)");
  });

  it("failed/error/skipped が 0 件のときは表示しない", () => {
    const steps = [buildStep({ status: "passed" }), buildStep({ status: "passed" })];
    const summary = formatSummary(buildRunResult(steps));
    expect(summary).not.toContain("failed");
    expect(summary).not.toContain("error");
    expect(summary).not.toContain("skipped");
  });
});

describe("createTextReporter", () => {
  it("フローが切り替わるたびにヘッダーを1回だけ出力する", () => {
    const written: string[] = [];
    const reporter = createTextReporter(false, (text) => written.push(text));

    reporter.onStepStart({ flow: "flow-a", file: "a.yaml", step: "s1" });
    reporter.onStepComplete({
      flow: "flow-a",
      file: "a.yaml",
      result: buildStep({ name: "s1", status: "passed" }),
    });
    reporter.onStepStart({ flow: "flow-a", file: "a.yaml", step: "s2" });
    reporter.onStepComplete({
      flow: "flow-a",
      file: "a.yaml",
      result: buildStep({ name: "s2", status: "passed" }),
    });
    reporter.onStepStart({ flow: "flow-b", file: "b.yaml", step: "s1" });
    reporter.onStepComplete({
      flow: "flow-b",
      file: "b.yaml",
      result: buildStep({ name: "s1", status: "passed" }),
    });

    const headerCount = written.filter(
      (text) => text.includes("(a.yaml)") || text.includes("(b.yaml)"),
    ).length;
    expect(headerCount).toBe(2);
  });
});
