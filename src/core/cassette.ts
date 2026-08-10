import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeError } from "./errors.js";
import { expandSecretVariants, maskDeep } from "./history.js";
import type { HttpResponse } from "./http.js";
import { parseJsonBody } from "./http.js";

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
 * HTTP レスポンスから CassetteEntry を組み立て、secrets でマスクする。
 * 履歴 JSONL(maskHistoryEntry)と同じ方式(expandSecretVariants + maskDeep)を使い、
 * URL・ヘッダー・bodyText に含まれる {{env.X}} 解決値を "***" に置換してからカセットへ渡す。
 */
export function buildCassetteEntry(
  method: string,
  url: string,
  response: Pick<HttpResponse, "status" | "headers" | "bodyText">,
  secrets: readonly string[],
): CassetteEntry {
  const entry: CassetteEntry = {
    v: 1,
    method: method.toUpperCase(),
    url,
    status: response.status,
    headers: response.headers,
    bodyText: response.bodyText,
  };
  if (secrets.length === 0) return entry;
  const variants = expandSecretVariants(secrets);
  return maskDeep(entry, variants);
}

/** カセットファイルへ1エントリを追記する(record モード)。dir が無ければ作成する */
export async function appendCassetteEntry(dir: string, entry: CassetteEntry): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(cassetteFilePath(dir), `${JSON.stringify(entry)}\n`, "utf-8");
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
  return {
    status: entry.status,
    headers: entry.headers,
    body: parseJsonBody(entry.headers["content-type"], entry.bodyText),
    bodyText: entry.bodyText,
    durationMs: 0,
  };
}
