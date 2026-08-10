import { writeFile } from "node:fs/promises";
import {
  expandSecretVariants,
  loadFlow,
  maskDeep,
  maskString,
  ParseError,
  type RunFlowOptions,
  type RunResult,
  runFlows,
} from "../core/index.js";
import { determineExitCode } from "./exit-code.js";
import { formatJson } from "./reporters/json.js";
import { formatJUnit } from "./reporters/junit.js";
import { createTextReporter, resolveUseColor } from "./reporters/text.js";

/** run コマンドのオプション(commander から渡される値を正規化した形) */
export interface RunCommandOptions {
  env?: string;
  json?: boolean;
  /** commander の --text。--json と同時指定はできない(非 TTY でも text 出力を強制する) */
  text?: boolean;
  report?: string;
  reportFile: string;
  /** commander の --no-history により、指定が無ければ true(有効)になる */
  history: boolean;
  /**
   * commander の --no-mask により、指定が無ければ true(有効)になる。
   * true の場合、stdout(JSON/text いずれの出力形式でも)に既定でシークレットマスキングを適用する。
   */
  mask: boolean;
  /** --record <dir> 指定時のカセット出力先ディレクトリ。--replay と同時指定はできない */
  record?: string;
  /** --replay <dir> 指定時のカセット読み込み元ディレクトリ。--record と同時指定はできない */
  replay?: string;
  /** --allow-protected 指定時、$protected: true の環境ファイルへの実行を許可する */
  allowProtected?: boolean;
}

/**
 * run コマンド本体。
 * 0. --record と --replay、--json と --text の同時指定を検査(いずれも stderr + exit 1、何も実行しない)
 * 1. 全ファイルを loadFlow でパース検証(1件でも ParseError なら exit 2、何も実行しない)
 * 2. runFlows で実行(environments/*.yaml の ParseError もここで捕捉し exit 2 に丸める)
 * 3. 出力(text/JSON + 任意で JUnit ファイル)
 * 4. RunResult から exit code を決定して返す
 *
 * ParseError 以外の例外はそのまま呼び出し元へ投げる(呼び出し元で exit 1 に変換する契約)。
 */
export async function runCommand(files: string[], options: RunCommandOptions): Promise<number> {
  // --record と --replay は同時指定不可(record-replay モードは片方のみ有効にする契約)
  if (options.record !== undefined && options.replay !== undefined) {
    process.stderr.write("klaus: --record and --replay cannot be used together\n");
    return 1;
  }

  // --json と --text も同時指定不可(--record/--replay と同じ流儀で片方のみ有効にする契約)
  if (options.json === true && options.text === true) {
    process.stderr.write("klaus: --json and --text cannot be used together\n");
    return 1;
  }

  // 出力モード決定: --json は非 TTY でも JSON を強制、--text は TTY でなくても text を強制する。
  // FORCE_COLOR=1 のような非 TTY 環境で色付き text を得る唯一の経路が --text になる
  // (元々は !process.stdout.isTTY のみで判定していたため、非 TTY では常に JSON になり到達不能だった)。
  const useJson =
    options.json === true ? true : options.text === true ? false : !process.stdout.isTTY;
  const useColor = !useJson && resolveUseColor(Boolean(process.stdout.isTTY));

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
  // stdout(text/JSON いずれも)と JUnit ファイル出力の両方で使う secrets({{env.X}} 等で解決した値)。
  // --no-mask 指定時は options.mask が false になり、stdout 側のマスキングのみ無効化する(JUnit は従来どおり)。
  const collectedSecrets: string[] = [];
  /**
   * runner の onSecrets はステップ単位(そのステップの onStepComplete より前)で発火するため、
   * あるステップ自身が初めて解決したシークレットも、そのステップの onStepComplete 時点では
   * 既に collectedSecrets に含まれている。そのため text 出力はバッファせず、write のたびに
   * その時点の collectedSecrets でマスクして即時 stdout へ書き出す(ステップ行が逐次表示される)。
   * 既知の制限: 変形したシークレットは、変形後の文字列が expandSecretVariants の展開範囲
   * (生値・encodeURIComponent 形・form-urlencoded 形・encodeURI 形・JSON エスケープ形)に含まれない限り
   * マスクできない(JUnit 出力の escapeXmlText と同様の制限)。encodeURI 形も URL コンポーネントごとの
   * エンコード集合の違い(例: パス中の `?` `#` の扱い)を完全には覆わないため、undici の URL 正規化が
   * 上記いずれとも異なる形を生成するケースは既知の限界として残る。
   */
  const write = options.mask
    ? (text: string) => {
        const variants = expandSecretVariants(collectedSecrets);
        process.stdout.write(variants.length > 0 ? maskString(text, variants) : text);
      }
    : (text: string) => {
        process.stdout.write(text);
      };
  const textReporter = useJson ? undefined : createTextReporter(useColor, write);
  const runOptions: RunFlowOptions = {
    envNameOverride: options.env,
    allowProtected: options.allowProtected,
    history: options.history,
    onStepStart: textReporter ? (context) => textReporter.onStepStart(context) : undefined,
    onStepComplete: textReporter ? (context) => textReporter.onStepComplete(context) : undefined,
    // 履歴書き込み失敗などステップの成否に影響しない警告を stderr に出力する
    onWarning: (message) => {
      process.stderr.write(`klaus: warning: ${message}\n`);
    },
    // ステップ単位・フロー単位を問わず随時呼ばれるため、都度累積するだけでよい
    // (write 側は呼ばれるたびにその時点の collectedSecrets を展開してマスクする)
    onSecrets: (secrets) => {
      collectedSecrets.push(...secrets);
    },
    // --record/--replay のいずれも指定が無ければ undefined(通常どおり実ネットワークへ送信する)
    recording:
      options.record !== undefined
        ? { mode: "record", dir: options.record }
        : options.replay !== undefined
          ? { mode: "replay", dir: options.replay }
          : undefined,
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
    // JSON.stringify 後の文字列置換だと、`"` やバックスラッシュ・制御文字を含むシークレットは
    // JSON エスケープで生の値と一致しなくなり、平文のまま漏れてしまう。
    // そのため formatJson(JSON.stringify)に渡す前に runResult をオブジェクト木のままマスクする
    // (maskDeep は新しいオブジェクトを返すため、元の runResult は変異しない。
    // 直後の determineExitCode はマスク前の runResult を使う)。
    const variants = options.mask ? expandSecretVariants(collectedSecrets) : [];
    const maskedResult = variants.length > 0 ? maskDeep(runResult, variants) : runResult;
    const json = formatJson(maskedResult, { historyEnabled: options.history });
    process.stdout.write(`${json}\n`);
  } else {
    // サマリー行も write 経由で書き出すため、この時点までに判明した collectedSecrets でマスクされる
    textReporter?.printSummary(runResult);
  }

  if (options.report === "junit") {
    // stdout(text/JSON)とは別経路で、JUnit ファイルにのみ secrets をマスクする
    await writeFile(
      options.reportFile,
      formatJUnit(runResult, { secrets: collectedSecrets }),
      "utf-8",
    );
  }

  // 4. exit code
  return determineExitCode(runResult);
}
