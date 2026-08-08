import { describe, expect, it } from "vitest";
import { formatJUnit } from "../../src/cli/reporters/junit.js";
import type { FlowResult, RunResult, StepResult } from "../../src/core/index.js";

function buildStep(overrides: Partial<StepResult>): StepResult {
  return {
    name: "step",
    status: "passed",
    startedAt: new Date().toISOString(),
    durationMs: 12,
    assertions: [],
    ...overrides,
  };
}

function buildFlow(overrides: Partial<FlowResult>): FlowResult {
  return {
    name: "flow",
    file: "flow.yaml",
    status: "passed",
    steps: [],
    durationMs: 100,
    ...overrides,
  };
}

function buildRunResult(flows: FlowResult[]): RunResult {
  return {
    runId: "run-1",
    startedAt: new Date().toISOString(),
    durationMs: 100,
    flows,
    status: "passed",
  };
}

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
});
