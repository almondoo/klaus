/**
 * 実行単位のメモリ上 cookie jar(実行をまたいで保存しない)。
 * ドメイン・パス・Secure・有効期限を判定する。公開サフィックス一覧を持たないため、cookie は常に
 * リクエストホスト限定(host-only)で保存し、サブドメインや親ドメインとは共有しない。
 * `Domain` 属性は、リクエストホストと同じか親ドメインを指す場合に限り(host-only として)受け付ける。
 * これにより `Domain=co.uk` や `Domain=github.io` のような公開サフィックスを使って、同じサフィックス上の
 * 無関係なサイトに cookie を送らせることはできない。
 */

interface StoredCookie {
  name: string;
  value: string;
  /** cookie を設定したレスポンスのホスト(小文字化済み)。送信先ホストが完全一致する場合にだけ送る */
  domain: string;
  path: string;
  secure: boolean;
  /** 有効期限(エポック ms)。undefined ならセッション cookie(jar の寿命 = 実行の寿命) */
  expiresAt: number | undefined;
  /** 保存順(送信時の並び順に使う) */
  seq: number;
}

/** jar に保持する cookie の上限(超えたら古いものから捨てる。メモリ枯渇の防止) */
const MAX_COOKIES = 1000;
/** name=value 部分の最大バイト数(RFC 6265 の推奨に合わせる) */
const MAX_COOKIE_BYTES = 4096;

/** 認識できる IPv4 / IPv6 リテラルのホストかどうか(IP は親ドメインを持たない) */
function isIpHost(host: string): boolean {
  return host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** WebSocket のスキームを cookie 判定用の http(s) に読み替える(wss は Secure として扱う) */
function toCookieUrl(url: URL): URL {
  if (url.protocol === "ws:") return new URL(url.href.replace(/^ws:/, "http:"));
  if (url.protocol === "wss:") return new URL(url.href.replace(/^wss:/, "https:"));
  return url;
}

function isSecureProtocol(protocol: string): boolean {
  return protocol === "https:";
}

/** RFC 6265 5.1.4 の既定パス(リクエストパスの最後の / まで) */
function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";
  const last = pathname.lastIndexOf("/");
  return last <= 0 ? "/" : pathname.slice(0, last);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/** Set-Cookie の 1 行を解析した結果 */
interface ParsedSetCookie {
  name: string;
  value: string;
  attributes: Map<string, string>;
}

function parseSetCookie(line: string): ParsedSetCookie | undefined {
  const parts = line.split(";");
  const pair = (parts[0] ?? "").trim();
  const eq = pair.indexOf("=");
  if (eq <= 0) return undefined;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (name === "") return undefined;
  const attributes = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const attr = part.trim();
    if (attr === "") continue;
    const attrEq = attr.indexOf("=");
    const key = (attrEq === -1 ? attr : attr.slice(0, attrEq)).trim().toLowerCase();
    const attrValue = attrEq === -1 ? "" : attr.slice(attrEq + 1).trim();
    // 同じ属性が複数あれば後勝ち(RFC 6265 5.2)
    attributes.set(key, attrValue);
  }
  return { name, value, attributes };
}

/**
 * 連結済みの Set-Cookie ヘッダー値("a=1; Path=/, b=2")を 1 件ずつに分割する。
 * 区切りのカンマは「直後が cookie 名 + =」のものに限る(Expires の "Wed, 21 Oct ..." は分割しない)。
 * undici は Set-Cookie を配列で返すが、cassette(replay)や正規化後のヘッダーは ", " 連結のため必要になる。
 */
