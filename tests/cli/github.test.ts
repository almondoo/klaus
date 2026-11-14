import { describe, expect, it } from "vitest";
import {
  escapeCommandData,
  escapeCommandProperty,
  escapeMarkdownCell,
  formatGithubAnnotations,
  formatGithubSummary,
  SUMMARY_MAX_BYTES,
} from "../../src/cli/reporters/github.js";
import { buildFlow, buildRunResult, buildStep } from "./reporters-fixtures.js";

describe("workflow command escaping", () => {
  it("データ部は % CR LF、プロパティはさらに : , をエスケープする", () => {
    expect(escapeCommandData("a%b\r\nc:d,e")).toBe("a%25b%0D%0Ac:d,e");
    expect(escapeCommandProperty("a%b\nc:d,e")).toBe("a%25b%0Ac%3Ad%2Ce");
  });
});

describe("formatGithubAnnotations", () => {
  it("failed/error ステップだけを ::error 行にし、複数行メッセージも1行に収める", () => {
    const run = buildRunResult([
      buildFlow({
        name: "flow: a",
        file: "flows/a,b.yaml",
        steps: [
          buildStep({ name: "ok", status: "passed" }),
          buildStep({
            name: "bad",
            status: "failed",
            assertions: [
              { ok: false, kind: "status", message: "line1\nline2 100%" },
              { ok: false, kind: "body", message: "second" },
            ],
          }),
          buildStep({ name: "boom", status: "error", error: "ECONNREFUSED" }),
          buildStep({ name: "later", status: "skipped" }),
        ],
      }),
    ]);
    expect(formatGithubAnnotations(run)).toEqual([
      "::error file=flows/a%2Cb.yaml,title=flow%3A a / bad::line1%0Aline2 100%25%0Asecond",
      "::error file=flows/a%2Cb.yaml,title=flow%3A a / boom::ECONNREFUSED",
    ]);
  });

  it("secrets をマスクする", () => {
    const run = buildRunResult([
      buildFlow({
        steps: [buildStep({ name: "s", status: "error", error: "bad token sekret-1" })],
      }),
    ]);
    const [line] = formatGithubAnnotations(run, { secrets: ["sekret-1"] });
    expect(line).not.toContain("sekret-1");
  });
});

describe("escapeMarkdownCell", () => {
  it("パイプ・バッククォート・改行・HTML をエスケープする", () => {
    expect(escapeMarkdownCell("a|b`c\nd<script>&\\")).toBe("a\\|b\\`c<br>d&lt;script&gt;&amp;\\\\");
  });
});

describe("formatGithubSummary", () => {
  const run = buildRunResult([
    buildFlow({
      name: "f|1",
      status: "failed",
      steps: [
        buildStep({ name: "ok", status: "passed" }),
        buildStep({
          name: "bad<b>",
          status: "failed",
          assertions: [{ ok: false, kind: "status", message: "x|y\nz" }],
        }),
      ],
    }),
  ]);

  it("ステータス行・件数表・失敗表・折りたたみ詳細を出す", () => {
    const md = formatGithubSummary(run);
    expect(md).toContain("## klaus run: PASSED");
    expect(md).toContain("| 1 | 2 | 1 | 1 | 0 | 0 |");
    expect(md).toContain("| f\\|1 | bad&lt;b&gt; | failed | x\\|y<br>z |");
    expect(md).toContain("<details>");
  });

  it("warnings があれば件数表の後に引用行で出す", () => {
    const md = formatGithubSummary({ ...run, warnings: ["tls.insecure is enabled"] });
    expect(md).toContain("> Warning: tls.insecure is enabled");
    expect(formatGithubSummary(run)).not.toContain("Warning");
  });

  it("サイズ上限を超える場合は詳細を打ち切って注記し、失敗表は残す", () => {
    const flows = Array.from({ length: 40 }, (_, i) =>
      buildFlow({
        name: `flow-${i}`,
        steps: Array.from({ length: 400 }, (_, j) =>
          buildStep({
            name: `step-${j}`,
            request: { method: "GET", url: `http://x/${"p".repeat(120)}`, headers: {} },
          }),
        ),
      }),
    );
    flows[0] = buildFlow({
      name: "ng",
      status: "failed",
      steps: [buildStep({ name: "bad", status: "error", error: "boom" })],
    });
    const md = formatGithubSummary(buildRunResult(flows));
    expect(Buffer.byteLength(md, "utf-8")).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    expect(md).toContain("were omitted to stay under the GitHub step summary size limit");
    expect(md).toContain("| ng | bad | error | boom |");
  });

  it("失敗表は 200 行で打ち切って残件数を注記する", () => {
    const steps = Array.from({ length: 205 }, (_, i) =>
      buildStep({ name: `s${i}`, status: "error", error: "e" }),
    );
    const md = formatGithubSummary(buildRunResult([buildFlow({ steps })]));
    expect(md).toContain("5 more failed steps are not shown.");
  });
});

