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
  parseReportFormatList,
  REPORT_FORMATS,
  type ReportFormat,
  type RunFlowOptions,
  type RunResult,
  runLoadedFlows,
  type StepCompleteContext,
  type StepStartContext,
} from "../core/index.js";
import { determineExitCode } from "./exit-code.js";
import { formatJson } from "./reporters/json.js";
import { formatJUnit } from "./reporters/junit.js";
import { formatTap } from "./reporters/tap.js";
import { createTextReporter, resolveUseColor, type TextReporter } from "./reporters/text.js";

/** --report のフォーマットごとの既定ファイル名(--report-file を1回も指定しなかった場合に使う) */
const DEFAULT_REPORT_FILENAMES: Record<ReportFormat, string> = {
  junit: "klaus-report.xml",
  tap: "klaus-report.tap",
};

/** 1 フォーマット分の (フォーマット, 出力先パス) の組 */
interface ReportTarget {
  format: ReportFormat;
  filePath: string;
}

type ResolveReportTargetsResult =
  | { ok: true; targets: ReportTarget[] }
  | { ok: false; message: string };

/**
 * --report / --report-file(klaus.config.yaml の run.report / run.reportFile 適用後の値)から、
 * 実際に書き出す (フォーマット, 出力パス) の組を解決する。
 * - --report 未指定なら何も書き出さない(targets: [])。--report-file の値は無視する
 *   (従来どおり: レポート形式を指定しない限り --report-file は使われない)。
 * - --report のフォーマット一覧(カンマ区切り)のいずれかが不明なら ok: false。
 * - --report のフォーマット一覧に重複があれば ok: false(例: `--report junit,junit` は同じ既定パスへの
 *   二重書き込みになり、一方が黙って失われるか、`--report-file` を2回とも同じパスに指定した場合は
 *   同一パスへの writeFile が並行で競合するため、実行前に拒否する)。
 * - --report-file は文字列(単一値。klaus.config.yaml の run.reportFile 由来、または commander の
 *   デフォルト値の名残)か配列(commander の --report-file 複数回指定)のいずれかで渡ってくる。
 *   0個(配列なら空配列)= 各フォーマットの既定ファイル名(DEFAULT_REPORT_FILENAMES)を使う。
 *   フォーマット数と同数 = --report のフォーマット順とペアにする。
 *   それ以外の個数は ok: false にする(指定漏れ・過不足に気付かず一部のレポートが意図せず
 *   既定ファイル名で上書きされる事故を避けるため)。
 * - 解決後の (フォーマット, 出力パス) の組で、出力パスが重複していれば ok: false
 *   (フォーマットが異なっていても同一パスへの writeFile は一方が他方を上書きする事故になるため)。
 */
function resolveReportTargets(
  report: string | undefined,
  reportFile: string | string[],
): ResolveReportTargetsResult {
  if (report === undefined) {
    return { ok: true, targets: [] };
  }

  const formats = parseReportFormatList(report);
  if (formats === undefined) {
    return {
      ok: false,
      message: `klaus: unknown report type in "${report}" (supported: ${REPORT_FORMATS.join(", ")})`,
    };
  }

  const duplicateFormat = formats.find((format, index) => formats.indexOf(format) !== index);
  if (duplicateFormat !== undefined) {
    return {
      ok: false,
      message: `klaus: --report "${report}" contains duplicate format "${duplicateFormat}"`,
    };
  }

  const files = Array.isArray(reportFile) ? reportFile : [reportFile];
  if (files.length !== 0 && files.length !== formats.length) {
    return {
      ok: false,
      message:
        `klaus: --report-file must be given exactly ${formats.length} time(s) to match --report "${report}" ` +
        `(got ${files.length}); omit --report-file entirely to use the default filenames`,
    };
  }

  // files.length === 0 の場合は常に既定ファイル名(files[index] は undefined)、
  // files.length === formats.length の場合は常に files[index] が定義される(上のチェックで保証済み)
  const targets = formats.map((format, index) => ({
    format,
    filePath: files[index] ?? DEFAULT_REPORT_FILENAMES[format],
  }));

  const filePaths = targets.map((target) => target.filePath);
  const duplicatePath = filePaths.find((filePath, index) => filePaths.indexOf(filePath) !== index);
  if (duplicatePath !== undefined) {
    return {
      ok: false,
      message: `klaus: multiple --report formats resolve to the same output path "${duplicatePath}"`,
    };
  }

  return { ok: true, targets };
}

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
  /** カンマ区切りのレポート形式リスト(例: "junit" または "junit,tap")。有効な値は core の REPORT_FORMATS を参照 */
  report?: string;
  /**
   * --report-file の値。単一値(klaus.config.yaml の run.reportFile、または呼び出し側が直接
   * runCommand を呼ぶ場合)は string、commander の --report-file 複数回指定は string[] で渡ってくる。
   * 実際の (フォーマット, パス) への解決は resolveReportTargets が行う。
   */
  reportFile: string | string[];
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
  /**
   * --jobs <n> 指定時、実行ユニット(行 × フローの組。--data 未指定時は行がフロー数に一致)を並列実行する
   * ワーカー数(1-32、index.ts の InvalidArgumentError 検証済み)。未指定時は 1(既定の逐次実行、
   * 出力・履歴とも従来どおりバイト単位で変わらない)。1ユニット = 1回の executeFlow 呼び出しであり、
   * フロー内のステップは --jobs の値に関わらず常に逐次実行のまま変わらない。RunResult.flows の順序は
   * 常に入力順(runLoadedFlows の jobs>1 分岐が保証)。--record と同時指定はできない
   * (下記 runCommand の 0. 検査を参照)
   */
  jobs?: number;
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
 * --jobs 2 以上の並列実行時、runLoadedFlows が展開する実行ユニット(行 × フローの組)ごとの
 * ステップ数を、buildRunUnits(runner.ts)と同じ入力順(行(外側) × フロー(内側))で並べた配列を返す。
 * createOrderedTextFlusher が「そのユニットの全ステップの onStepComplete が揃ったか」を判定するために使う
 * (フロー内の全ステップは skipped であっても必ず onStepStart/onStepComplete が1回ずつ呼ばれるため、
 * flow.steps.length がそのユニットで期待される onStepComplete 回数と一致する。runner.ts 側の実装参照)。
 */
