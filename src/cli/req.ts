import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  executeSingleRequest,
  expandSecretVariants,
  formatZodError,
  type GuardOptions,
  type HttpConfig,
  isPathWithinDir,
  isRealPathWithinDir,
  maskDeep,
  ParseError,
  requestSchema,
  type StepResult,
} from "../core/index.js";
import { detectActor, resolveGitState } from "./audit.js";
import { loadHttpOptions } from "./config.js";
import { buildReqReport, formatReqJson, formatReqText } from "./reporters/req.js";

/** req コマンドのオプション(commander から渡される値を正規化した形) */
export interface ReqCommandOptions {
  /** -H, --header の累積結果(index.ts の collectHeaderOption が Record に集約済み) */
  header?: Record<string, string>;
  /** --query の累積結果(index.ts の collectQueryOption が Record に集約済み) */
  query?: Record<string, string>;
  /** --body <json> または --body @<file>。解釈は resolveBody を参照 */
  body?: string;
  env?: string;
  /** --env-file <path>。-e/--env と同時指定はできない */
  envFile?: string;
  /** --var の累積結果。環境ファイルの値を上書きする。マスク対象にはしない(run と同じ) */
  var?: Record<string, string>;
  /** --timeout <ms>。省略時は requestSchema の既定(30000ms) */
  timeout?: number;
  json?: boolean;
  /** --json と同時指定はできない(非 TTY でも text 出力を強制する) */
  text?: boolean;
  /** commander の --no-history により、指定が無ければ true(有効)になる */
  history: boolean;
  /** commander の --no-mask により、指定が無ければ true(有効)になる */
  mask: boolean;
  actor?: string;
  /**
   * klaus.config.yaml の `guard`(送信先ホストの許可リスト)。CLI フラグは設けない
   * (エージェントが引数で安全柵を外せないようにするため)。index.ts が config から設定して渡す
   */
  guard?: GuardOptions;
  /** klaus.config.yaml の `http`。未指定なら reqCommand が設定ファイルから読む(run と同じ既定値) */
  http?: HttpConfig;
}

type ResolveBodyResult = { ok: true; body: unknown } | { ok: false; message: string };

/**
 * --body の値をリクエストボディに解決する。
 * - `@<path>` は cwd からの相対(または絶対)パスのファイルを読む。step.use と同じ境界規則で、
 *   cwd 配下(シンボリックリンク解決後も)に限る(エージェントが任意のファイルを送信先へ流せないようにするため)。
 * - 内容が JSON としてパースできればその値(オブジェクト・配列・数値など)、できなければ生の文字列を使う。
 *   フロー定義の body と同じ扱いで、オブジェクトは JSON として送られ Content-Type: application/json が補われ、
 *   文字列はそのまま送られる(この場合 Content-Type は -H で指定する)。
 */
