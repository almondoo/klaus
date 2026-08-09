import {
  buildMockSingleRequestResult,
  buildMockStepResult,
  mockEnvironmentDetails,
  mockEnvironments,
  mockFlowDetails,
  mockFlows,
  mockHistory,
} from "./fixtures";
/**
 * VITE_KLAUS_MOCK=1 のときに使う API 実装。real.ts と同じ関数シグネチャを提供し、
 * fetch は一切行わず fixtures.ts のデータと setTimeout で疑似 SSE 進捗を返す。
 */
import { ApiError } from "./http";
import type { RunStreamCallbacks } from "./sse";
import type {
  EnvironmentCaptureRequestBody,
  EnvironmentDetail,
  EnvironmentListEntry,
  FlowDetail,
  FlowListEntry,
  FlowResult,
  GetHistoryParams,
  HistoryPage,
  RunRequestBody,
  SingleRequestRequestBody,
  SingleRequestResultPayload,
  StepResult,
} from "./types";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getFlows(): Promise<FlowListEntry[]> {
  await delay(150);
  return mockFlows;
}

export async function getFlowDetail(path: string): Promise<FlowDetail> {
  await delay(100);
  const detail = mockFlowDetails[path];
  if (!detail) throw new ApiError(404, `flow not found: ${path}`);
  return detail;
}

export async function getEnvironments(): Promise<EnvironmentListEntry[]> {
  await delay(80);
  return mockEnvironments;
}

export async function getEnvironmentDetail(name: string): Promise<EnvironmentDetail> {
  await delay(80);
  const detail = mockEnvironmentDetails[name];
  if (!detail) throw new ApiError(404, `environment not found: ${name}`);
  return { name: detail.name, values: { ...detail.values } };
}

/** PUT /api/environments/:name のモック。fixtures.ts のフィクスチャを直接書き換えて保存を再現する */
export async function updateEnvironment(
  name: string,
  values: Record<string, string>,
): Promise<EnvironmentDetail> {
  await delay(80);
  const detail = mockEnvironmentDetails[name];
  if (!detail) throw new ApiError(404, `environment not found: ${name}`);
  detail.values = { ...values };
  return { name, values: { ...values } };
}

/**
 * mock 用の簡易 JSONPath 評価。ドット区切りのプロパティアクセスと配列添字([0] 等)のみ対応する。
 * 本番の抽出は server 側の jsonpath-plus(既存依存)が担い、UI へ新規依存は追加できないため、
 * mock では代表的な用途("$.token" のような単純パス)が動作すれば十分という前提で自前実装する。
 * 未対応の記法(フィルタ式など)や解決失敗時は undefined を返す。
 */
function evaluateSimplePath(path: string, json: unknown): unknown {
  const withoutRoot = path.trim().replace(/^\$/, "");
  if (withoutRoot === "") return json;

  const tokens = withoutRoot.match(/\.[^.[\]]+|\[\d+\]/g);
  if (!tokens) return undefined;

  let current: unknown = json;
  for (const token of tokens) {
    if (current === undefined || current === null) return undefined;
    if (token.startsWith(".")) {
      if (typeof current !== "object" || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[token.slice(1)];
    } else {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(token.slice(1, -1))];
    }
  }
  return current;
}

/** POST /api/environments/:name/capture のモック。簡易 JSONPath 評価で抽出した値を fixtures.ts に反映する */
export async function captureToEnvironment(
  name: string,
  body: EnvironmentCaptureRequestBody,
): Promise<EnvironmentDetail> {
  await delay(80);
  const detail = mockEnvironmentDetails[name];
  if (!detail) throw new ApiError(404, `environment not found: ${name}`);
  if (!body.key.trim()) throw new ApiError(400, "key is required");

  const value = evaluateSimplePath(body.path, body.json);
  if (value === undefined) {
    throw new ApiError(
      400,
      `capture "${body.key}": JSONPath "${body.path}" にマッチする値がありません`,
    );
  }
  if (typeof value === "object") {
    throw new ApiError(
      400,
      `抽出した値を環境変数として保存できません(オブジェクト・配列・null は非対応です): key="${body.key}"`,
    );
  }

  detail.values = { ...detail.values, [body.key]: String(value) };
  return { name, values: { ...detail.values } };
}

const HISTORY_DEFAULT_LIMIT = 20;

export async function getHistory(params: GetHistoryParams = {}): Promise<HistoryPage> {
  await delay(120);
  const limit = params.limit ?? HISTORY_DEFAULT_LIMIT;

  let entries = [...mockHistory].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (params.flow) entries = entries.filter((e) => e.flow === params.flow);
  if (params.before) entries = entries.filter((e) => e.startedAt < (params.before as string));

  const page = entries.slice(0, limit);
  const nextBefore = entries.length > limit ? page[page.length - 1]?.startedAt : undefined;
  return { entries: page, nextBefore };
}

/** POST /api/runs のモック。setTimeout で step-start/step-result を逐次流し、最後に run-result を返す */
export function runFlow(
  body: RunRequestBody,
  callbacks: RunStreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const detail = mockFlowDetails[body.path];
    if (!detail) {
      reject(new ApiError(404, `flow not found: ${body.path}`));
      return;
    }

    let cancelled = false;
    signal?.addEventListener("abort", () => {
      cancelled = true;
      resolve();
    });

    const results: StepResult[] = [];
    let index = 0;

    const runNext = () => {
      if (cancelled) return;

      if (index >= detail.steps.length) {
        const flowResult: FlowResult = {
          name: detail.name,
          file: detail.path,
          status: results.some((r) => r.status === "failed" || r.status === "error")
            ? "failed"
            : "passed",
          steps: results,
          durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
        };
        callbacks.onRunResult?.({ flow: flowResult });
        resolve();
        return;
      }

      const step = detail.steps[index];
      if (!step) return;
      callbacks.onStepStart?.({ flow: detail.name, file: detail.path, step: step.name });

      // 実行中インジケータを確認できるよう 300ms 以上のランダムな待ちを入れる
      const waitMs = 350 + Math.random() * 500;
      setTimeout(() => {
        if (cancelled) return;
        const result = buildMockStepResult(detail.path, step.name);
        results.push(result);
        callbacks.onStepResult?.({ flow: detail.name, file: detail.path, result });

        // 前ステップが失敗/エラーならフローを中断し、残りは skipped として流す
        if (result.status === "failed" || result.status === "error") {
          const remaining = detail.steps.slice(index + 1);
          for (const skippedStep of remaining) {
            const skippedResult: StepResult = {
              name: skippedStep.name,
              status: "skipped",
              startedAt: new Date().toISOString(),
              durationMs: 0,
              assertions: [],
              error: "skipped because a previous step failed",
            };
            results.push(skippedResult);
            callbacks.onStepStart?.({
              flow: detail.name,
              file: detail.path,
              step: skippedStep.name,
            });
            callbacks.onStepResult?.({
              flow: detail.name,
              file: detail.path,
              result: skippedResult,
            });
          }
          index = detail.steps.length;
          runNext();
          return;
        }

        index += 1;
        runNext();
      }, waitMs);
    };

    runNext();
  });
}

/** POST /api/request のモック。実 fetch は行わず、入力を echo した StepResult を返す */
export async function runSingleRequest(
  body: SingleRequestRequestBody,
): Promise<SingleRequestResultPayload> {
  await delay(200);
  return { result: buildMockSingleRequestResult(body) };
}
