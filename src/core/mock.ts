import type { CassetteEntry } from "./cassette.js";

/**
 * mock サーバー用のマッチングロジック(純粋関数 + 順次応答の状態のみ。I/O は持たない)。
 * マッチングキーは method + path + query(記録時のホストは捨てる。クライアントは localhost に向くため)。
 */

export interface MockMatcherOptions {
  /** 指定した記録済みオリジン(例: http://api.example.com)のエントリだけを使う */
  origin?: string | undefined;
  /** query を無視して method + path だけで照合する */
  ignoreQuery?: boolean | undefined;
  /** 同一キーの複数エントリを記録順に返し、尽きたら最後を繰り返す(既定は常に先頭) */
  sequence?: boolean | undefined;
}

/** method+path+query が衝突した(複数オリジンが同じキーを持つ)ことを示す情報 */
export interface MockCollision {
  /** "GET /users?page=1" 形式のキー */
  key: string;
  /** 採用された(最初に出現した)オリジン */
  winner: string;
  /** 捨てられたオリジン */
  ignored: string[];
}

export interface MockMatcher {
  /** 記録済みの method+path+query(--ignore-query 時は method+path)の種類数 */
  routeCount: number;
  /** 取り込んだ記録済みオリジン(出現順) */
  origins: string[];
  collisions: MockCollision[];
  /** target は req.url 形式("/path?query")。マッチしなければ undefined */
  match(method: string, target: string): CassetteEntry | undefined;
  /** 未マッチ時のヒント用に、近い記録済みパス("METHOD /path")を最大 limit 件返す(ボディは含めない) */
  closestPaths(method: string, target: string, limit?: number): string[];
}

interface RouteGroup {
  key: string;
  origin: string;
  entries: CassetteEntry[];
  /** --sequence で次に返す位置 */
  cursor: number;
}

/** URL 文字列のオリジンを正規化する。URL として解釈できなければ undefined */
export function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.origin === "null" ? undefined : url.origin;
  } catch {
    return undefined;
  }
}

/** query を順序非依存の正規形(name, value の昇順に並べた文字列)にする */
function canonicalQuery(search: string): string {
  const pairs = [...new URLSearchParams(search).entries()];
  pairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return new URLSearchParams(pairs).toString();
}

export interface ParsedTarget {
  path: string;
  /** "?" を含まない生の query 文字列 */
  query: string;
}

/**
 * リクエストターゲットを path + query に分解する。パーセントエンコードは解釈しない(不正な値でも落ちない)。
 * - origin-form("/path?query"): そのまま使う。先頭が "//" でも host とは解釈せず path の一部として扱う
 * - absolute-form("http://host/path?query"): http/https のみ許可し、path + query を使う(host は捨てる)
 * - それ以外(asterisk-form "*"、authority-form "host:port" など)は undefined
 */
export function parseRequestTarget(target: string): ParsedTarget | undefined {
  let rest = target;
  if (!target.startsWith("/")) {
    if (!/^https?:\/\//i.test(target)) return undefined;
    try {
      const url = new URL(target);
      rest = `${url.pathname}${url.search}`;
    } catch {
      return undefined;
    }
  }
  const hashIndex = rest.indexOf("#");
  if (hashIndex >= 0) rest = rest.slice(0, hashIndex);
  const queryIndex = rest.indexOf("?");
  if (queryIndex < 0) return { path: rest, query: "" };
  return { path: rest.slice(0, queryIndex), query: rest.slice(queryIndex + 1) };
}

function joinKey(method: string, path: string, query: string | undefined): string {
  const q = query === undefined || query === "" ? "" : `?${query}`;
  return `${method.toUpperCase()} ${path}${q}`;
}

/**
 * カセットのエントリ(記録順)からマッチャーを組み立てる。
 * 照合順: (1) query 文字列の完全一致 (2) query パラメータの順序非依存一致。--ignore-query 時は path のみ。
 * 複数オリジンのエントリは既定で統合し、衝突したキーは最初のオリジンを採用して collisions に記録する。
 */
export function createMockMatcher(
  entries: readonly CassetteEntry[],
  options: MockMatcherOptions = {},
): MockMatcher {
  const ignoreQuery = options.ignoreQuery === true;
  const sequence = options.sequence === true;
  const wantedOrigin = options.origin === undefined ? undefined : normalizeOrigin(options.origin);

  const exact = new Map<string, RouteGroup>();
  const canonical = new Map<string, RouteGroup>();
  const origins: string[] = [];
  const collisions = new Map<string, MockCollision>();
  const recordedPaths = new Set<string>();

  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      continue;
    }
    const origin = url.origin;
    if (wantedOrigin !== undefined && origin !== wantedOrigin) continue;
    if (!origins.includes(origin)) origins.push(origin);

    const query = url.search.startsWith("?") ? url.search.slice(1) : "";
    const exactKey = joinKey(entry.method, url.pathname, ignoreQuery ? "" : query);
    recordedPaths.add(`${entry.method.toUpperCase()} ${url.pathname}`);

    const existing = exact.get(exactKey);
    if (existing !== undefined) {
      if (existing.origin === origin) {
        existing.entries.push(entry);
      } else {
        const collision = collisions.get(exactKey) ?? {
          key: exactKey,
          winner: existing.origin,
          ignored: [],
        };
        if (!collision.ignored.includes(origin)) collision.ignored.push(origin);
        collisions.set(exactKey, collision);
      }
      continue;
    }
    const group: RouteGroup = { key: exactKey, origin, entries: [entry], cursor: 0 };
    exact.set(exactKey, group);
    if (!ignoreQuery) {
      const canonicalKey = joinKey(entry.method, url.pathname, canonicalQuery(query));
      if (!canonical.has(canonicalKey)) canonical.set(canonicalKey, group);
    }
  }

  const pick = (group: RouteGroup): CassetteEntry => {
    if (!sequence) return group.entries[0] as CassetteEntry;
    const index = Math.min(group.cursor, group.entries.length - 1);
    group.cursor += 1;
    return group.entries[index] as CassetteEntry;
  };

  return {
    routeCount: exact.size,
    origins,
    collisions: [...collisions.values()],
    match(method, target) {
      const parsed = parseRequestTarget(target);
      if (parsed === undefined) return undefined;
      const query = ignoreQuery ? "" : parsed.query;
      const hit = exact.get(joinKey(method, parsed.path, query));
      if (hit !== undefined) return pick(hit);
      if (ignoreQuery) return undefined;
      const fallback = canonical.get(joinKey(method, parsed.path, canonicalQuery(parsed.query)));
      return fallback === undefined ? undefined : pick(fallback);
    },
    closestPaths(method, target, limit = 5) {
      const parsed = parseRequestTarget(target);
      if (parsed === undefined) return [];
      return rankClosestPaths(method, parsed.path, [...recordedPaths], limit);
    },
  };
}