describe("サイズ・リンク・長さの保証", () => {
  it("Markdown の特殊文字と自動リンクを無効化し、リンク・強調・表の破壊を起こさない", () => {
    const escaped = escapeMarkdownCell(
      "[click](http://evil.example) *b* _i_ ~s~ ![i](x) www.evil.com a@b.com",
    );
    expect(escaped).not.toMatch(/(^|[^\\])\[/);
    expect(escaped).not.toContain("://");
    expect(escaped).not.toContain("www.");
    expect(escaped).not.toContain("@");
    const md = formatGithubSummary(
      buildRunResult([
        buildFlow({
          name: "[f](http://evil.example)",
          steps: [buildStep({ name: "[x](http://evil.example)|*", status: "error", error: "e" })],
        }),
      ]),
    );
    expect(md).not.toContain("http://evil.example");
    expect(md).not.toMatch(/(^|[^\\])\]\(/);
  });

  it("長い名前(失敗 200 件 x 3000 文字、50 ステップ x 20000 文字)でも上限内に収まる", () => {
    const longA = buildFlow({
      name: "n".repeat(3000),
      steps: Array.from({ length: 200 }, () =>
        buildStep({ name: "s".repeat(3000), status: "error", error: "e".repeat(3000) }),
      ),
    });
    const longB = buildFlow({
      name: "m".repeat(20000),
      steps: Array.from({ length: 50 }, () => buildStep({ name: "t".repeat(20000) })),
    });
    for (const flow of [longA, longB]) {
      const md = formatGithubSummary(buildRunResult([flow]));
      expect(Buffer.byteLength(md, "utf-8")).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
      expect(md).toContain("…");
    }
  });

  it("ハード上限: エスケープで膨らむ多バイト文字でも行境界で切り、<details> を閉じて注記する", () => {
    const hostile = "<|あ".repeat(100);
    const flows = Array.from({ length: 30 }, (_, i) =>
      buildFlow({
        name: `f${i}`,
        steps: Array.from({ length: 120 }, (_, j) =>
          buildStep({
            name: `${hostile}${j}`,
            status: j === 0 ? "error" : "passed",
            error: hostile,
            request: { method: "GET", url: hostile, headers: {} },
          }),
        ),
      }),
    );
    const md = formatGithubSummary(buildRunResult(flows));
    expect(Buffer.byteLength(md, "utf-8")).toBeLessThanOrEqual(SUMMARY_MAX_BYTES);
    expect(md).not.toContain("\uFFFD");
    expect((md.match(/<details>/g) ?? []).length).toBe((md.match(/<\/details>/g) ?? []).length);
  });

  it("アノテーションの title / message は長さを抑え、メッセージには切り詰めの注記を付ける", () => {
    const run = buildRunResult([
      buildFlow({
        name: "f".repeat(1000),
        steps: [buildStep({ name: "s".repeat(1000), status: "error", error: "m".repeat(10000) })],
      }),
    ]);
    const line = formatGithubAnnotations(run)[0] ?? "";
    expect(line.length).toBeLessThan(5000);
    expect(line).toContain("(message truncated)");
    expect(line).toContain("…");
  });
});
