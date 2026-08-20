import { writeFile } from "node:fs/promises";
import {
  type DataRow,
  expandSecretVariants,
  type Flow,
  type LoadedFlowEntry,
  loadDataFile,
  loadFlow,
  maskDeep,
  maskString,
  ParseError,
  type RunFlowOptions,
  type RunResult,
  runLoadedFlows,
} from "../core/index.js";
import { determineExitCode } from "./exit-code.js";
import { formatJson } from "./reporters/json.js";
import { formatJUnit } from "./reporters/junit.js";
import { createTextReporter, resolveUseColor } from "./reporters/text.js";

/** run コマンドのオプション(commander から渡される値を正規化した形) */
export interface RunCommandOptions {
  env?: string;
  /** --env-file <path> 指定時の任意パスの環境ファイル。-e/--env と同時指定はできない */
  envFile?: string;
  /**
   * --var <key=value> の累積結果(commander 側で index.ts の collect コールバックが
   * Record<string,string> に集約済み)。テンプレートの env 名前空間へ、環境ファイルの値を
   * 上書きする形でマージする。秘密情報としては扱わず、マスク対象にもしない(利用者の明示的な選択)
   */
  var?: Record<string, string>;
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
  /**
   * --data <path> 指定時、データ駆動実行(Newman 方式)に使うデータファイル(JSON/YAML)のパス。
   * 各行につき files 全体を1回ずつ実行する(行(外側) × フロー(内側)のイテレーション優先順)。
   * loadDataFile の検証・エラー整形をそのまま再利用する(files の loadFlow と同じ、
   * 実行前の並列読み込み → ParseError なら exit 2 という契約)
   */
  data?: string;
  /**
   * --tags <list> 指定時、フローが持つ tags のうち1つでも一致すれば実行対象に含める(OR 条件)。
   * index.ts のカンマ区切りパースで正規化済み(各要素は trim 済みで空要素は含まれない)。
   * 未指定の場合は絞り込みを行わない(全フローが選抜段階を通過する)。
   */
  tags?: string[];
  /**
   * --exclude-tags <list> 指定時、フローが持つ tags のいずれか1つでも一致すれば実行対象から除外する。
   * --tags による選抜より後に適用され、除外が優先される(両方に一致するフローは除外される)。
   * 未指定の場合は除外を行わない。
   */
  excludeTags?: string[];
}

/**
 * --tags / --exclude-tags による絞り込みをフロー単位で行う純関数。
 * 適用順序: 1. --tags 指定時、tags のいずれとも一致しないフローを除外(OR 条件。未指定なら全通過)
 *           2. --exclude-tags 指定時、tags のいずれかに一致するフローを除外(除外が選抜より優先)
 * タグ無しフローは --tags のどれとも一致しないため 1. で落ち、--exclude-tags のどれとも一致しないため
 * 2. では常に残る(--exclude-tags のみ指定時は保持される)。
 */
function filterFlowsByTags(
  entries: LoadedFlowEntry[],
  options: Pick<RunCommandOptions, "tags" | "excludeTags">,
): LoadedFlowEntry[] {
  let filtered = entries;

  if (options.tags && options.tags.length > 0) {
    const includeTags = new Set(options.tags);
    filtered = filtered.filter((entry) =>
      (entry.flow.tags ?? []).some((tag) => includeTags.has(tag)),
    );
  }

  if (options.excludeTags && options.excludeTags.length > 0) {
    const excludeTags = new Set(options.excludeTags);
    filtered = filtered.filter(
      (entry) => !(entry.flow.tags ?? []).some((tag) => excludeTags.has(tag)),
    );
  }

  return filtered;
}