/** 先頭から一致するパスセグメント数 */
function commonPrefixSegments(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/** 記録済みの "METHOD /path" 候補を、同一メソッド優先・共通セグメント数・長さ差で並べて上位を返す */
function rankClosestPaths(
  method: string,
  path: string,
  candidates: string[],
  limit: number,
): string[] {
  const wanted = method.toUpperCase();
  const segments = path.split("/").filter(Boolean);
  const scored = candidates.map((candidate) => {
    const space = candidate.indexOf(" ");
    const candMethod = candidate.slice(0, space);
    const candSegments = candidate
      .slice(space + 1)
      .split("/")
      .filter(Boolean);
    return {
      candidate,
      sameMethod: candMethod === wanted ? 1 : 0,
      common: commonPrefixSegments(segments, candSegments),
      lengthDiff: Math.abs(segments.length - candSegments.length),
    };
  });
  scored.sort(
    (a, b) =>
      b.sameMethod - a.sameMethod ||
      b.common - a.common ||
      a.lengthDiff - b.lengthDiff ||
      a.candidate.localeCompare(b.candidate),
  );
  return scored.slice(0, limit).map((s) => s.candidate);
}

/** 再送出時に不正になるため mock 応答から落とすヘッダー(小文字) */
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  // bodyText は保存済みのテキスト(UTF-8)をそのまま返すため、記録時の圧縮方式を名乗ると
  // クライアントが展開に失敗する。落として平文として返す
  "content-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
]);

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** ボディを持たないステータス(1xx / 204 / 304) */
function isBodylessStatus(status: number): boolean {
  return (status >= 100 && status < 200) || status === 204 || status === 304;
}

/**
 * カセットエントリから mock の応答(ステータス・ヘッダー・ボディ)を組み立てる。
 * - content-length は保存済みテキストから再計算する
 * - 記録時のオリジンの CORS ポリシー(access-control-*)は別オリジンには無意味なため常に落とす
 *   (--cors 時は呼び出し側が mock 自身の許可ヘッダーを付ける)
 * - 1xx / 204 / 304 はボディも content-length も付けない。HEAD はボディを送らず、
 *   対応する GET と同じ content-length を返す(RFC 9110 で許容される)
 */
export function buildMockResponse(entry: CassetteEntry, method = "GET"): MockResponse {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(entry.headers)) {
    const lower = name.toLowerCase();
    if (DROPPED_RESPONSE_HEADERS.has(lower) || lower.startsWith("access-control-")) continue;
    headers[name] = value;
  }
  if (isBodylessStatus(entry.status)) {
    return { status: entry.status, headers, body: Buffer.alloc(0) };
  }
  const body = Buffer.from(entry.bodyText, "utf-8");
  headers["content-length"] = String(body.byteLength);
  const isHead = method.toUpperCase() === "HEAD";
  return { status: entry.status, headers, body: isHead ? Buffer.alloc(0) : body };
}