function buildUnitStepCounts(
  entries: LoadedFlowEntry[],
  dataRows: DataRow[] | undefined,
): number[] {
  const iterations = dataRows && dataRows.length > 0 ? dataRows.length : 1;
  const counts: number[] = [];
  for (let i = 0; i < iterations; i++) {
    for (const entry of entries) {
      counts.push(entry.flow.steps.length);
    }
  }
  return counts;
}

/** createOrderedTextFlusher が1ユニット分バッファする onStepStart/onStepComplete イベント */
type OrderedTextEvent =
  | { kind: "start"; context: StepStartContext }
  | { kind: "complete"; context: StepCompleteContext };

/**
 * --jobs 2 以上の並列実行時、text レポーターへの出力を「完了順」ではなく「入力順(行(外側) × フロー(内側)の
 * イテレーション優先順、runLoadedFlows と同じ)」に並び替えて渡すラッパー。
 *
 * 採用した方式(設計ドキュメント記載の2案のうち、簡易な方): 各ユニットの onStepStart/onStepComplete を
 * そのユニットの全ステップが完了する(onStepComplete が unitStepCounts[unitIndex] 回揃う)までまるごと
 * バッファし、入力順で次に flush 可能になったユニットから順に、そのユニットの全イベントをまとめて
 * reporter へ流す。現在実行中の最先頭ユニットをライブストリーミングする変形は採用していない
 * (実装・検証の複雑さに対して、jobs>1 時の体感速度向上効果が小さいと判断したため)。
 *
 * unitIndex は StepStartContext/StepCompleteContext.unitIndex を使う(--jobs 2 以上の実行でのみ
 * runner.ts が設定する。未設定の場合は 0 として扱うが、jobs>1 時は runLoadedFlows が必ず設定するため
 * 実際には発生しない)。
 */
function createOrderedTextFlusher(
  reporter: TextReporter,
  unitStepCounts: number[],
): Pick<TextReporter, "onStepStart" | "onStepComplete"> {
  const buffers = new Map<number, OrderedTextEvent[]>();
  const completedCounts = new Map<number, number>();
  let nextToFlush = 0;

  function isReady(index: number): boolean {
    const expected = unitStepCounts[index] ?? 0;
    const completed = completedCounts.get(index) ?? 0;
    return completed >= expected;
  }

  function flushReady(): void {
    while (nextToFlush < unitStepCounts.length && isReady(nextToFlush)) {
      const events = buffers.get(nextToFlush) ?? [];
      for (const event of events) {
        if (event.kind === "start") {
          reporter.onStepStart(event.context);
        } else {
          reporter.onStepComplete(event.context);
        }
      }
      buffers.delete(nextToFlush);
      completedCounts.delete(nextToFlush);
      nextToFlush++;
    }
  }

  return {
    onStepStart(context: StepStartContext): void {
      const index = context.unitIndex ?? 0;
      const events = buffers.get(index) ?? [];
      events.push({ kind: "start", context });
      buffers.set(index, events);
    },
    onStepComplete(context: StepCompleteContext): void {
      const index = context.unitIndex ?? 0;
      const events = buffers.get(index) ?? [];
      events.push({ kind: "complete", context });
      buffers.set(index, events);
      completedCounts.set(index, (completedCounts.get(index) ?? 0) + 1);
      flushReady();
    },
  };
}

