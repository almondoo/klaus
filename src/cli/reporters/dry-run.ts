import { z } from "zod";
import type { DryRunResult, DryRunStepResult, RequestSnapshot } from "../../core/index.js";
import { sanitizeForTerminal } from "./sanitize.js";
import { formatFlowHeader } from "./text.js";

/**
 * `klaus run --dry-run --json` の出力ペイロード(v1)。zod スキーマとして定義し、型は z.infer で導出する
 * (src/cli/schema.ts の buildDryRunReportJsonSchema() から JSON Schema を生成するため)。
 * run の JSON 出力(jsonReportSchema)と同じく flows[].steps[] の入れ子で、フロー・ステップ・iteration の
 * フィールド名を揃えてある。run と異なり、リクエストを送らないため status / assertions / historyRef は持たず、
 * request の body も切り詰めない(dry-run では履歴から全文を引き直せないため)。
 * version: 後方互換が壊れる変更(フィールド削除・型変更等)をする場合は値を上げること。
 */

/** 展開後の request の JSON 出力形。body は文字列表現(JSON.stringify)で、run と異なり切り詰めない */
const dryRunRequestSchema = z.strictObject({
  method: z.string().describe('HTTP method after expansion ("WS" for WebSocket steps).'),
  url: z
    .string()
    .describe(
      "Request URL after template expansion and query merging. Variables that depend on an earlier step's capture stay as {{name}}.",
    ),
  headers: z.record(z.string(), z.string()).describe("Request headers after template expansion."),
  body: z
    .string()
    .optional()
    .describe(
      "Request body after expansion, stringified (JSON.stringify for objects), not truncated. For WebSocket steps, the messages that would be sent (a JSON array).",
    ),
});

const dryRunStepSchema = z.strictObject({
  name: z.string().describe("Step name."),
  kind: z
    .enum(["http", "sse", "ws"])
    .describe(
      "Step kind: http, sse (Accept: text/event-stream or an sse block), or ws (WebSocket).",
    ),
  request: dryRunRequestSchema
    .optional()
    .describe(
      "The expanded request. Omitted when `error` is set (the expansion fails at run time).",
    ),
  unresolved: z
    .array(z.string())
    .describe(
      "Names of variables that depend on a capture from an earlier step and so stay as {{name}} in `request`. Not an error. Empty when everything was resolved.",
    ),
  conditional: z
    .boolean()
    .describe(
      "True when the step has an `if` condition. It is not evaluated in dry-run (it depends on run-time statuses and captures), so the step may or may not run.",
    ),
  if: z.string().optional().describe("The `if` condition text. Present only when `conditional`."),
  guard: z
    .strictObject({
      status: z
        .enum(["allowed", "refused", "undetermined"])
        .describe(
          'Result of the same guard checks as at run time ($protected, guard.allowedHosts). "undetermined" when the target host depends on an unresolved variable.',
        ),
      reason: z
        .string()
        .optional()
        .describe("Why the step would be refused, or why the check is undetermined."),
    })
    .describe("What the guards would decide for this step if it ran now."),
  error: z
    .string()
    .optional()
    .describe(
      "Expansion error that would also occur at run time (a variable that is neither captured by an earlier step nor in the environment, or an undefined OS environment variable). Same message as at run time.",
    ),
});

const dryRunFlowSchema = z.strictObject({
  name: z.string().describe("Flow name."),
  file: z.string().describe("Path to the flow YAML file."),
  iteration: z
    .number()
    .optional()
    .describe("1-based data-driven iteration number, present only when `--data` was used."),
  steps: z.array(dryRunStepSchema).describe("Per-step results, in definition order."),
});

export const dryRunReportSchema = z
  .strictObject({
    version: z
      .literal(1)
      .describe(
        "Schema version of this JSON payload. Increases only when a backward-incompatible change is made (field removal, type change, semantics change).",
      ),
    dryRun: z
      .literal(true)
      .describe("Always true. Marks this output as a dry run: nothing was sent."),
    status: z
      .enum(["ok", "error"])
      .describe(
        '"error" (exit code 3) when any step would be refused by a guard or fails to expand at run time, otherwise "ok" (exit code 0).',
      ),
    summary: z
      .strictObject({
        flows: z.number().describe("Number of flow units (flow files, times data rows)."),
        steps: z.number().describe("Total number of steps."),
        refused: z.number().describe("Steps a guard would refuse."),
        undetermined: z
          .number()
          .describe("Steps whose guard check is undetermined (host not yet known)."),
        unresolved: z
          .number()
          .describe("Steps that still contain variables depending on earlier captures."),
        errors: z.number().describe("Steps whose expansion fails at run time."),
      })
      .describe("Aggregate counts."),
    flows: z
      .array(dryRunFlowSchema)
      .describe("Per-flow results, in the same order as `klaus run`."),
  })
  .describe(
    "klaus `run --dry-run --json` output (v1). Nothing is sent, no history is written, no assertions are evaluated.",
  );
