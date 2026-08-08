// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseSseStream } from "./sse";
import type { RunResultPayload, StepResultPayload, StepStartPayload } from "./types";

/** SSE テキストの配列を ReadableStream<Uint8Array> にまとめる(意図的に複数チャンクへ分割し、部分受信のパースも検証する) */
function toStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index];
      index += 1;
      if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
    },
  });
}

describe("parseSseStream", () => {
  it("dispatches step-start / step-result / run-result in order, even when split across chunks", async () => {
    const events: string[] = [];
    const received: {
      starts: StepStartPayload[];
      results: StepResultPayload[];
      runResults: RunResultPayload[];
    } = { starts: [], results: [], runResults: [] };

    const message =
      'event: step-start\ndata: {"flow":"認証フロー","file":"api/auth-flow.yaml","step":"login"}\n\n' +
      'event: step-result\ndata: {"flow":"認証フロー","file":"api/auth-flow.yaml","result":{"name":"login","status":"passed","startedAt":"2026-08-07T00:00:00.000Z","durationMs":45,"assertions":[]}}\n\n' +
      'event: step-start\ndata: {"flow":"認証フロー","file":"api/auth-flow.yaml","step":"get-me"}\n\n' +
      'event: step-result\ndata: {"flow":"認証フロー","file":"api/auth-flow.yaml","result":{"name":"get-me","status":"passed","startedAt":"2026-08-07T00:00:01.000Z","durationMs":12,"assertions":[]}}\n\n' +
      'event: run-result\ndata: {"flow":{"name":"認証フロー","file":"api/auth-flow.yaml","status":"passed","steps":[],"durationMs":57}}\n\n';

    // 1文字ずつではなく、任意の境界で分割してストリーミング受信を模す
    const chunks = [message.slice(0, 20), message.slice(20, 60), message.slice(60)];

    await parseSseStream(toStream(chunks), {
      onStepStart: (payload) => {
        events.push("step-start");
        received.starts.push(payload);
      },
      onStepResult: (payload) => {
        events.push("step-result");
        received.results.push(payload);
      },
      onRunResult: (payload) => {
        events.push("run-result");
        received.runResults.push(payload);
      },
    });

    expect(events).toEqual([
      "step-start",
      "step-result",
      "step-start",
      "step-result",
      "run-result",
    ]);
    expect(received.starts.map((s) => s.step)).toEqual(["login", "get-me"]);
    expect(received.results.map((r) => r.result.name)).toEqual(["login", "get-me"]);
    expect(received.results.map((r) => r.result.status)).toEqual(["passed", "passed"]);
    expect(received.runResults[0]?.flow.status).toBe("passed");
  });

  it("ignores unknown event types", async () => {
    const message = 'event: unknown-thing\ndata: {"foo":"bar"}\n\n';
    let called = false;

    await parseSseStream(toStream([message]), {
      onStepStart: () => {
        called = true;
      },
    });

    expect(called).toBe(false);
  });
});
