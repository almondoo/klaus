import { describe, expect, it } from "vitest";
import { formatJson, jsonReportSchema } from "../../src/cli/reporters/json.js";
import { buildFlow, buildRunResult, buildStep } from "./reporters-fixtures.js";

describe("formatJson", () => {
  it("compact(改行なし)な JSON を1行で返す", () => {
    const json = formatJson(buildRunResult([buildFlow({})]), { historyEnabled: false });
    expect(json).not.toContain("\n");
  });

  it("version 2 とトップレベルの要約情報を含む", () => {
    const flow = buildFlow({
      steps: [
        buildStep({ name: "ok", status: "passed" }),
        buildStep({ name: "ng", status: "failed" }),
      ],
    });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: false }));

    expect(parsed.version).toBe(2);
    expect(parsed.runId).toBe("run-1");
    expect(parsed.status).toBe("passed");
    expect(parsed.summary).toEqual({
      flows: 1,
      steps: 2,
      passed: 1,
      failed: 1,
      error: 0,
      skipped: 0,
    });
  });

  it("passed ステップは name/status/durationMs のみの1行要約に落とす", () => {
    const flow = buildFlow({
      steps: [
        buildStep({
          name: "login",
          status: "passed",
          durationMs: 6,
          request: { method: "POST", url: "http://x", headers: {}, body: { a: 1 } },
          response: { status: 200, headers: {}, body: { ok: true } },
          assertions: [{ ok: true, kind: "status", expected: 200, actual: 200, message: "ok" }],
        }),
      ],
    });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: false }));
    const step = parsed.flows[0].steps[0];

    expect(step).toEqual({ name: "login", status: "passed", durationMs: 6 });
  });

  it("failed ステップは request/response/assertions を含む詳細を持つ", () => {
    const flow = buildFlow({
      steps: [
        buildStep({
          name: "get-me",
          status: "failed",
          durationMs: 30,
          request: { method: "GET", url: "http://x/me", headers: {}, body: undefined },
          response: { status: 200, headers: {}, body: { email: "c@d.com" } },
          assertions: [
            {
              ok: false,
              kind: "body.equals",
              expected: "a@b.com",
              actual: "c@d.com",
              message: 'body path "$.email": expected "a@b.com" but got "c@d.com"',
            },
          ],
        }),
      ],
    });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: false }));
    const step = parsed.flows[0].steps[0];

    expect(step.status).toBe("failed");
    expect(step.request).toEqual({ method: "GET", url: "http://x/me", headers: {} });
    expect(step.response).toEqual({ status: 200, headers: {}, body: '{"email":"c@d.com"}' });
    expect(step.assertions).toHaveLength(1);
    expect(step.assertions[0].message).toContain("expected");
  });

  it("error/skipped ステップも詳細(error メッセージ等)を含む", () => {
    const flow = buildFlow({
      steps: [
        buildStep({ name: "ping", status: "error", error: "connect ECONNREFUSED" }),
        buildStep({
          name: "blocked",
          status: "error",
          error: "refused",
          errorCode: "guard.allowed-hosts",
        }),
        buildStep({
          name: "skip-me",
          status: "skipped",
          error: "skipped because a previous step failed",
        }),
      ],
    });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: false }));

    expect(parsed.flows[0].steps[0].error).toBe("connect ECONNREFUSED");
    expect(parsed.flows[0].steps[2].error).toBe("skipped because a previous step failed");
    // errorCode はコードを持つ error ステップにだけ出る
    expect(parsed.flows[0].steps[0]).not.toHaveProperty("errorCode");
    expect(parsed.flows[0].steps[1].errorCode).toBe("guard.allowed-hosts");
    expect(parsed.flows[0].steps[2]).not.toHaveProperty("errorCode");
  });

  it("request/response ボディが 500 文字を超えると truncate される", () => {
    const longBody = "x".repeat(1000);
    const flow = buildFlow({
      steps: [
        buildStep({
          name: "big-body",
          status: "failed",
          response: { status: 200, headers: {}, body: longBody },
          assertions: [
            { ok: false, kind: "bodyText", expected: "y", actual: longBody, message: "ng" },
          ],
        }),
      ],
    });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: false }));
    const body = parsed.flows[0].steps[0].response.body as string;

    expect(body.length).toBeLessThan(longBody.length);
    expect(body).toContain("...(truncated)");
  });

  it("SSE events の data / WS wsMessages の data も truncate される", () => {
    const longData = "e".repeat(1000);
    const flow = buildFlow({
      steps: [
        buildStep({
          name: "sse-step",
          status: "failed",
          events: [{ event: "message", data: longData }],
          wsMessages: [{ data: longData }],
          assertions: [{ ok: false, kind: "events", expected: 1, actual: 0, message: "ng" }],
        }),
      ],
    });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: false }));
    const step = parsed.flows[0].steps[0];

    expect((step.events[0].data as string).length).toBeLessThan(longData.length);
    expect(step.events[0].data).toContain("...(truncated)");
    expect((step.wsMessages[0].data as string).length).toBeLessThan(longData.length);
  });

  it("historyEnabled=true の場合、履歴に記録されたステップに historyRef を付与する", () => {
    const flow = buildFlow({
      steps: [
        buildStep({
          name: "ok",
          status: "passed",
          startedAt: "2026-08-08T01:23:45.000Z",
          historyRecorded: true,
        }),
      ],
    });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: true }));

    expect(parsed.flows[0].steps[0].historyRef).toEqual({
      date: "2026-08-08",
      runId: "run-1",
      step: "ok",
    });
  });

  it("historyEnabled=true かつ FlowResult.iteration が設定されている場合(--data 実行時)、historyRef.iteration に反映される", () => {
    const flow = buildFlow({
      iteration: 2,
      steps: [
        buildStep({
          name: "ok",
          status: "passed",
          startedAt: "2026-08-08T01:23:45.000Z",
          historyRecorded: true,
        }),
      ],
    });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: true }));

    expect(parsed.flows[0].steps[0].historyRef).toEqual({
      date: "2026-08-08",
      runId: "run-1",
      step: "ok",
      iteration: 2,
    });
  });

  it("historyEnabled=true かつ FlowResult.iteration が未設定の場合(通常実行)、historyRef.iteration キー自体が存在しない", () => {
    const flow = buildFlow({
      steps: [
        buildStep({
          name: "ok",
          status: "passed",
          startedAt: "2026-08-08T01:23:45.000Z",
          historyRecorded: true,
        }),
      ],
    });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: true }));

    expect(Object.hasOwn(parsed.flows[0].steps[0].historyRef, "iteration")).toBe(false);
  });

  it("historyEnabled=true でも、履歴に記録されなかったステップ(キャプチャ失敗などの error)には historyRef を付けない", () => {
    const flow = buildFlow({
      steps: [
        buildStep({ name: "recorded", status: "failed", historyRecorded: true }),
        buildStep({
          name: "capture-failed",
          status: "error",
          error: 'capture "token" failed: path "$.token" not found',
        }),
        buildStep({ name: "skipped-recorded", status: "skipped", historyRecorded: true }),
      ],
    });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: true }));

    const refs = parsed.flows[0].steps.map((step: { historyRef?: unknown }) => step.historyRef);
    expect(refs[0]).toMatchObject({ runId: "run-1", step: "recorded" });
    expect(refs[1]).toBeUndefined();
    expect(Object.hasOwn(parsed.flows[0].steps[1], "historyRef")).toBe(false);
    expect(refs[2]).toMatchObject({ step: "skipped-recorded" });
    expect(() => jsonReportSchema.parse(parsed)).not.toThrow();
  });

  it("historyEnabled=false の場合、historyRef を省略する", () => {
    const flow = buildFlow({ steps: [buildStep({ name: "ok", status: "passed" })] });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: false }));

    expect(parsed.flows[0].steps[0].historyRef).toBeUndefined();
  });

  it("FlowResult.iteration が設定されている場合(--data 実行時)、flows[].iteration に反映される", () => {
    const flow = buildFlow({ iteration: 2, steps: [buildStep({ name: "ok", status: "passed" })] });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: false }));

    expect(parsed.flows[0].iteration).toBe(2);
  });

  it("FlowResult.iteration が未設定の場合(通常実行)、flows[].iteration キー自体が存在しない(null ではなくキー省略)", () => {
    const flow = buildFlow({ steps: [buildStep({ name: "ok", status: "passed" })] });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: false }));

    expect(Object.hasOwn(parsed.flows[0], "iteration")).toBe(false);
  });

  it("実出力は jsonReportSchema(zod)の検証を通る", () => {
    const flow = buildFlow({
      steps: [
        buildStep({ name: "ok", status: "passed" }),
        buildStep({
          name: "ng",
          status: "failed",
          request: { method: "GET", url: "http://x", headers: {}, body: undefined },
          response: { status: 500, headers: {}, body: "boom" },
          events: [{ event: "message", data: "e" }],
          wsMessages: [{ data: "m" }],
          assertions: [{ ok: false, kind: "status", expected: 200, actual: 500, message: "ng" }],
          error: "assertion failed",
        }),
      ],
    });
    const parsed = JSON.parse(
      formatJson(buildRunResult([flow]), { historyEnabled: true }),
    ) as unknown;

    expect(() => jsonReportSchema.parse(parsed)).not.toThrow();
  });

  it("redirects / droppedHeaders を持つステップは、成否に関わらず JSON に載せる(持たないステップには出さない)", () => {
    const redirected = {
      redirects: ["http://x/b", "http://x/c"],
      droppedHeaders: [{ hop: 1, headers: ["authorization"] }],
    };
    const flow = buildFlow({
      steps: [
        buildStep({ name: "plain", status: "passed" }),
        buildStep({ name: "moved", status: "passed", ...redirected }),
        buildStep({ name: "bad", status: "failed", ...redirected }),
      ],
    });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: false }));

    expect(Object.hasOwn(parsed.flows[0].steps[0], "redirects")).toBe(false);
    expect(Object.hasOwn(parsed.flows[0].steps[0], "droppedHeaders")).toBe(false);
    for (const step of parsed.flows[0].steps.slice(1)) {
      expect(step.redirects).toEqual(["http://x/b", "http://x/c"]);
      expect(step.droppedHeaders).toEqual([{ hop: 1, headers: ["authorization"] }]);
    }
    expect(() => jsonReportSchema.parse(parsed)).not.toThrow();
  });

  it("warnings は 1 件以上あるときだけトップレベルに載せる", () => {
    const flow = buildFlow({ steps: [buildStep({})] });
    const without = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: false }));
    expect(Object.hasOwn(without, "warnings")).toBe(false);

    const withWarnings = JSON.parse(
      formatJson(
        { ...buildRunResult([flow]), warnings: ["tls.insecure is enabled"] },
        { historyEnabled: false },
      ),
    );
    expect(withWarnings.warnings).toEqual(["tls.insecure is enabled"]);
    expect(() => jsonReportSchema.parse(withWarnings)).not.toThrow();
  });
});