export type DryRunReport = z.infer<typeof dryRunReportSchema>;

function stringifyBody(body: unknown): string | undefined {
  if (body === undefined) return undefined;
  return typeof body === "string" ? body : JSON.stringify(body);
}

function buildRequest(
  request: RequestSnapshot,
): NonNullable<DryRunReport["flows"][number]["steps"][number]["request"]> {
  return {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: stringifyBody(request.body),
  };
}

function isError(step: DryRunStepResult): boolean {
  return step.guard.status === "refused" || step.error !== undefined;
}

/**
 * dry-run の結果が exit code 3 相当か(拒否されるステップ、または実行時にも失敗する展開エラーがある)。
 * 履歴を書かない・アサーションを評価しないため、run の 4(アサーション失敗)に相当するものは無い
 */
export function hasDryRunFailure(result: DryRunResult): boolean {
  return result.flows.some((flow) => flow.steps.some(isError));
}

/**
 * DryRunResult を CLI の JSON 出力形式(v1)に整形する。
 * 呼び出し側は、シークレットをマスク済みの DryRunResult を渡すこと。
 */
export function buildDryRunReport(result: DryRunResult): DryRunReport {
  const steps = result.flows.flatMap((flow) => flow.steps);
  return {
    version: 1,
    dryRun: true,
    status: hasDryRunFailure(result) ? "error" : "ok",
    summary: {
      flows: result.flows.length,
      steps: steps.length,
      refused: steps.filter((s) => s.guard.status === "refused").length,
      undetermined: steps.filter((s) => s.guard.status === "undetermined").length,
      unresolved: steps.filter((s) => s.unresolved.length > 0).length,
      errors: steps.filter((s) => s.error !== undefined).length,
    },
    flows: result.flows.map((flow) => ({
      name: flow.name,
      file: flow.file,
      iteration: flow.iteration,
      steps: flow.steps.map((step) => ({
        name: step.name,
        kind: step.kind,
        request: step.request ? buildRequest(step.request) : undefined,
        unresolved: step.unresolved,
        conditional: step.conditional,
        if: step.if,
        guard: step.guard,
        error: step.error,
      })),
    })),
  };
}

/** dry-run の JSON 出力(compact。run と同じく pretty print しない) */
export function formatDryRunJson(report: DryRunReport): string {
  return JSON.stringify(report);
}

/** 1 ステップ分の text 行(インデント済み)。外部由来の文字列は端末向けにサニタイズする */
function formatStepText(step: DryRunStepResult): string[] {
  const san = sanitizeForTerminal;
  const lines: string[] = [];
  const head = step.request
    ? `${step.request.method} ${san(step.request.url)}`
    : `(${step.kind} request could not be expanded)`;
  lines.push(`  ${san(step.name)}: ${head}`);
  for (const [name, value] of Object.entries(step.request?.headers ?? {})) {
    lines.push(`    > ${san(name)}: ${san(value)}`);
  }
  const body = stringifyBody(step.request?.body);
  if (body !== undefined && body !== "") {
    lines.push(`    body: ${san(body)}`);
  }
  if (step.unresolved.length > 0) {
    lines.push(
      `    unresolved: ${step.unresolved.map(san).join(", ")} (depends on an earlier capture)`,
    );
  }
  if (step.conditional) {
    lines.push(`    conditional: if ${san(step.if ?? "")} (not evaluated in dry-run)`);
  }
  if (step.error !== undefined) {
    lines.push(`    ERROR: ${san(step.error)}`);
  }
  const reason = step.guard.reason !== undefined ? ` - ${san(step.guard.reason)}` : "";
  const guardLabel =
    step.guard.status === "refused"
      ? "REFUSED"
      : step.guard.status === "undetermined"
        ? "undetermined"
        : "allowed";
  lines.push(`    guard: ${guardLabel}${reason}`);
  return lines;
}

/**
 * dry-run の text 出力(人間向け)。フローごとにヘッダー行(run と同じ形)を出し、続けて各ステップの
 * 展開後リクエストと判定結果を出す。最後に件数のサマリー行を付ける。
 * 呼び出し側は、シークレットをマスク済みの DryRunResult を渡すこと。
 */
export function formatDryRunText(result: DryRunResult): string {
  const lines: string[] = [];
  for (const flow of result.flows) {
    lines.push("", formatFlowHeader(flow.name, flow.file, flow.iteration));
    for (const step of flow.steps) {
      lines.push(...formatStepText(step));
    }
  }
  const report = buildDryRunReport(result);
  const { summary } = report;
  const flowWord = summary.flows === 1 ? "flow" : "flows";
  const stepWord = summary.steps === 1 ? "step" : "steps";
  lines.push(
    "",
    `dry run (nothing was sent): ${summary.flows} ${flowWord}, ${summary.steps} ${stepWord}: ` +
      `${summary.refused} refused, ${summary.undetermined} undetermined, ` +
      `${summary.unresolved} with unresolved variables, ${summary.errors} with errors`,
  );
  return `${lines.join("\n")}\n`;
}
