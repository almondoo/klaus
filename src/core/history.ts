import { join } from "node:path";
import { mapDeepStrings } from "./deep-map.js";
import { appendPrivateLine } from "./private-file.js";
import type { AssertionResult, RequestSnapshot, ResponseSnapshot, SseEvent } from "./types.js";

/**
 * 実行履歴 1 行分のスキーマ。versioned にしてあるので、
 * 将来フィールドを変える場合は v を上げて後方互換を判断できるようにする。
 * v は 1 のまま(追加のみの後方互換な変更): status を新設し、
 * request/response は skipped ステップのため省略可能にし、SSE イベントを events に追加し、
 * さらにフロー実行を介さない単発実行(POST /api/request)を示す source と、--data 実行時の
 * iteration を追加した。
 */
export interface HistoryEntry {
  v: 1;
  runId: string;
  flow: string;
  step: string;
  startedAt: string;
  durationMs: number;
  /** --data 実行時のみ設定される 1 始まりのイテレーション番号。--data 未指定の通常実行では省略する */
  iteration?: number;
  /**
   * 新規に書き込むエントリでは常に設定する。
   * 既存の(このフィールド追加前に書かれた)行には無いため、読み出し側は
   * 省略時に assertions から従来通り導出するフォールバックを持つこと。
   */
  status?: "passed" | "failed" | "skipped";
  /** skipped ステップでは省略する */
  request?: RequestSnapshot;
  /** skipped ステップでは省略する */
  response?: ResponseSnapshot;
  /** SSE ステップで受信したイベント一覧(SSE ステップ以外では省略) */
  events?: SseEvent[];
  assertions: AssertionResult[];
  /** executeSingleRequest(フローを介さない単発実行)経由で書き込まれた場合 "single"。通常のフロー実行では省略する */
  source?: "single";
  /** step.retry を設定した場合のみ設定。実際に実行された試行回数(1 以上) */
  attempts?: number;
}

/**
 * マスク対象とみなす秘密情報の最小文字数。
 * これより短い値は誤検知(意図しない部分一致による過剰マスク)を避けるためマスクしない。
 */
const MIN_SECRET_LENGTH = 4;

/** 文字列中に含まれる秘密情報値をすべて "***" に置換する */
export function maskString(value: string, secrets: readonly string[]): string {
  let masked = value;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    masked = masked.split(secret).join("***");
  }
  return masked;
}

/**
 * シークレットの生値に加えて、URL に埋め込まれる際に取り得るエンコード済み表現、および
 * JSON 文字列化された際のエスケープ済み表現を展開する。
 * runner.ts の applyQueryParams は URLSearchParams.set() 経由で値をパーセントエンコードして
 * URL 文字列を組み立てるため、生の値のままでは maskString の単純な部分一致が失敗し、
 * エンコード形(例: "aB%2Bcd%2FEf%3D%3D")が履歴に平文で残ってしまう。
 * form-urlencoded な body など、URL 以外のフィールドでも同様のズレが起こり得るため、
 * url だけを特別扱いせず、マスク対象の全フィールドに対してこの展開済みリストを使う。
 * さらに、request.url テンプレートへ secret を直接埋め込んだ場合(applyQueryParams を経由しない)は、
 * undici の送信処理が行う WHATWG URL 正規化により、生の値とも encodeURIComponent 形とも異なる形
 * (例: 生の値 `p@ss w/rd+key=99!` に対して `p@ss%20w/rd+key=99!`)に変換されてレスポンスへエコーされ
 * うるため、その正規化と近い挙動を持つ encodeURI(secret) 形も加える(生の値と異なる場合のみ)。
 * 同様に、assert.ts の等価アサーション失敗メッセージは JSON.stringify(expected) の結果を
 * そのまま文字列へ埋め込むため、`"` や `\`、制御文字を含むシークレットはエスケープされた形
 * (例: 生の値 `ab"cd` に対して `ab\"cd`)でメッセージ中に現れる。この形も生の値と異なる場合のみ加える。
 *
 * MIN_SECRET_LENGTH の判定は生の値に対してのみ行う(生の値が4文字未満ならどのバリアントも対象外)。
 * 返すリストは長い順に並べる。短いバリアントを先に置換すると、それが長いバリアントの一部を
 * 破壊してしまう(例: 生の値を先に置換すると、その値を含むエンコード形が二度と一致しなくなる)ため。
 */
