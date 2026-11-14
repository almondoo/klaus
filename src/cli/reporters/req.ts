import { z } from "zod";
import type { StepResult } from "../../core/index.js";
import { historyDateFromTimestamp } from "../../core/index.js";
import {
  buildEvents,
  buildRequest,
  buildResponse,
  historyRefSchema,
  jsonRequestSnapshotSchema,
  jsonResponseSnapshotSchema,
  jsonSseEventSchema,
} from "./json.js";
import { sanitizeForTerminal } from "./sanitize.js";
import { truncate } from "./text.js";

/**
 * `klaus req --json` の出力ペイロード(v1)。zod スキーマとして定義し、型は z.infer で導出する
 * (src/cli/schema.ts の buildReqReportJsonSchema() から JSON Schema を生成するため)。
 * run のステップ出力(jsonStepReportSchema)と同じ名前・同じ部分スキーマを使う。run と異なり、
 * 応答の確認そのものが目的のため、成功時も request / response を省略しない(body は 500 文字で切り詰め)。
 * アサーションを持たないため status は「応答を受信した(passed)」か「送信エラー・安全柵による拒否(error)」のみ。
 * version: 後方互換が壊れる変更(フィールド削除・型変更等)をする場合は値を上げること。
 */
export const reqReportSchema = z
  .strictObject({
    version: z
      .literal(1)
      .describe(
        "Schema version of this JSON payload. Increases only when a backward-incompatible change is made (field removal, type change, semantics change).",
      ),
    status: z
      .enum(["passed", "error"])
      .describe(
        '"passed" when an HTTP response was received (any HTTP status code; there are no assertions), "error" when the request could not be sent or was refused by a guard.',
      ),
    startedAt: z.string().describe("ISO 8601 timestamp when the request started."),
    durationMs: z.number().describe("Request duration in milliseconds (rounded)."),
    request: jsonRequestSnapshotSchema
      .optional()
      .describe(
        "Request as sent, with templates expanded. Omitted only when the request could not be built (e.g. an unresolved template variable).",
      ),
    response: jsonResponseSnapshotSchema
      .optional()
      .describe("Response snapshot. Present only when a response was received."),
    events: z
      .array(jsonSseEventSchema)
      .optional()
      .describe(
        "Received SSE events, in order. Present only when the request carried `Accept: text/event-stream`.",
      ),
    error: z.string().optional().describe("Runtime error message or guard refusal reason."),
    historyRef: historyRefSchema
      .optional()
      .describe(
        "Pointer into the JSONL history file for the full record (`klaus history show <runId> --step request`). Present only when a history entry was actually written.",
      ),
  })
  .describe(
    "klaus `req --json` output (v1). Request and response bodies are truncated to 500 characters; use historyRef with `klaus history show` to retrieve full content when history recording is enabled.",
  );
export type ReqReport = z.infer<typeof reqReportSchema>;

/** 履歴エントリへのポインタの材料(履歴が実際に書き込まれた場合のみ渡す) */
export interface ReqHistoryLink {
  runId: string;
}

/**
 * 単発リクエストの StepResult を req の JSON 出力形に整形する。
 * 呼び出し側は、シークレットをマスク済みの StepResult を渡すこと(切り詰め前にマスクするため)。
 */
export function buildReqReport(result: StepResult, history?: ReqHistoryLink): ReqReport {
  return {
    version: 1,
    status: result.status === "error" ? "error" : "passed",
    startedAt: result.startedAt,
    durationMs: Math.round(result.durationMs),
    request: buildRequest(result.request),
    response: buildResponse(result.response),
    events: buildEvents(result.events),
    error: result.error,
    historyRef: history
      ? {
          date: historyDateFromTimestamp(result.startedAt),
          runId: history.runId,
          step: result.name,
        }
      : undefined,
  };
}

/** req の JSON 出力(compact。run と同じく pretty print しない) */
export function formatReqJson(report: ReqReport): string {
  return JSON.stringify(report);
}

/** body を文字列表現にして端末向けにサニタイズ・切り詰めする */
function formatBodyText(body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return truncate(sanitizeForTerminal(text));
}

/**
 * req の text 出力。応答を受信した場合は「メソッド URL -> ステータス (所要時間)」の1行に続けて
 * 応答ヘッダー・ボディを出し、送信エラー・拒否の場合は run の ERROR 行と同じ形で出す。
 * 外部由来の文字列(URL・ヘッダー・ボディ・エラー)はすべて端末向けにサニタイズする。
 * 呼び出し側は、シークレットをマスク済みの StepResult を渡すこと。
 */
export function formatReqText(result: StepResult, history?: ReqHistoryLink): string {
  const lines: string[] = [];
  const request = result.request;
  const requestLine = request ? `${request.method} ${sanitizeForTerminal(request.url)}` : undefined;
  const durationMs = Math.round(result.durationMs);

  if (result.status === "error") {
    if (requestLine) lines.push(requestLine);
    lines.push(`ERROR: ${truncate(sanitizeForTerminal(result.error ?? "unknown error"))}`);
  } else {
    lines.push(
      `${requestLine ?? "request"} -> ${result.response?.status ?? "-"} (${durationMs}ms)`,
    );
    for (const [name, value] of Object.entries(result.response?.headers ?? {})) {
      lines.push(`< ${sanitizeForTerminal(name)}: ${sanitizeForTerminal(value)}`);
    }
    if (result.response?.body !== undefined && result.response.body !== "") {
      lines.push("", formatBodyText(result.response.body));
    }
    for (const event of result.events ?? []) {
      lines.push(`event: ${truncate(sanitizeForTerminal(event.data))}`);
    }
  }

  if (history) {
    lines.push("", `history: klaus history show ${history.runId} --step ${result.name}`);
  }
  return `${lines.join("\n")}\n`;
}
