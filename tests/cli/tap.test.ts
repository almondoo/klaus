import { describe, expect, it } from "vitest";
import { formatTap } from "../../src/cli/reporters/tap.js";
import { buildFlow, buildRunResult, buildStep } from "./reporters-fixtures.js";

describe("formatTap", () => {
  it("先頭にバージョン行、続けてプラン行(1..総ステップ数)を出力する", () => {
    const flow1 = buildFlow({
      name: "flow1",
      steps: [buildStep({ name: "step1", status: "passed" })],
    });
    const flow2 = buildFlow({
      name: "flow2",
      steps: [
        buildStep({ name: "step2", status: "passed" }),
        buildStep({ name: "step3", status: "passed" }),
      ],
    });
    const tap = formatTap(buildRunResult([flow1, flow2]));
    const lines = tap.split("\n");

    expect(lines[0]).toBe("TAP version 13");
    expect(lines[1]).toBe("1..3");
  });

  it("passed ステップは ok 行になり、フローをまたいで連番が続く", () => {
    const flow1 = buildFlow({
      name: "flow1",
      steps: [buildStep({ name: "step1", status: "passed" })],
    });
    const flow2 = buildFlow({
      name: "flow2",
      steps: [buildStep({ name: "step2", status: "passed" })],
    });
    const tap = formatTap(buildRunResult([flow1, flow2]));

    expect(tap).toContain("ok 1 - flow1 > step1");
    expect(tap).toContain("ok 2 - flow2 > step2");
  });

  it("skipped ステップは ok + SKIP ディレクティブになり、理由は StepResult.error から取る", () => {
    const flow = buildFlow({
      steps: [
        buildStep({
          name: "skip-me",
          status: "skipped",
          error: "skipped because a previous step failed",
        }),
      ],
    });
    const tap = formatTap(buildRunResult([flow]));

    expect(tap).toContain("ok 1 - flow > skip-me # SKIP skipped because a previous step failed");
  });

  it("error 情報のない skipped ステップは理由が既定の 'skipped' になる", () => {
    const flow = buildFlow({
      steps: [buildStep({ name: "skip-me", status: "skipped" })],
    });
    const tap = formatTap(buildRunResult([flow]));

    expect(tap).toContain("ok 1 - flow > skip-me # SKIP skipped");
  });

  it("failed ステップは not ok になり、失敗アサーションごとに1行の診断コメントが続く", () => {
    const flow = buildFlow({
      steps: [
        buildStep({
          name: "get-me",
          status: "failed",
          assertions: [
            {
              ok: false,
              kind: "status",
              expected: 200,
              actual: 401,
              message: "expected status 200 but got 401",
            },
            {
              ok: true,
              kind: "header",
              message: "header ok",
            },
            {
              ok: false,
              kind: "bodyText",
              expected: "ok",
              actual: "bad",
              message: "body text mismatch",
            },
          ],
        }),
      ],
    });
    const tap = formatTap(buildRunResult([flow]));
    const lines = tap.split("\n");
    const testLineIndex = lines.indexOf("not ok 1 - flow > get-me");

    expect(testLineIndex).toBeGreaterThanOrEqual(0);
    // ok なアサーションは診断行に含まれず、失敗した2件だけが出力される
    expect(lines[testLineIndex + 1]).toBe("# expected status 200 but got 401");
    expect(lines[testLineIndex + 2]).toBe("# body text mismatch");
    expect(tap).not.toContain("header ok");
  });

  it("error ステップは not ok になり、StepResult.error を診断行として1行出す", () => {
    const flow = buildFlow({
      steps: [buildStep({ name: "ping", status: "error", error: "connect ECONNREFUSED" })],
    });
    const tap = formatTap(buildRunResult([flow]));
    const lines = tap.split("\n");
    const testLineIndex = lines.indexOf("not ok 1 - flow > ping");

    expect(testLineIndex).toBeGreaterThanOrEqual(0);
    expect(lines[testLineIndex + 1]).toBe("# connect ECONNREFUSED");
  });

  it("error 情報のない error ステップは診断行が既定の 'runtime error' になる", () => {
    const flow = buildFlow({
      steps: [buildStep({ name: "ping", status: "error" })],
    });
    const tap = formatTap(buildRunResult([flow]));

    expect(tap).toContain("# runtime error");
  });

  it("ステップ名/フロー名の改行と '#' はプロトコルを壊さないようにサニタイズされる", () => {
    const flow = buildFlow({
      name: "flow # with hash",
      steps: [buildStep({ name: "step\nwith\nnewline", status: "passed" })],
    });
    const tap = formatTap(buildRunResult([flow]));
    const lines = tap.split("\n");

    // 出力全体の行数がステップ数(プラン込みで3行)どおりであること = 実際の改行が増えていないこと
    expect(lines).toHaveLength(4); // "TAP version 13" / "1..1" / ok 行 / 末尾の空文字列(trailing \n)
    // sanitizeForTerminal が実改行を可視エスケープ "\n"(バックスラッシュ+n)に変換した後、
    // その '\' 自体もエスケープ対象になるため出力は "\\n"(バックスラッシュ2つ+n)になる
    expect(lines[2]).toBe("ok 1 - flow \\# with hash > step\\\\nwith\\\\nnewline");
  });

  it("'\\' は '#' より先にエスケープされ、'\\#' という入力由来の並びと '#' のエスケープ結果が区別できる", () => {
    const flow = buildFlow({
      // 生の '\' と、生の '\#'(エスケープ前から存在する並び)の両方を含める
      name: String.raw`flow \ with backslash`,
      steps: [buildStep({ name: String.raw`step\#literal`, status: "passed" })],
    });
    const tap = formatTap(buildRunResult([flow]));
    const lines = tap.split("\n");

    // '\' -> '\\'、'#' -> '\#' の順で変換されるため、生の '\#' は '\\\#'(バックスラッシュ2つ+エスケープ済み#)になる
    expect(lines[2]).toBe(String.raw`ok 1 - flow \\ with backslash > step\\\#literal`);
  });

  it("secrets を渡すと該当する値が *** にマスクされる", () => {
    // '#' を含む値にする: マスク→サニタイズ→'#' エスケープの順序が逆転すると、
    // エスケープ後の文字列("sec\#ret")は maskString の完全一致に失敗しマスクされないまま漏れる
    // (junit.test.ts の同名テストと同じ理由で、この順序をテストで固定する)。
    const secret = "sec#ret";
    const flow = buildFlow({
      steps: [
        buildStep({
          name: "step",
          status: "failed",
          assertions: [
            {
              ok: false,
              kind: "bodyText",
              expected: "ok",
              actual: secret,
              message: `body text: expected "ok" but got "${secret}"`,
            },
          ],
        }),
      ],
    });
    const tap = formatTap(buildRunResult([flow]), { secrets: [secret] });

    expect(tap).not.toContain(secret);
    // 順序が逆転した場合の具体的な失敗形('#' エスケープ済みの生値が残る)を直接検知する
    expect(tap).not.toContain("sec\\#ret");
    expect(tap).toContain("***");
  });

  it("--data 実行時(flow.iteration 指定あり)はテスト名の flow 部分に (iteration N) が付く(formatJUnit と同じ文言)", () => {
    const flow = buildFlow({
      name: "data flow",
      iteration: 2,
      steps: [buildStep({ name: "ok", status: "passed" })],
    });
    const tap = formatTap(buildRunResult([flow]));

    expect(tap).toContain("ok 1 - data flow (iteration 2) > ok");
  });

  it("flow.iteration が未設定の場合(通常実行)はテスト名に (iteration N) が付かない", () => {
    const flow = buildFlow({
      name: "flow",
      steps: [buildStep({ name: "ok", status: "passed" })],
    });
    const tap = formatTap(buildRunResult([flow]));

    expect(tap).toContain("ok 1 - flow > ok");
    expect(tap).not.toContain("iteration");
  });

  it("末尾に改行が1つ付く", () => {
    const flow = buildFlow({ steps: [buildStep({ name: "step1", status: "passed" })] });
    const tap = formatTap(buildRunResult([flow]));

    expect(tap.endsWith("\n")).toBe(true);
    expect(tap.endsWith("\n\n")).toBe(false);
  });
});
