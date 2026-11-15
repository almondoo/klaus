import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeError } from "./errors.js";
import { expandSecretVariants, maskDeep, maskString } from "./history.js";
import type { HttpResponse } from "./http.js";
import { parseJsonBodyChecked } from "./http.js";
import { appendPrivateLine } from "./private-file.js";

/**
 * カセット(record/replay モードで使う記録済みリクエスト/レスポンス)1エントリのスキーマ。
 * 履歴 JSONL(history.ts の HistoryEntry)と同様 v で将来の後方互換判断を可能にする。
 * body はレスポンスの生テキスト(bodyText)のみを保持し、JSON パースは replay 時に読み出し側で行う
 * (sendRequest と同じ content-type ベースの判定を再利用できるようにするため)。
 */
export interface CassetteEntry {
  v: 1;
  /** 大文字化した HTTP メソッド */
  method: string;
  /** レンダリング済みの URL。record 時点でマスク済みのため、平文シークレットは含まれない */
  url: string;
  status: number;
  headers: Record<string, string>;
  bodyText: string;
}

/** dir 内のカセットファイルパス。単一ファイル(JSONL)方式で dir/cassette.jsonl に固定する */
export function cassetteFilePath(dir: string): string {
  return join(dir, "cassette.jsonl");
}

/** method + URL(完全一致)からカセットのマッチングキーを組み立てる(method は大文字化して比較する) */
function buildCassetteKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

/**
 * replay・mock の動作が値そのものに依存する構造的なレスポンスヘッダー(小文字)。
 * `ct=application/json` のような cookie 値が秘密値として登録されると content-type が *** になり、
 * replay で本文を JSON として読めなくなるため、cookie 由来の秘密値ではマスクせず、記録した値のままカセットへ書く。
 * ただし env・認証トークンなど cookie 由来ではない秘密値を含む値は、他のヘッダーと同じくマスクのままにする
 * (buildCassetteEntry の structuralSecrets)。location は秘密値を運び得るので含めない。
 */
const STRUCTURAL_HEADERS = new Set([
  "content-type",
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

/**
 * HTTP レスポンスから CassetteEntry を組み立て、secrets でマスクする。
 * 履歴 JSONL(maskHistoryEntry)と同じ方式(expandSecretVariants + maskDeep)を使い、
 * URL・ヘッダー・bodyText に含まれる {{env.X}} 解決値を "***" に置換してからカセットへ渡す。
 * Cookie / Set-Cookie ヘッダーの値は、secrets が空でも maskDeep が位置で *** にする
 * (実行時のレスポンスは生の Set-Cookie を持つため、カセットに残す前に必ずマスクする)。
 * structuralSecrets は secrets のうち cookie 由来ではないもの。構造的ヘッダー(STRUCTURAL_HEADERS)は、
 * これでマスクしても値が変わらない(cookie 由来の秘密値とだけ一致している)場合に限り、元の値へ戻す。
 * 省略時は secrets の全件を対象にする(構造的ヘッダーも通常どおりマスクされる安全側の既定)。
 */
export function buildCassetteEntry(
  method: string,
  url: string,
  response: Pick<HttpResponse, "status" | "headers" | "bodyText">,
  secrets: readonly string[],
  structuralSecrets: readonly string[] = secrets,
): CassetteEntry {
  const entry: CassetteEntry = {
    v: 1,
    method: method.toUpperCase(),
    url,
    status: response.status,
    headers: response.headers,
    bodyText: response.bodyText,
  };
  const masked = maskDeep(entry, expandSecretVariants(secrets));
  // 構造的ヘッダーは、cookie 由来ではない秘密値を含まない場合に限り、部分一致マスクの前の値に戻す
  // (Cookie / Set-Cookie は構造的ヘッダーではないのでマスクのまま)
  const structuralVariants = expandSecretVariants(structuralSecrets);
  for (const [name, value] of Object.entries(entry.headers)) {
    if (
      STRUCTURAL_HEADERS.has(name.toLowerCase()) &&
      maskString(value, structuralVariants) === value
    ) {
      masked.headers[name] = value;
    }
  }
  return masked;
}

/**
 * カセットファイルへ1エントリを追記する(record モード)。dir が無ければ作成する。
 * カセットには平文の認証情報が残り得るため、所有者限定権限での追記を appendPrivateLine に委ねる。
 */
export async function appendCassetteEntry(dir: string, entry: CassetteEntry): Promise<void> {
  await appendPrivateLine(cassetteFilePath(dir), JSON.stringify(entry));
}

/**
 * カセットファイルを読み込み、method+URL(完全一致)でエントリを索引化する(replay モード開始時に1回呼ぶ)。
 * 同一キーの重複行は記録順で最初のものを採用する(同じキーへの再リクエストは常に同じ応答を返す、非消費型)。
 * ファイルが存在しない・読めない場合は、replay に使えるカセットが無いことを示す RuntimeError にする。
 */
export async function loadCassetteIndex(dir: string): Promise<Map<string, CassetteEntry>> {
  const filePath = cassetteFilePath(dir);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeError(
      `failed to read cassette file "${filePath}" for replay mode: ${detail}. Record a cassette first with --record.`,
    );
  }

  const index = new Map<string, CassetteEntry>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entry = JSON.parse(trimmed) as CassetteEntry;
    const key = buildCassetteKey(entry.method, entry.url);
    if (!index.has(key)) index.set(key, entry);
  }
  return index;
}

