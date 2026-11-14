import { describe, expect, it } from "vitest";
import { escapeHtml, formatHtml } from "../../src/cli/reporters/html.js";
import { buildFlow, buildRunResult, buildStep } from "./reporters-fixtures.js";

const PAYLOAD = `<script>alert("x")</script></style>'&`;

function failingRun() {
  return buildRunResult([
    buildFlow({
      name: `flow ${PAYLOAD}`,
      file: "flows/a.yaml",
      status: "failed",
      steps: [
        buildStep({ name: "ok", status: "passed" }),
        buildStep({
          name: `step ${PAYLOAD}`,
          status: "failed",
          request: { method: "GET", url: `http://x/${PAYLOAD}`, headers: {}, body: PAYLOAD },
          response: { status: 500, headers: {}, body: "x".repeat(900) },
          assertions: [
            { ok: false, kind: "status", expected: 200, actual: 500, message: `bad ${PAYLOAD}` },
          ],
        }),
        buildStep({ name: "boom", status: "error", error: "connect ECONNREFUSED" }),
        buildStep({ name: "later", status: "skipped", error: "skipped: earlier step failed" }),
      ],
    }),
  ]);
}

describe("formatHtml", () => {
  it("動的な文字列(名前・URL・ボディ・メッセージ)をすべてエスケープし、タグを注入できない", () => {
    const html = formatHtml(failingRun());
    expect(html).not.toContain("<script");
    expect(html).not.toContain(PAYLOAD);
    // ユーザー入力由来の </style> が文書中に増えない(正規の閉じタグ1個のみ)
    expect(html.match(/<\/style>/g)?.length).toBe(1);
    expect(html).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&lt;/style&gt;&#39;&amp;",
    );
  });

  it("失敗/エラーのステップは詳細(期待値・実測値・切り詰めた応答ボディ)を持ち、skipped は理由を出す", () => {
    const html = formatHtml(failingRun());
    expect(html).toContain("Failed assertions");
    expect(html).toContain("<code>200</code>");
    expect(html).toContain("<code>500</code>");
    expect(html).toContain("...(truncated)");
    expect(html).not.toContain("x".repeat(501));
    expect(html).toContain("connect ECONNREFUSED");
    expect(html).toContain("skipped: earlier step failed");
  });

  it("自己完結(外部アセット・script なし)でライト/ダーク/印刷に対応し、meta を表示する", () => {
    const html = formatHtml(failingRun(), {
      meta: { env: "staging", actor: "ci", commit: "abc123" },
    });
    expect(html).not.toMatch(/<script|<link|src=|https?:\/\/[^"' <]*\.(css|js)/);
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("@media print");
    expect(html).toContain("Env: staging");
    expect(html).toContain("Commit: abc123");
  });

  it("secrets を渡すとマスクされた結果だけを出力する", () => {
    const run = buildRunResult([
      buildFlow({
        steps: [
          buildStep({
            name: "s",
            status: "failed",
            request: { method: "GET", url: "http://x/?k=s3cr3t-value", headers: {} },
            assertions: [{ ok: false, kind: "status", message: "token s3cr3t-value" }],
          }),
        ],
      }),
    ]);
    const html = formatHtml(run, { secrets: ["s3cr3t-value"] });
    expect(html).not.toContain("s3cr3t-value");
    expect(html).toContain("***");
  });

  it("escapeHtml は制御文字を可視化する", () => {
    expect(escapeHtml("a\u001Bb")).toBe("a\\x1Bb");
  });

  it("meta(env / actor / commit)も secrets でマスクされる", () => {
    const html = formatHtml(failingRun(), {
      secrets: ["meta-secret-1"],
      meta: { env: "meta-secret-1", actor: "bot-meta-secret-1", commit: "c-meta-secret-1" },
    });
    expect(html).not.toContain("meta-secret-1");
    expect(html).toContain("Env: ***");
  });

  it("動的な値から href / src 属性を生成しない", () => {
    const hostile = `" href="http://evil.example" src="x" onerror="y`;
    const run = buildRunResult([
      buildFlow({
        name: hostile,
        file: hostile,
        steps: [
          buildStep({
            name: hostile,
            status: "failed",
            request: { method: "GET", url: `http://evil.example/${hostile}`, headers: {} },
            assertions: [{ ok: false, kind: "status", message: hostile }],
          }),
        ],
      }),
    ]);
    const html = formatHtml(run, { meta: { env: hostile, actor: hostile, commit: hostile } });
    expect(html).not.toMatch(/<[^>]*\s(href|src|onerror)\s*=/i);
  });

  it("redirects / droppedHeaders を失敗ステップの詳細と、成功ステップの折りたたみに出す", () => {
    const html = formatHtml(
      buildRunResult([
        buildFlow({
          steps: [
            buildStep({
              name: "moved",
              status: "passed",
              redirects: ["http://x/b"],
              droppedHeaders: [{ hop: 1, headers: ["authorization"] }],
            }),
            buildStep({ name: "bad", status: "failed", redirects: ["http://x/z"] }),
            buildStep({ name: "plain", status: "passed" }),
          ],
        }),
      ]),
    );
    expect(html).toContain("<h3>Redirects</h3><pre>http://x/b</pre>");
    expect(html).toContain("<h3>Headers dropped on redirect</h3><pre>hop 1: authorization</pre>");
    expect(html).toContain("<h3>Redirects</h3><pre>http://x/z</pre>");
    // リダイレクトの無い成功ステップは従来どおり折りたたまない
    expect(html.match(/<details class="step"/g)?.length).toBe(2);
  });

  it("warnings があれば警告欄をエスケープして出し、無ければ出さない", () => {
    const run = buildRunResult([buildFlow({ steps: [buildStep({})] })]);
    expect(formatHtml(run)).not.toContain('class="warnings"');
    const html = formatHtml({ ...run, warnings: [`insecure ${PAYLOAD}`] });
    expect(html).toContain('<div class="warnings">');
    expect(html).not.toContain("<script");
  });

  it("スナップショットの不一致は差分の表(基準・今回)で出し、集計行にコミット対象のファイルを載せる", () => {
    const run = buildRunResult([
      buildFlow({
        status: "failed",
        steps: [
          buildStep({
            name: "get",
            status: "failed",
            assertions: [
              {
                ok: false,
                kind: "snapshot",
                message: "snapshot differs",
                snapshot: {
                  key: "get",
                  file: "__snapshots__/a.yaml.snap.json",
                  state: "mismatch",
                  differences: [
                    { path: "$.body.name", kind: "changed", before: "a", after: `<b>` },
                  ],
                  differenceCount: 3,
                },
              },
            ],
          }),
        ],
      }),
    ]);
    const html = formatHtml({
      ...run,
      snapshots: {
        matched: 0,
        written: 1,
        updated: 0,
        mismatched: 1,
        missing: 0,
        obsolete: 0,
        files: ["__snapshots__/new.yaml.snap.json"],
        obsoleteEntries: [],
      },
    });
    expect(html).toContain("Snapshot differences (2 more not shown)");
    expect(html).toContain("<code>$.body.name</code>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).toContain("snapshots: 0 matched, 1 written, 1 mismatched");
    expect(html).toContain("snapshot file written: __snapshots__/new.yaml.snap.json");
  });
});
