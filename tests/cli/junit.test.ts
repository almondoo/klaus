import { describe, expect, it } from "vitest";
import { formatJUnit } from "../../src/cli/reporters/junit.js";
import { buildFlow, buildRunResult, buildStep } from "./reporters-fixtures.js";

describe("formatJUnit", () => {
  it("flow を testsuite、step を testcase として出力する", () => {
    const flow = buildFlow({
      name: "認証フロー",
      file: "api/auth-flow.yaml",
      steps: [
        buildStep({ name: "login", status: "passed", durationMs: 45 }),
        buildStep({
          name: "get-me",
          status: "failed",
          durationMs: 30,
          assertions: [
            {
              ok: false,
              kind: "status",
              expected: 200,
              actual: 401,
              message: "expected status 200 but got 401",
            },
          ],
        }),
      ],
    });
    const xml = formatJUnit(buildRunResult([flow]));

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<testsuite name="認証フロー"');
    expect(xml).toContain('tests="2"');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('<testcase name="login" classname="認証フロー" time="0.045" />');
    expect(xml).toContain('<testcase name="get-me" classname="認証フロー" time="0.030">');
    expect(xml).toContain("expected status 200 but got 401");
  });

  it("error ステップは <error> タグになる", () => {
    const flow = buildFlow({
      steps: [buildStep({ name: "ping", status: "error", error: "connect ECONNREFUSED" })],
    });
    const xml = formatJUnit(buildRunResult([flow]));
    expect(xml).toContain('errors="1"');
    expect(xml).toContain('<error message="connect ECONNREFUSED">connect ECONNREFUSED</error>');
  });

  it("skipped ステップは <skipped> タグになる", () => {
    const flow = buildFlow({
      steps: [
        buildStep({
          name: "skip-me",
          status: "skipped",
          error: "skipped because a previous step failed",
        }),
      ],
    });
    const xml = formatJUnit(buildRunResult([flow]));
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('<skipped message="skipped because a previous step failed" />');
  });

  it("XML の特殊文字(&, <, >, \", ')を正しくエスケープする", () => {
    const flow = buildFlow({
      name: `flow with "quotes" & <tags> & 'apos'`,
      steps: [
        buildStep({
          name: "step",
          status: "failed",
          assertions: [
            {
              ok: false,
              kind: "body",
              expected: "<a>",
              actual: "\"b\" & 'c'",
              message: `expected "<a>" but got ""b" & 'c'"`,
            },
          ],
        }),
      ],
    });
    const xml = formatJUnit(buildRunResult([flow]));

    expect(xml).not.toContain('flow with "quotes" & <tags> & \'apos\'"');
    expect(xml).toContain("&quot;quotes&quot;");
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;tags&gt;");
    expect(xml).toContain("&apos;apos&apos;");
  });

  it("制御文字を含む message は可視エスケープになり、タブ/LF/CR は保持される", () => {
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
              actual: "bad",
              message: "line1\twith tab\nline2\rwith cr and esc \x1b[31m and bel \x07",
            },
          ],
        }),
      ],
    });
    const xml = formatJUnit(buildRunResult([flow]));

    // XML 1.0 が許容するタブ・LF・CR はそのまま残る
    expect(xml).toContain("line1\twith tab\nline2\rwith cr");
    // C0 制御文字(ESC・BEL)は \xNN 形式の可視エスケープになる(数値文字参照は使わない)
    expect(xml).toContain("\\x1B[31m");
    expect(xml).toContain("\\x07");
    expect(xml).not.toContain("&#x1B;");
    expect(xml).not.toContain("&#x07;");
  });

  it("secrets を渡すと該当する値が *** にマスクされる", () => {
    // XML 特殊文字(< > &)を含む値にする: マスク→サニタイズ→エスケープの順序が逆転すると、
    // エスケープ後の文字列は maskString の完全一致に失敗しマスクされないまま漏れる
    // (例: "sec<ret>&val" が "sec&lt;ret&gt;&amp;val" のまま残る)ため、この順序をテストで固定する。
    const secret = "sec<ret>&val";
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
    const xml = formatJUnit(buildRunResult([flow]), { secrets: [secret] });

    expect(xml).not.toContain(secret);
    // 順序が逆転した場合の具体的な失敗形(エスケープ済みの生値が残る)を直接検知する
    expect(xml).not.toContain("sec&lt;ret&gt;&amp;val");
    expect(xml).toContain("***");
  });

  it("第2引数を省略した場合、従来と同じ出力になる", () => {
    const flow = buildFlow({
      name: "認証フロー",
      steps: [
        buildStep({ name: "login", status: "passed", durationMs: 45 }),
        buildStep({
          name: "get-me",
          status: "failed",
          durationMs: 30,
          assertions: [
            {
              ok: false,
              kind: "status",
              expected: 200,
              actual: 401,
              message: "expected status 200 but got 401",
            },
          ],
        }),
      ],
    });
    const xml = formatJUnit(buildRunResult([flow]));

    expect(xml).toContain('<testcase name="login" classname="認証フロー" time="0.045" />');
    expect(xml).toContain('<testcase name="get-me" classname="認証フロー" time="0.030">');
    expect(xml).toContain("expected status 200 but got 401");
  });
});