export function splitSetCookieHeader(joined: string): string[] {
  return joined
    .split(/,(?=\s*[^;,=\s]+=)/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export class CookieJar {
  private cookies: StoredCookie[] = [];
  private seq = 0;

  /**
   * レスポンスの Set-Cookie 群を url のレスポンスとして取り込む。
   * 保存(または更新)した cookie の値を返す(呼び出し元が秘密値としてマスク対象に登録する)。
   * 拒否した cookie の値も返す: 拒否理由に関わらず、値がログ等に出る前にマスク対象にするため。
   */
  store(responseUrl: URL, setCookieLines: readonly string[], now: number = Date.now()): string[] {
    const url = toCookieUrl(responseUrl);
    const host = url.hostname.toLowerCase();
    const secureOrigin = isSecureProtocol(url.protocol);
    const values: string[] = [];

    for (const line of setCookieLines) {
      const parsed = parseSetCookie(line);
      if (!parsed) continue;
      if (parsed.value !== "") values.push(parsed.value);
      if (Buffer.byteLength(parsed.name) + Buffer.byteLength(parsed.value) > MAX_COOKIE_BYTES) {
        continue;
      }

      const secure = parsed.attributes.has("secure");
      // 非 Secure のオリジンから Secure cookie を設定させない(中間者による注入の抑止)
      if (secure && !secureOrigin) continue;
      // __Secure- / __Host- プレフィックスの制約
      if (parsed.name.startsWith("__Secure-") && !secure) continue;
      const hasDomainAttr = parsed.attributes.has("domain");
      const rawPath = parsed.attributes.get("path");
      if (parsed.name.startsWith("__Host-")) {
        if (!secure || hasDomainAttr || rawPath !== "/") continue;
      }

      // Domain 属性: リクエストホストと同じか親ドメインなら受け付けるが、保存は常にリクエストホスト限定にする
      // (公開サフィックス一覧を持たないため、親ドメインへの共有は一切行わない)。無関係なドメインは cookie ごと拒否する
      const domain = host;
      if (hasDomainAttr) {
        const attr = (parsed.attributes.get("domain") ?? "").replace(/^\./, "").toLowerCase();
        const isParent = !isIpHost(host) && host.endsWith(`.${attr}`);
        if (attr !== "" && attr !== host && !isParent) continue;
      }

      const path = rawPath?.startsWith("/") ? rawPath : defaultPath(url.pathname);

      // 有効期限: Max-Age が Expires より優先。過去・0 以下は削除の指示
      let expiresAt: number | undefined;
      const maxAge = parsed.attributes.get("max-age");
      if (maxAge !== undefined && /^-?\d+$/.test(maxAge)) {
        expiresAt = now + Number(maxAge) * 1000;
      } else {
        const expires = parsed.attributes.get("expires");
        if (expires !== undefined) {
          const time = Date.parse(expires);
          if (!Number.isNaN(time)) expiresAt = time;
        }
      }

      const sameKey = (cookie: StoredCookie) =>
        cookie.name === parsed.name && cookie.domain === domain && cookie.path === path;
      const existing = this.cookies.find(sameKey);

      if (expiresAt !== undefined && expiresAt <= now) {
        // 削除指示。非 Secure のオリジンから Secure cookie は消せない
        if (existing && !(existing.secure && !secureOrigin)) {
          this.cookies = this.cookies.filter((cookie) => cookie !== existing);
        }
        continue;
      }
      // 非 Secure のオリジンから既存の Secure cookie を上書きさせない
      if (existing?.secure && !secureOrigin) continue;

      this.cookies = this.cookies.filter((cookie) => cookie !== existing);
      this.cookies.push({
        name: parsed.name,
        value: parsed.value,
        domain,
        path,
        secure,
        expiresAt,
        seq: this.seq++,
      });
    }

    if (this.cookies.length > MAX_COOKIES) {
      this.cookies = this.cookies.slice(this.cookies.length - MAX_COOKIES);
    }
    return values;
  }

  /** リクエスト先 URL に送るべき cookie を選ぶ(期限切れは除く。パスの長い順、同じなら保存順) */
  private select(requestUrl: URL, now: number): StoredCookie[] {
    const url = toCookieUrl(requestUrl);
    const host = url.hostname.toLowerCase();
    const secureOrigin = isSecureProtocol(url.protocol);
    this.cookies = this.cookies.filter(
      (cookie) => cookie.expiresAt === undefined || cookie.expiresAt > now,
    );
    return this.cookies
      .filter(
        (cookie) =>
          cookie.domain === host &&
          pathMatches(url.pathname || "/", cookie.path) &&
          (!cookie.secure || secureOrigin),
      )
      .sort((a, b) => b.path.length - a.path.length || a.seq - b.seq);
  }

  /** リクエストに付ける Cookie ヘッダーの値。該当する cookie が無ければ undefined */
  headerFor(requestUrl: URL, now: number = Date.now()): string | undefined {
    const selected = this.select(requestUrl, now);
    if (selected.length === 0) return undefined;
    return selected.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  /** url に対して送られる cookie の値を名前で引く(capture の cookie 用)。無ければ undefined */
  valueFor(name: string, requestUrl: URL, now: number = Date.now()): string | undefined {
    return this.select(requestUrl, now).find((cookie) => cookie.name === name)?.value;
  }
}
