import { GuardRefusalError } from "./errors.js";

/**
 * 実行時の安全柵の設定。core は設定ファイルを読まないため、
 * 呼び出し元(CLI の klaus.config.yaml 読み込み、server)がこの形に整えて RunFlowOptions /
 * ExecuteSingleRequestOptions の guard として渡す。
 */
export interface GuardOptions {
  /**
   * 送信先として許可するホストの一覧(エントリの書式は parseAllowedHostEntry を参照)。
   * undefined なら制限なし。配列が渡された場合は、空配列でも制限ありとして扱う
   * (どのホストにも一致しないため全送信が拒否される。fail closed)。
   * klaus.config.yaml 経由では空配列は検証で拒否される(configSchema)。
   */
  allowedHosts?: readonly string[] | undefined;
}

/** parseAllowedHostEntry が返す、許可リスト 1 エントリの解釈結果 */
export interface AllowedHostPattern {
  /** 小文字化・正規化済みのホスト名(IPv6 は角括弧つき)。ワイルドカードの場合は `*.` を除いた基底ドメイン */
  host: string;
  /** `*.example.com` 形式(サブドメインのみ一致し、基底ドメイン自身は一致しない) */
  wildcard: boolean;
  /** 指定時はそのポートのみ一致。未指定なら任意のポートに一致 */
  port?: number;
}

