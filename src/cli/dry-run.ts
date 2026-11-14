import {
  type DataRow,
  type DryRunResult,
  dryRunLoadedFlows,
  expandSecretVariants,
  type LoadedFlowEntry,
  maskDeep,
  ParseError,
} from "../core/index.js";
import { loadHttpOptions } from "./config.js";
import {
  buildDryRunReport,
  formatDryRunJson,
  formatDryRunText,
  hasDryRunFailure,
} from "./reporters/dry-run.js";
import type { RunCommandOptions } from "./run.js";

/**
 * `klaus run --dry-run` の実行部。runCommand が、フローの読み込み・検証・タグ絞り込みを終えた後に呼ぶ。
 * リクエストは送らず、履歴・カセットにも触れない。展開・安全柵の判定は core の dryRunLoadedFlows が
 * 実行時と同じ経路で行い、ここでは結果のマスクと整形(JSON / text)だけを担う。
 * - 出力モードは run と同じ(useJson は runCommand が決定済み)
 * - exit code は、拒否されるステップ、または実行時にも失敗する展開エラーがあれば 3、なければ 0
 *   (環境ファイルの ParseError は run と同じく 2)
 */
export async function executeDryRun(
  entries: LoadedFlowEntry[],
  dataRows: DataRow[] | undefined,
  options: RunCommandOptions,
  useJson: boolean,
): Promise<number> {
  const collectedSecrets: string[] = [];
  let result: DryRunResult;
  try {
    // klaus.config.yaml の http(http.auth の展開に使う。run と同じ既定値を読む)
    const http = options.http ?? (await loadHttpOptions(process.cwd()));
    result = await dryRunLoadedFlows(entries, {
      http,
      envNameOverride: options.env,
      envFilePath: options.envFile,
      variables: options.var,
      allowProtected: options.allowProtected,
      guard: options.guard,
      dataRows,
      onSecrets: (secrets) => {
        collectedSecrets.push(...secrets);
      },
    });
  } catch (error) {
    // environments/*.yaml のパース・検証失敗は run と同じく exit 2 に丸める
    if (error instanceof ParseError) {
      process.stderr.write(`klaus: parse error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  // 整形より前にオブジェクト木のままマスクする(run の JSON 経路と同じ理由)。
  // 終了コードの判定はマスクの影響を受けないが、マスク前の結果を使う
  const variants = options.mask ? expandSecretVariants(collectedSecrets) : [];
  const masked = variants.length > 0 ? maskDeep(result, variants) : result;

  if (useJson) {
    process.stdout.write(`${formatDryRunJson(buildDryRunReport(masked))}\n`);
  } else {
    process.stdout.write(formatDryRunText(masked));
  }
  return hasDryRunFailure(result) ? 3 : 0;
}