export function expandSecretVariants(secrets: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    variants.add(secret);
    variants.add(encodeURIComponent(secret));
    // URLSearchParams のシリアライズ形(application/x-www-form-urlencoded)。
    // encodeURIComponent とは空白(%20 と +)や !'()~ の扱いが異なるため、
    // 実際に applyQueryParams が URL を組むのと同じ実装から導出して取りこぼしを防ぐ。
    variants.add(new URLSearchParams({ v: secret }).toString().slice(2));
    // WHATWG URL 正規化形。encodeURI は encodeURIComponent よりエンコード対象が狭く
    // (; , / ? : @ & = + $ - _ . ! ~ * ' ( ) # は非エンコード)、URL に直書きされた secret が
    // 送信時に undici の URL 正規化を経て取る形に近い。生の値と同じ場合は Set が重複を無視する。
    variants.add(encodeURI(secret));
    // JSON.stringify によるエスケープ形。ダブルクォート・バックスラッシュ・制御文字を
    // 含むシークレットのみ生の値と異なる文字列になるため、その場合だけ加える。
    const jsonEscaped = JSON.stringify(secret).slice(1, -1);
    if (jsonEscaped !== secret) {
      variants.add(jsonEscaped);
    }
  }
  return Array.from(variants).sort((a, b) => b.length - a.length);
}

/**
 * 任意の JSON 互換値を深く辿り、文字列だけを秘密情報マスクする(template.ts の renderDeep と対称の実装)。
 * 元の value は変異させず、新しいオブジェクト・配列を組み立てて返す(プリミティブはそのまま)。
 * maskHistoryEntry 内部の各フィールドマスクに加えて、CLI の JSON 経路(src/cli/run.ts)が
 * formatJson でシリアライズする前に RunResult 全体をマスクする用途でも使うため公開する。
 */
export function maskDeep<T>(value: T, secrets: readonly string[]): T {
  return mapDeepStrings(value, (s) => maskString(s, secrets));
}

function maskHeaders(
  headers: Record<string, string>,
  secrets: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = maskString(value, secrets);
  }
  return result;
}

/** 省略可能な文字列フィールド(SseEvent.event / .id 等)を、値がある場合のみマスクする */
function maskOptionalString(
  value: string | undefined,
  secrets: readonly string[],
): string | undefined {
  return value === undefined ? undefined : maskString(value, secrets);
}

/**
 * assertions 配列をマスクする。expected/actual は任意の JSON 互換値になり得るため maskDeep で辿り、
 * message は人間可読な文字列としてそのままマスクする。
 * StepResult と同じ配列オブジェクトを共有しているため、要素を書き換えず新しい配列・オブジェクトとして返す。
 */
function maskAssertions(
  assertions: readonly AssertionResult[],
  secrets: readonly string[],
): AssertionResult[] {
  return assertions.map((assertion) => ({
    ...assertion,
    expected: maskDeep(assertion.expected, secrets),
    actual: maskDeep(assertion.actual, secrets),
    message: maskString(assertion.message, secrets),
  }));
}

/**
 * 履歴エントリ内の秘密情報({{env.X}} で解決した値)をマスクする。
 * request/response の url・headers・body、events の id・event・data、assertions の
 * expected・actual・message を対象に "***" へ置換する。
 * secrets が空の場合は何もせず entry をそのまま返す(不要なコピーを避ける)。
 */
export function maskHistoryEntry(entry: HistoryEntry, secrets: readonly string[]): HistoryEntry {
  if (secrets.length === 0) return entry;

  // url・headers・body・events・assertions のすべてに同じ展開済みリストを使う
  // (エンコード形のズレは url に限らずどのフィールドでも起こり得るため)
  const variants = expandSecretVariants(secrets);

  const request = entry.request
    ? {
        ...entry.request,
        url: maskString(entry.request.url, variants),
        headers: maskHeaders(entry.request.headers, variants),
        body: maskDeep(entry.request.body, variants),
      }
    : undefined;

  const response = entry.response
    ? {
        ...entry.response,
        headers: maskHeaders(entry.response.headers, variants),
        body: maskDeep(entry.response.body, variants),
      }
    : undefined;

  const events = entry.events?.map((event) => ({
    ...event,
    event: maskOptionalString(event.event, variants),
    id: maskOptionalString(event.id, variants),
    data: maskString(event.data, variants),
  }));

  const assertions = maskAssertions(entry.assertions, variants);

  return {
    ...entry,
    assertions,
    ...(request ? { request } : {}),
    ...(response ? { response } : {}),
    ...(events ? { events } : {}),
  };
}

