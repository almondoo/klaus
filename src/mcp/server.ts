/**
 * klaus mcp の SDK への接続部。ツールの登録・入力スキーマ・注釈・結果の直列化・エラーの写し替えだけを担い、
 * ツールの中身は tools.ts にある(ここでは再実装しない)。
 *
 * 標準出力はプロトコルのメッセージ専用。診断はすべて標準エラーに出す。
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createSerialQueue } from "./queue.js";
import { serializeOutcome, type ToolOutcome } from "./result.js";
import { TOOL_DEFINITIONS } from "./tools.js";

export interface KlausMcpServerOptions {
  /** プロジェクトのディレクトリ。フロー・環境・履歴・設定の基準 */
  cwd: string;
  /** true なら、ファイルを書くツール(klaus_promote / klaus_snapshot_accept)を登録しない */
  readOnly: boolean;
  /** サーバー情報に載せるバージョン(klaus --version と同じ値) */
  version: string;
}

/** initialize 時にクライアントへ渡す、エージェント向けの利用案内 */
const INSTRUCTIONS = [
  "klaus runs YAML-defined HTTP request flows with guardrails. Start with klaus_list_flows and klaus_list_environments.",
  "Guards from klaus.config.yaml (guard.allowedHosts) and environment protection ($protected) always apply and cannot be overridden through this server. When a request is refused (errorCode guard.*), tell the user; do not try to work around it.",
  "Output is masked. Prefer klaus_dry_run before klaus_run_flow, and ask the user before accepting snapshot baselines.",
].join(" ");

/** 予期しない例外を、詳細は標準エラーへ、メッセージだけをツールの結果に出す */
function unexpectedFailure(toolName: string, error: unknown): ToolOutcome {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`klaus mcp: unexpected error in ${toolName}: ${detail}\n`);
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: `unexpected error: ${message}` };
}

/** ツールを登録した McpServer を作る(接続はしない) */
export function createKlausMcpServer(options: KlausMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: "klaus", version: options.version },
    { instructions: INSTRUCTIONS },
  );
  // 送信・書き込みを伴うツールは 1 つずつ順に実行する(履歴・スナップショットを並行して書き換えない。
  // 呼び出し順も保たれるので、エージェントから見て結果が決定的になる)
  const serialize = createSerialQueue();

  for (const definition of TOOL_DEFINITIONS) {
    // --read-only では書き込みツールを登録すらしない(tools/list に出ず、呼んでも「不明なツール」になる)
    if (definition.write && options.readOnly) continue;

    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
        annotations: definition.annotations,
      },
      async (args) => {
        const context = {
          cwd: options.cwd,
          readOnly: options.readOnly,
          // initialize で名乗ったクライアント名(履歴の actor.name になる)
          clientName: server.server.getClientVersion()?.name,
        };
        const run = () => definition.handler(args, context);
        let outcome: ToolOutcome;
        try {
          outcome = await (definition.serialize ? serialize(run) : run());
        } catch (error) {
          outcome = unexpectedFailure(definition.name, error);
        }
        const { text, isError } = serializeOutcome(outcome);
        return {
          content: [{ type: "text" as const, text }],
          ...(isError ? { isError: true } : {}),
        };
      },
    );
  }
  return server;
}

/**
 * stdio で MCP サーバーを起動し、接続が閉じる(標準入力の終了、または SIGINT / SIGTERM)まで待つ。
 * 閉じたら resolve する(終了コードの決定とプロセスの終了は呼び出し側)。
 */
export async function runMcpServer(options: KlausMcpServerOptions): Promise<void> {
  const server = createKlausMcpServer(options);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  server.server.onerror = (error) => {
    process.stderr.write(`klaus mcp: ${error.message}\n`);
  };
  const shutdown = () => {
    server.close().catch((error: unknown) => {
      process.stderr.write(
        `klaus mcp: failed to close: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await server.connect(new StdioServerTransport());
    await closed;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