async function resolveBody(value: string, cwd: string): Promise<ResolveBodyResult> {
  let text = value;
  if (value.startsWith("@")) {
    const target = value.slice(1);
    if (target === "") {
      return { ok: false, message: "--body @<file> requires a file path" };
    }
    const resolvedPath = resolve(cwd, target);
    const resolvedCwd = resolve(cwd);
    if (
      !isPathWithinDir(resolvedCwd, resolvedPath) ||
      !isRealPathWithinDir(resolvedCwd, resolvedPath)
    ) {
      return {
        ok: false,
        message: `--body file resolves outside the current directory: "${target}"`,
      };
    }
    try {
      text = await readFile(resolvedPath, "utf-8");
    } catch (error) {
      return {
        ok: false,
        message: `failed to read --body file "${target}": ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: true, body: text };
  }
}

/**
 * req コマンド本体。コアの executeSingleRequest(UI の POST /api/request と同じ経路)を呼ぶ。
 * 0. --json と --text、-e/--env と --env-file の同時指定(引数の組み合わせエラー)は run と同じ
 *    stderr + exit 1(何も送信しない)。--body の解決失敗、リクエスト定義の検証失敗は stderr + exit 2(何も送信しない)
 * 1. executeSingleRequest で送信(安全柵の判定・履歴書き込み・テンプレート展開はコア側で run と共通)。
 *    環境ファイルの ParseError も exit 2 に丸める
 * 2. シークレットをマスクして出力(JSON / text)
 * 3. exit code: 応答を受信できたら 0(HTTP ステータスは問わない。アサーションが無いため)、
 *    送信エラー・安全柵による拒否は 3
 *
 * ParseError 以外の例外はそのまま呼び出し元へ投げる(呼び出し元で exit 1 に変換する契約)。
 */
export async function reqCommand(
  method: string,
  url: string,
  options: ReqCommandOptions,
  cwd: string = process.cwd(),
): Promise<number> {
  if (options.json === true && options.text === true) {
    process.stderr.write("klaus: --json and --text cannot be used together\n");
    return 1;
  }
  if (options.env !== undefined && options.envFile !== undefined) {
    process.stderr.write("klaus: --env and --env-file cannot be used together\n");
    return 1;
  }

  // 出力モード決定は run と同じ(--json は非 TTY でも JSON、--text は TTY でなくても text、既定は TTY 判定)
  const useJson =
    options.json === true ? true : options.text === true ? false : !process.stdout.isTTY;

  let body: unknown;
  if (options.body !== undefined) {
    const resolved = await resolveBody(options.body, cwd);
    if (!resolved.ok) {
      process.stderr.write(`klaus: ${resolved.message}\n`);
      return 2;
    }
    body = resolved.body;
  }

  const request = {
    method,
    url,
    ...(options.header !== undefined && Object.keys(options.header).length > 0
      ? { headers: options.header }
      : {}),
    ...(options.query !== undefined && Object.keys(options.query).length > 0
      ? { query: options.query }
      : {}),
    ...(body !== undefined ? { body } : {}),
    ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
  };
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) {
    process.stderr.write(`klaus: invalid request: ${formatZodError(parsed.error)}\n`);
    return 2;
  }

  // 履歴の監査項目。git は履歴を書く場合のみ取得する(--no-history 時に git を起動しない)
  const git = options.history ? await resolveGitState(cwd) : undefined;
  const collectedSecrets: string[] = [];

  let outcome: { result: StepResult; runId: string; historyRecorded: boolean };
  try {
    const http = options.http ?? (await loadHttpOptions(cwd));
    outcome = await executeSingleRequest({
      http,
      // tls.insecure などの警告は stdout の JSON / text を汚さないよう stderr に出す
      onWarning: (message) => {
        process.stderr.write(`klaus: warning: ${message}\n`);
      },
      request,
      cwd,
      envName: options.env,
      envFilePath: options.envFile,
      variables: options.var,
      history: options.history,
      guard: options.guard,
      actor: detectActor(process.env, options.actor),
      git,
      onSecrets: (secrets) => {
        collectedSecrets.push(...secrets);
      },
    });
  } catch (error) {
    // 環境ファイルの読み込み・検証失敗は run と同じく exit 2 に丸める
    if (error instanceof ParseError) {
      process.stderr.write(`klaus: parse error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  // 切り詰め・文字列化より前にオブジェクト木のままマスクする(run の JSON 経路と同じ理由:
  // JSON 文字列化後の置換では、エスケープされるシークレットが平文のまま漏れるため)
  const variants = options.mask ? expandSecretVariants(collectedSecrets) : [];
  // 登録済みシークレットが無くても Cookie ヘッダーの構造的マスクは常に掛ける(--no-mask のときだけ生のまま)
  const result = options.mask ? maskDeep(outcome.result, variants) : outcome.result;
  const historyLink = outcome.historyRecorded ? { runId: outcome.runId } : undefined;

  if (useJson) {
    process.stdout.write(`${formatReqJson(buildReqReport(result, historyLink))}\n`);
  } else {
    process.stdout.write(formatReqText(result, historyLink));
  }

  return result.status === "error" ? 3 : 0;
}