/**
 * run コマンド本体。
 * 0. --record と --replay、--json と --text の同時指定を検査(いずれも stderr + exit 1、何も実行しない)
 * 1. 全ファイルを loadFlow でパース検証(--data 指定時は loadDataFile も並行して読み込む。
 *    いずれか1件でも ParseError なら exit 2、何も実行しない)
 * 2. --tags / --exclude-tags でフローを絞り込む(filterFlowsByTags。--data によるイテレーション展開より前、
 *    runLoadedFlows に渡す前に行う。絞り込んだ結果が0件なら stderr + exit 1、何も実行しない)
 * 3. runLoadedFlows で実行(1.で読み込み・2.で絞り込み済みの Flow・データ行をそのまま渡し、二重パースを避ける。
 *    environments/*.yaml の ParseError もここで捕捉し exit 2 に丸める)
 * 4. 出力(text/JSON + 任意で JUnit ファイル)
 * 5. RunResult から exit code を決定して返す
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

  // -e/--env と --env-file も同時指定不可(--record/--replay と同じ流儀で片方のみ有効にする契約)
  if (options.env !== undefined && options.envFile !== undefined) {
    process.stderr.write("klaus: --env and --env-file cannot be used together\n");
    return 1;
  }

  // 出力モード決定: --json は非 TTY でも JSON を強制、--text は TTY でなくても text を強制する。
  // FORCE_COLOR=1 のような非 TTY 環境で色付き text を得る唯一の経路が --text になる
  // (元々は !process.stdout.isTTY のみで判定していたため、非 TTY では常に JSON になり到達不能だった)。
  const useJson =
    options.json === true ? true : options.text === true ? false : !process.stdout.isTTY;
  const useColor = !useJson && resolveUseColor(Boolean(process.stdout.isTTY));

  // 1. 実行前パース検証。loadFlow は読み込み専用のため各ファイルを並列に検証してよく、
  // Promise.all は入力順を保つため ParseError の報告順は元のシーケンシャル実行と変わらない
  // (validate.ts の並列検証と同じ方針)。ここで読み込んだ Flow はそのまま実行(2.)にも渡し、
  // runFlows 経由での再読み込み(二重パース)を避ける。--data 指定時は loadDataFile も同じ
  // Promise.all に加えて並行読み込みする(files のパース検証と独立しているため)。
  type LoadOutcome = { filePath: string; flow: Flow } | { filePath: string; error: ParseError };
  type DataLoadOutcome = { rows: DataRow[] } | { error: ParseError };
  const [loadResults, dataLoadOutcome] = await Promise.all([
    Promise.all(
      files.map(async (filePath): Promise<LoadOutcome> => {
        try {
          const flow = await loadFlow(filePath);
          return { filePath, flow };
        } catch (error) {
          if (error instanceof ParseError) {
            return { filePath, error };
          }
          throw error;
        }
      }),
    ),
    (async (): Promise<DataLoadOutcome | undefined> => {
      if (options.data === undefined) return undefined;
      try {
        const rows = await loadDataFile(options.data);
        return { rows };
      } catch (error) {
        if (error instanceof ParseError) {
          return { error };
        }
        throw error;
      }
    })(),
  ]);

  const parseErrorMessages = loadResults.flatMap((r) => ("error" in r ? [r.error.message] : []));
  if (dataLoadOutcome && "error" in dataLoadOutcome) {
    parseErrorMessages.push(dataLoadOutcome.error.message);
  }
  if (parseErrorMessages.length > 0) {
    for (const message of parseErrorMessages) {
      process.stderr.write(`klaus: parse error: ${message}\n`);
    }
    return 2;
  }
  const loadedFlows: LoadedFlowEntry[] = loadResults.flatMap((r) =>
    "flow" in r ? [{ filePath: r.filePath, flow: r.flow }] : [],
  );
  const dataRows: DataRow[] | undefined =
    dataLoadOutcome && "rows" in dataLoadOutcome ? dataLoadOutcome.rows : undefined;

  // 2. --tags / --exclude-tags による絞り込み。--data のイテレーション展開(行 × フロー)より前に行うため、
  // ここで落ちたフローは FlowResult・履歴・出力のいずれにも一切現れない(「skipped」とは異なる:
  // skipped はステップ単位でランナーに到達した上で記録される結果だが、絞り込みで落ちたフローはランナーへ
  // 到達すらしない)。絞り込んだ結果が0件になった場合、CI で意図せず全緑の空実行になりタグの typo を
  // 見逃す事故を避けるため、既存の設定エラー(0.)と同じ流儀で stderr + exit 1 とする。
  const filteredFlows = filterFlowsByTags(loadedFlows, options);
  if (filteredFlows.length === 0) {
    process.stderr.write("klaus: no flows match the specified tags\n");
    return 1;
  }

  // 3. 実行(テキストモードは onStepStart/onStepComplete で逐次出力する)
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
    envFilePath: options.envFile,
    variables: options.var,
    allowProtected: options.allowProtected,
    history: options.history,
    dataRows,
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
    runResult = await runLoadedFlows(filteredFlows, runOptions);
  } catch (error) {
    // environments/*.yaml のパース・検証失敗など、loadFlow 以外から来る ParseError もここで exit 2 に丸める
    if (error instanceof ParseError) {
      process.stderr.write(`klaus: parse error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }

  // 4. 出力
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

  // 5. exit code
  return determineExitCode(runResult);
}