/**
 * run コマンド本体。
 * 0. --record と --replay、--record と --jobs>1、--json と --text、--report/--report-file の組み合わせを検査
 *    (いずれも stderr + exit 1、何も実行しない)
 * 1. 全ファイルを loadFlow でパース検証(--data 指定時は loadDataFile も並行して読み込む。
 *    いずれか1件でも ParseError なら exit 2、何も実行しない)
 * 2. --tags / --exclude-tags でフローを絞り込む(filterFlowsByTags。--data によるイテレーション展開より前、
 *    runLoadedFlows に渡す前に行う。絞り込んだ結果が0件なら stderr + exit 1、何も実行しない)
 * 3. runLoadedFlows で実行(1.で読み込み・2.で絞り込み済みの Flow・データ行をそのまま渡し、二重パースを避ける。
 *    environments/*.yaml の ParseError もここで捕捉し exit 2 に丸める。--jobs 2 以上の場合は実行ユニット
 *    (行 × フローの組)を並列実行するが、RunResult.flows の順序・text 出力の順序はいずれも入力順を保つ
 *    (後者は createOrderedTextFlusher が担う。jobs=1 では従来どおり textReporter を直結し逐次出力する))
 * 4. 出力(text/JSON + 任意で 0.で解決したレポートファイル1つ以上)
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

  // --record + --jobs>1 は禁止する。カセット追記自体は appendFile(O_APPEND)の単一 write なので
  // 1行単位の破損は起きないが(history.ts の appendHistory と同じ理由)、同一 method+URL への
  // リクエストが複数ユニットから並行して発生する場合、カセットに書き込まれる行の順序が
  // 実行のたびに変わり得る。replay 側は「同一キーの最初の行を採用する」非消費型の索引(loadCassetteIndex)
  // のため、どのレスポンスが再生されるかが記録のたびに変わる非決定的なカセットになってしまう。
  // --replay は実行前に一度だけ読み込んだ索引を並行実行中は読み取るだけ(書き込みが無い)のため対象外。
  if (options.record !== undefined && options.jobs !== undefined && options.jobs > 1) {
    process.stderr.write("klaus: --record and --jobs > 1 cannot be used together\n");
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

  // --report/--report-file の整合性検査(フォーマット不明・個数不一致)。
  // フロー読み込み・実行より前に検査することで、無駄な読み込み・実行を避ける。
  const reportResolution = resolveReportTargets(options.report, options.reportFile);
  if (!reportResolution.ok) {
    process.stderr.write(`${reportResolution.message}\n`);
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
  // stdout(text/JSON いずれも)とレポートファイル出力(JUnit/TAP)の両方で使う secrets({{env.X}} 等で解決した値)。
  // --no-mask 指定時は options.mask が false になり、stdout 側のマスキングのみ無効化する(レポートファイルは従来どおり)。
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
  const jobs = options.jobs ?? 1;
  // --jobs 2 以上のときだけ順序制御ラッパーを介す(jobs=1 の既定経路は従来どおり textReporter を直結し、
  // バッファ層を一切挟まない)。textReporter 自体は useJson の場合 undefined のままなので、
  // JSON 出力時はここでも stepHandler は undefined になる。
  const stepHandler: Pick<TextReporter, "onStepStart" | "onStepComplete"> | undefined =
    textReporter && jobs > 1
      ? createOrderedTextFlusher(textReporter, buildUnitStepCounts(filteredFlows, dataRows))
      : textReporter;
  const runOptions: RunFlowOptions = {
    envNameOverride: options.env,
    envFilePath: options.envFile,
    variables: options.var,
    allowProtected: options.allowProtected,
    history: options.history,
    dataRows,
    jobs,
    onStepStart: stepHandler ? (context) => stepHandler.onStepStart(context) : undefined,
    onStepComplete: stepHandler ? (context) => stepHandler.onStepComplete(context) : undefined,
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

  // stdout(text/JSON)とは別経路で、レポートファイルにのみ secrets をマスクする。
  // 複数フォーマット指定時は独立した書き込みのため並行して書き出す。
  await Promise.all(
    reportResolution.targets.map((target) => {
      const formatted =
        target.format === "junit"
          ? formatJUnit(runResult, { secrets: collectedSecrets })
          : formatTap(runResult, { secrets: collectedSecrets });
      return writeFile(target.filePath, formatted, "utf-8");
    }),
  );

  // 5. exit code
  return determineExitCode(runResult);
}
