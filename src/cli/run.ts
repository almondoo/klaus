import { writeFile } from "node:fs/promises";
import {
  loadFlow,
  ParseError,
  type RunFlowOptions,
  type RunResult,
  runFlows,
} from "../core/index.js";
import { determineExitCode } from "./exit-code.js";
import { formatJson } from "./reporters/json.js";
import { formatJUnit } from "./reporters/junit.js";
import { createTextReporter } from "./reporters/text.js";

/** run コマンドのオプション(commander から渡される値を正規化した形) */
export interface RunCommandOptions {
  env?: string;
  json?: boolean;
  report?: string;
  reportFile: string;
  /** commander の --no-history により、指定が無ければ true(有効)になる */
  history: boolean;
}

/**
 * run コマンド本体。
 * 1. 全ファイルを loadFlow でパース検証(1件でも ParseError なら exit 2、何も実行しない)
 * 2. runFlows で実行(environments/*.yaml の ParseError もここで捕捉し exit 2 に丸める)
 * 3. 出力(text/JSON + 任意で JUnit ファイル)
 * 4. RunResult から exit code を決定して返す
 *
 * ParseError 以外の例外はそのまま呼び出し元へ投げる(呼び出し元で exit 1 に変換する契約)。
 */
export async function runCommand(files: string[], options: RunCommandOptions): Promise<number> {
  // 出力モード決定: --json は TTY でも JSON を強制。それ以外は stdout の TTY 判定に従う
  const useJson = options.json === true || !process.stdout.isTTY;
  const useColor = !useJson && Boolean(process.stdout.isTTY);

  // 1. 実行前パース検証
  const parseErrorMessages: string[] = [];
  for (const filePath of files) {
    try {
      await loadFlow(filePath);
    } catch (error) {
      if (error instanceof ParseError) {
        parseErrorMessages.push(error.message);
      } else {
        throw error;
      }
    }
  }
  if (parseErrorMessages.length > 0) {
    for (const message of parseErrorMessages) {
      process.stderr.write(`klaus: parse error: ${message}\n`);
    }
    return 2;
  }

  // 2. 実行(テキストモードは onStepStart/onStepComplete で逐次出力する)
  const textReporter = useJson ? undefined : createTextReporter(useColor);
  const runOptions: RunFlowOptions = {
    envNameOverride: options.env,
    history: options.history,
    onStepStart: textReporter ? (context) => textReporter.onStepStart(context) : undefined,
    onStepComplete: textReporter ? (context) => textReporter.onStepComplete(context) : undefined,
    // 履歴書き込み失敗などステップの成否に影響しない警告を stderr に出力する
    onWarning: (message) => {
      process.stderr.write(`klaus: warning: ${message}\n`);
    },
  };

  let runResult: RunResult;
  try {
    runResult = await runFlows(files, runOptions);
  } catch (error) {
    // environments/*.yaml のパース・検証失敗など、loadFlow 以外から来る ParseError もここで exit 2 に丸める
    if (error instanceof ParseError) {
      process.stderr.write(`klaus: parse error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  // 3. 出力
  if (useJson) {
    process.stdout.write(`${formatJson(runResult)}\n`);
  } else {
    textReporter?.printSummary(runResult);
  }

  if (options.report === "junit") {
    await writeFile(options.reportFile, formatJUnit(runResult), "utf-8");
  }

  // 4. exit code
  return determineExitCode(runResult);
}
