/**
 * POST /api/runs が使うロジック。
 * core の executeFlow の onStepStart/onStepComplete コールバックを SSE イベントへブリッジする。
 * 実行・アサーション・履歴ロジック自体は core にしかない(ここでは再実装しない)。
 */
import type { Context } from "hono";
import type { SSEMessage, SSEStreamingApi } from "hono/streaming";
import { streamSSE } from "hono/streaming";
import type { FlowResult } from "../../core/index.js";
import { executeFlow, loadFlow, ParseError } from "../../core/index.js";
import type { RunRequestBody } from "../types.js";
import { resolveWithinCwd } from "./flows.js";

/**
 * stream.writeSSE を安全に呼び出すラッパーを作る。
 * クライアント切断後(node-bridge が reader を cancel した後)は
 * hono の StreamingApi.write が内部で書き込みエラーを握りつぶし、
 * 例外を投げずに stream.aborted フラグだけを立てて即座に解決する。
 * そのため例外の有無ではなく aborted フラグで切断を検知し、以降の書き込みを no-op 化する。
 * これによりフロー実行自体(ステップ実行・履歴書き込み)は最後まで継続できる。
 */
function createSafeSseWriter(stream: SSEStreamingApi): (message: SSEMessage) => Promise<void> {
  let disconnected = false;
  const warnOnce = () => {
    if (disconnected) return;
    disconnected = true;
    process.stderr.write(
      "klaus ui: warning: client disconnected during SSE run; continuing flow execution\n",
    );
  };

  return async (message) => {
    if (disconnected || stream.aborted || stream.closed) {
      warnOnce();
      return;
    }
    try {
      await stream.writeSSE(message);
    } catch {
      // hono の write() は通常ここで例外を投げないが、念のため捕捉して no-op 化に倒す
      warnOnce();
      return;
    }
    if (stream.aborted) {
      warnOnce();
    }
  };
}

/** POST /api/runs: フローを実行し、SSE で step-start/step-result/run-result を配信する */
export async function handleRunRequest(c: Context, cwd: string): Promise<Response> {
  let body: RunRequestBody;
  try {
    body = (await c.req.json()) as RunRequestBody;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body.path !== "string" || body.path.length === 0) {
    return c.json({ error: "path is required" }, 400);
  }

  const resolvedPath = resolveWithinCwd(cwd, body.path);
  if (!resolvedPath) {
    return c.text("Forbidden: path traversal detected", 403);
  }
  // env は environments/<name>.yaml に展開されるため、パス区切り・親参照を含む値を拒否する
  // (path と同じく untrusted 入力。cwd 外の *.yaml 読み出し防止)
  if (body.env !== undefined && !/^[A-Za-z0-9_-]+$/.test(body.env)) {
    return c.text("Forbidden: invalid env name", 403);
  }
  const requestedPath = body.path;
  const envNameOverride = body.env;

  return streamSSE(c, async (stream) => {
    const safeWriteSSE = createSafeSseWriter(stream);
    let flowResult: FlowResult;
    try {
      const flow = await loadFlow(resolvedPath);
      flowResult = await executeFlow(flow, resolvedPath, {
        cwd,
        envNameOverride,
        // UI からの実行でも履歴書き込みは既定どおり有効にする(明示しておく)
        history: true,
        onStepStart: async (context) => {
          await safeWriteSSE({
            event: "step-start",
            data: JSON.stringify({ flow: context.flow, file: context.file, step: context.step }),
          });
        },
        onStepComplete: async (context) => {
          await safeWriteSSE({
            event: "step-result",
            data: JSON.stringify({
              flow: context.flow,
              file: context.file,
              result: context.result,
            }),
          });
        },
        // ステップの成否に影響しない警告(履歴書き込み失敗など)はサーバーログ(stderr)へ流す
        onWarning: (message) => {
          process.stderr.write(`klaus ui: warning: ${message}\n`);
        },
      });
    } catch (error) {
      // フロー定義・環境ファイルのパースエラーなど、ステップループに入る前の失敗をここで拾う
      // (通常の実行時エラーは executeFlow 内で StepResult.error に格納され、ここには来ない)
      const message = error instanceof ParseError ? error.message : String(error);
      process.stderr.write(`klaus ui: run failed: ${message}\n`);
      flowResult = {
        name: requestedPath,
        file: resolvedPath,
        status: "error",
        steps: [
          {
            name: "(flow load)",
            status: "error",
            startedAt: new Date().toISOString(),
            durationMs: 0,
            assertions: [],
            error: message,
          },
        ],
        durationMs: 0,
      };
    }

    await safeWriteSSE({
      event: "run-result",
      data: JSON.stringify({ flow: flowResult }),
    });
  });
}
