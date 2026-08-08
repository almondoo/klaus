import type { RunResult } from "../core/index.js";

/**
 * 実行結果(パース検証は既に通過済み)から CLI の exit code を決定する純粋関数。
 * RunResult.status は既に「いずれかの flow が error なら error、
 * そうでなくいずれかが failed なら failed、それ以外は passed」という優先順位で
 * 集約済みなので、ここでは単純にマッピングするだけでよい。
 *
 * - error   -> 3 (接続不能・タイムアウト等の実行時エラー)
 * - failed  -> 4 (アサーション失敗)
 * - passed  -> 0 (全件成功)
 *
 * パースエラー(exit 2)・予期しない例外(exit 1)はこの関数の対象外(呼び出し側で扱う)。
 */
export function determineExitCode(runResult: RunResult): number {
  if (runResult.status === "error") return 3;
  if (runResult.status === "failed") return 4;
  return 0;
}