// ホスト部は「角括弧つき IPv6 リテラル」か「: / ? # @ \ [ ] * と空白を含まない文字列」、
// その後ろに任意で :ポート が付く形のみ受け付ける(スキーム・パス・ユーザー情報は拒否する)
const HOST_ENTRY_PATTERN = /^(\[[0-9A-Fa-f:.]+\]|[^\s:/?#@\\[\]*]+)(?::(\d{1,5}))?$/;

/** URL スキームごとの既定ポート(URL#port は既定ポートを空文字にするため、実効ポートの算出に使う) */
const DEFAULT_PORTS: Record<string, number> = {
  "http:": 80,
  "https:": 443,
  "ws:": 80,
  "wss:": 443,
};

/** 読み取り専用の保護環境($protected: "readonly")で --allow-protected なしに送信できるメソッド */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * サーバー側でメソッドを上書きできる代表的なヘッダー(小文字)。
 * GET に付けると書き込み操作に化けさせられるため、読み取り専用の保護環境では拒否する。
 */
const METHOD_OVERRIDE_HEADERS = ["x-http-method-override", "x-http-method", "x-method-override"];

/** 厳密なドット区切り IPv4(各オクテットは 0-255 で、先頭ゼロなし) */
const STRICT_IPV4_PATTERN =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * ホスト部が「URL の正規化の癖でだけ通る」書式でないことを検証する。
 * - パーセントエンコード・空ラベル(`a..b`、先頭/末尾のドット)は拒否する
 * - 末尾ラベルが数値(10進・16進)の場合は、厳密なドット区切り IPv4 のみ許可する
 *   (`0` / `2130706433` / `0x7f.1` / 8進表記などは URL 側で別のアドレスに正規化されるため拒否)
 * - ワイルドカードは IP リテラル・IPv4 に使えず、`*.` の後ろに 2 ラベル以上を要求する(`*.com` は拒否)
 * 単一ラベルの内部名(`backend` / `localhost`)と角括弧つき IPv6 は許可する。
 */
function isStrictHostPart(hostPart: string, wildcard: boolean): boolean {
  if (hostPart.startsWith("[")) return !wildcard;
  if (hostPart.includes("%")) return false;
  const labels = hostPart.split(".");
  if (labels.some((label) => label === "")) return false;
  if (/^(\d+|0x[0-9a-f]*)$/i.test(labels[labels.length - 1] as string)) {
    return !wildcard && STRICT_IPV4_PATTERN.test(hostPart);
  }
  return !wildcard || labels.length >= 2;
}

/**
 * allowedHosts の 1 エントリをパースする。書式が不正なら undefined を返す。
 * 受け付ける書式: `api.example.com`(完全一致)、`*.example.com`(サブドメインのみ。多段も可で、
 * 基底ドメイン自身は含まない)、`localhost:3000`(ポート指定。省略時は任意のポート)、
 * `[::1]` / `[::1]:3000`(IPv6 リテラルは角括弧つき)。ホスト名は大文字小文字を区別しない。
 * 書式の厳密さは isStrictHostPart を参照(リクエスト側の URL は別途 URL の正規化を通して照合する)。
 */
export function parseAllowedHostEntry(entry: string): AllowedHostPattern | undefined {
  const wildcard = entry.startsWith("*.");
  const body = wildcard ? entry.slice(2) : entry;
  const match = HOST_ENTRY_PATTERN.exec(body);
  if (!match) return undefined;
  const hostPart = match[1] as string;
  if (!isStrictHostPart(hostPart, wildcard)) return undefined;

  let host: string;
  try {
    host = new URL(`http://${hostPart}`).hostname;
  } catch {
    return undefined;
  }
  if (host === "") return undefined;

  if (match[2] === undefined) return { host, wildcard };
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return undefined;
  return { host, wildcard, port };
}

/**
 * 送信直前の URL(テンプレート展開後)が許可リストに一致するかを判定する。
 * 許可されない場合は、ステップを error(CLI では exit 3)にするための RuntimeError を返す。
 * guard.allowedHosts が未指定なら常に undefined(制限なし)。
 * URL がパースできない場合と、書式不正のエントリは fail closed(一致しない扱い)にする。
 * エラーメッセージには URL 全体ではなくホスト名のみを含める(クエリ等に秘密情報があり得るため)。
 */
export function checkHostAllowed(
  rawUrl: string,
  guard: GuardOptions | undefined,
): GuardRefusalError | undefined {
  const allowedHosts = guard?.allowedHosts;
  if (allowedHosts === undefined) return undefined;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return new GuardRefusalError(
      "request URL could not be parsed while guard.allowedHosts is set; refusing to send the request.",
    );
  }
  const hostname = url.hostname;
  const port = url.port !== "" ? Number(url.port) : DEFAULT_PORTS[url.protocol];

  for (const entry of allowedHosts) {
    const pattern = parseAllowedHostEntry(entry);
    if (!pattern) continue;
    const hostMatches = pattern.wildcard
      ? hostname.endsWith(`.${pattern.host}`)
      : hostname === pattern.host;
    if (hostMatches && (pattern.port === undefined || pattern.port === port)) return undefined;
  }
  // メッセージのホスト名は、正規化後(小文字化・punycode 化済み)ではなく、展開後の URL 文字列に
  // 現れたままの表記を使う。{{env.X}} で解決した秘密値がホストに含まれていても、既存のマスク
  // (生の値の置換)がそのまま効くようにするため。安全な文字だけで構成されない場合は載せない
  const rawHost = extractRawHostText(rawUrl);
  const hostLabel = rawHost !== undefined ? `host "${rawHost}"` : "request host";
  return new GuardRefusalError(
    `${hostLabel} is not in guard.allowedHosts (klaus.config.yaml); refusing to send the request.`,
  );
}

/**
 * URL 文字列からホスト部(ユーザー情報・ポートを除く)を、書かれたままの表記で取り出す。
 * 取り出せない場合や、英数字・`.-_%[]:` 以外(制御文字・非 ASCII など、パーサーが除去・変換し得る文字)を
 * 含む場合は undefined を返す(メッセージに載せない)。
 */
function extractRawHostText(rawUrl: string): string | undefined {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/?#@]*@)?(\[[0-9A-Fa-f:.]*\]|[^/?#:@]*)/.exec(
    rawUrl.trim(),
  );
  const host = match?.[1];
  if (host === undefined || host === "" || !/^[A-Za-z0-9._%[\]:-]+$/.test(host)) return undefined;
  return host;
}

/**
 * 読み取り専用の保護環境で拒否すべきメソッド上書きヘッダー名(小文字の正規名)を返す。
 * 該当ヘッダーが無ければ undefined。ヘッダー名は大文字小文字を区別せず照合する。
 */
export function findMethodOverrideHeader(
  headers: Record<string, string> | undefined,
): string | undefined {
  if (!headers) return undefined;
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  return METHOD_OVERRIDE_HEADERS.find((candidate) => names.includes(candidate));
}

/** メソッドが読み取り専用の保護環境で許可される安全メソッド(GET / HEAD / OPTIONS)かどうか */
export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.trim().toUpperCase());
}
