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
          name: "skip-me",
          status: "skipped",
          error: "skipped because a previous step failed",
        }),
      ],
    });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: false }));

    expect(parsed.flows[0].steps[0].error).toBe("connect ECONNREFUSED");
    expect(parsed.flows[0].steps[1].error).toBe("skipped because a previous step failed");
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

  it("historyEnabled=true の場合、各ステップに historyRef を付与する", () => {
    const flow = buildFlow({
      steps: [buildStep({ name: "ok", status: "passed", startedAt: "2026-08-08T01:23:45.000Z" })],
    });
    const parsed = JSON.parse(formatJson(buildRunResult([flow]), { historyEnabled: true }));

    expect(parsed.flows[0].steps[0].historyRef).toEqual({
      date: "2026-08-08",
      runId: "run-1",
      step: "ok",
    });
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
});