/**
 * カセットファイルの全エントリを記録順のまま読み込む(mock サーバー用)。
 * loadCassetteIndex と異なり同一キーの重複行も残す(--sequence で記録順に返すため)。
 * ファイルが読めない・JSON として壊れている・エントリとして不正な行がある場合は RuntimeError にする。
 */
export async function loadCassetteEntries(dir: string): Promise<CassetteEntry[]> {
  const filePath = cassetteFilePath(dir);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RuntimeError(
      `failed to read cassette file "${filePath}": ${detail}. Record a cassette first with --record.`,
    );
  }

  const entries: CassetteEntry[] = [];
  const lines = raw.split("\n");
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new RuntimeError(`invalid cassette "${filePath}": line ${i + 1} is not valid JSON`);
    }
    if (!isCassetteEntry(parsed)) {
      throw new RuntimeError(
        `invalid cassette "${filePath}": line ${i + 1} is not a cassette entry (method, url, status, headers, bodyText)`,
      );
    }
    entries.push(parsed);
  }
  return entries;
}

/** 1行分の JSON が CassetteEntry の形をしているか(mock が参照するフィールドのみ)を判定する */
function isCassetteEntry(value: unknown): value is CassetteEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.method === "string" &&
    typeof v.url === "string" &&
    typeof v.status === "number" &&
    typeof v.headers === "object" &&
    v.headers !== null &&
    typeof v.bodyText === "string"
  );
}

/**
 * replay モードで、method + URL(現時点で判明している secrets でマスクしたもの)からカセットのエントリを探す。
 * 記録側の URL は record 時点でマスク済みで保存されているため、再生側もレンダリング済み URL に
 * 同じマスキングを適用してからキー比較する(secrets が同じ env から解決される前提)。
 * 見つからない場合は RuntimeError を投げる(呼び出し元の executeStep の catch でステップ error になり、
 * CLI では exit 3 になる)。エラーメッセージにはマスク済みのキーと再記録の案内を含める。
 */
export function findCassetteEntry(
  index: Map<string, CassetteEntry>,
  method: string,
  url: string,
  secrets: readonly string[],
): CassetteEntry {
  const maskedUrl = secrets.length === 0 ? url : maskDeep(url, expandSecretVariants(secrets));
  const key = buildCassetteKey(method, maskedUrl);
  const entry = index.get(key);
  if (!entry) {
    throw new RuntimeError(
      `no recorded response for "${key}" in replay mode. ` +
        "This request was not captured in the cassette (or the method/URL does not match exactly). " +
        "Re-record this flow with --record <dir> to update the cassette.",
    );
  }
  return entry;
}

/**
 * カセットエントリを HttpResponse 形式に変換する(replay 応答として runner に渡す)。
 * body の JSON 判定は sendRequest(http.ts)と同じ content-type ベースのロジックを踏襲する。
 * durationMs はネットワークに出ないため常に 0 にする。
 */
export function cassetteEntryToHttpResponse(entry: CassetteEntry): HttpResponse {
  const { body, tooDeep } = parseJsonBodyChecked(entry.headers["content-type"], entry.bodyText);
  return {
    status: entry.status,
    headers: entry.headers,
    body,
    bodyText: entry.bodyText,
    ...(tooDeep ? { bodyTooDeep: true as const } : {}),
    durationMs: 0,
  };
}