/** Date を履歴ファイル名の日付部分(YYYY-MM-DD)に変換する */
function toDateStr(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * ISO タイムスタンプ(HistoryEntry.startedAt 等)を履歴ファイル名の日付部分(YYYY-MM-DD)に変換する。
 * historyFilePath 内部の日付導出ロジックと同じものを、Date を持たず startedAt 文字列だけを持つ
 * 呼び出し元(CLI JSON レポーター等が historyRef を組み立てる場合)からも使えるように公開する。
 */
export function historyDateFromTimestamp(isoTimestamp: string): string {
  return toDateStr(new Date(isoTimestamp));
}

/**
 * cwd 基準で指定日付(UTC)の履歴ファイルパスを返す(.klaus/history/<YYYY-MM-DD>.jsonl)。
 * 書き込み時は通常エントリの startedAt から求めた Date を渡す(省略時は現在時刻 = 今日のファイル)。
 */
export function historyFilePath(cwd: string, date: Date = new Date()): string {
  return join(cwd, ".klaus", "history", `${toDateStr(date)}.jsonl`);
}

const HISTORY_FILE_NAME_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 履歴ファイル名(YYYY-MM-DD.jsonl)から「そのファイルに含まれ得る startedAt の上限(排他、ISO 文字列)」を返す。
 * 不変条件: ファイル名はエントリ自身の startedAt の UTC 日付(appendHistory → historyFilePath / toDateStr)であり、
 * startedAt が ISO-8601 UTC 文字列(runner が toISOString() で生成する形式)であれば、現行の書き込みでは
 * ファイル D の全エントリは D 00:00:00.000Z <= startedAt < D の翌日 00:00:00.000Z を満たす。
 * 公開 API appendHistory に解釈不能な startedAt(今日のファイルへフォールバック)や非 ISO 文字列が渡された
 * エントリはこの不変条件の対象外であり、そのようなデータに対しては getHistoryPage の打ち切りが全件読みと
 * 一致することは保証されない。
 * ただし旧仕様(追記時点の UTC 日付で命名)で書かれた既存ファイルは、24 時間未満の時計の巻き戻りにより
 * startedAt が D の翌日以降のエントリを含み得るため、それらを取りこぼさないよう 1 日分の安全マージンを
 * 意図的に残し、D + 2 日 00:00:00.000Z を上限とする(ページあたり最大 1 ファイル余分に読むだけで済む)。
 * 契約どおりの名前・実在する日付でない場合は上限を決められないため undefined を返す。
 */
export function historyFileStartedAtUpperBound(fileName: string): string | undefined {
  const match = HISTORY_FILE_NAME_PATTERN.exec(fileName);
  if (!match?.[1]) return undefined;
  const dayStart = Date.parse(`${match[1]}T00:00:00.000Z`);
  if (Number.isNaN(dayStart)) return undefined;
  // 2026-02-30 のような存在しない日付の繰り上がりを検出するため往復一致を確認する
  if (new Date(dayStart).toISOString().slice(0, 10) !== match[1]) return undefined;
  return new Date(dayStart + 2 * DAY_MS).toISOString();
}

/**
 * 履歴を1行(JSON Lines)追記する。ディレクトリが無ければ作成する。
 * 履歴には平文の認証情報が残り得るため、所有者限定権限での追記を appendPrivateLine に委ねる。
 */
export async function appendHistory(cwd: string, entry: HistoryEntry): Promise<void> {
  // ファイル名はエントリ自身の startedAt の UTC 日付で決める(追記時点の日付ではない)。
  // startedAt が不正で日付に変換できない場合は、例外にせず追記時点の日付にフォールバックする。
  const startedAt = new Date(entry.startedAt);
  const filePath = historyFilePath(cwd, Number.isNaN(startedAt.getTime()) ? new Date() : startedAt);
  await appendPrivateLine(filePath, JSON.stringify(entry));
}
