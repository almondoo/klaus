import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Agent, type Dispatcher, ProxyAgent } from "undici";
import { CookieJar, splitSetCookieHeader } from "./cookie-jar.js";
import { GuardRefusalError, RuntimeError } from "./errors.js";
import type { HttpRequestOptions } from "./http.js";
import { DEFAULT_TIMEOUT_MS } from "./http.js";
import type { FlowHttpConfig, HttpConfig } from "./schema.js";
import { renderString, type TemplateContext } from "./template.js";

/** リダイレクトを追う既定の最大ホップ数 */
export const DEFAULT_MAX_REDIRECTS = 10;

/** ホップを持つレスポンス(通常応答・SSE の生応答の両方)の最小の形 */
export interface HopResponse {
  status: number;
  headers: Record<string, string>;
  setCookies?: string[] | undefined;
}

/** 各ホップの送信直前に呼ばれる安全柵の判定(拒否は GuardRefusalError を投げる) */
export type HopCheck = (method: string, url: string, headers: Record<string, string>) => void;

/** 1 ホップ分の実送信。onResponse はレスポンス受信直後(record の書き込みより前)に呼ぶこと */
export type HopSender<R extends HopResponse> = (
  options: HttpRequestOptions,
  onResponse: (response: R) => void,
) => Promise<R>;

export interface FollowResult<R> {
  response: R;
  /** 初回リクエストの後に辿ったリダイレクト先 URL(最後が最終応答の URL)。追わなかった場合は空 */
  redirects: string[];
  /** 全ホップの合計所要時間(ms) */
  elapsedMs: number;
}

/**
 * フロー側の http 設定(followRedirects / maxRedirects / cookies)を、設定ファイル側の既定値にキー単位で上書きする。
 * proxy と tls はフローには書けない(スキーマが拒否する)ため、常に設定ファイル側(base)の値をそのまま使う。
 */
export function mergeHttpConfig(
  base: HttpConfig | undefined,
  override: FlowHttpConfig | undefined,
): HttpConfig | undefined {
  if (!override) return base;
  const merged: HttpConfig = { ...base };
  for (const key of ["followRedirects", "maxRedirects", "cookies"] as const) {
    const value = override[key];
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/** http.tls の ca / cert / key を、定義元ファイルのディレクトリ基準の絶対パスにする */
export function resolveHttpTlsPaths(http: HttpConfig, baseDir: string): HttpConfig {
  if (!http.tls) return http;
  const abs = (path: string | undefined) =>
    path === undefined ? undefined : isAbsolute(path) ? path : resolve(baseDir, path);
  const { ca, cert, key, insecure } = http.tls;
  return {
    ...http,
    tls: {
      ...(ca !== undefined ? { ca: abs(ca) } : {}),
      ...(cert !== undefined ? { cert: abs(cert) } : {}),
      ...(key !== undefined ? { key: abs(key) } : {}),
      ...(insecure !== undefined ? { insecure } : {}),
    },
  };
}

/** ファイルを読む。失敗時は中身に触れないメッセージで RuntimeError にする(鍵の内容は出力に出さない) */
function readTlsFile(label: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new RuntimeError(
      `failed to read http.tls.${label} file "${path}"${code ? ` (${code})` : ""}`,
    );
  }
}

const PROXY_AUTH_HEADERS = new Set(["proxy-authorization"]);
const CREDENTIAL_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
const BODY_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "transfer-encoding",
]);

function omitHeaders(
  headers: Record<string, string>,
  names: ReadonlySet<string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!names.has(key.toLowerCase())) result[key] = value;
  }
  return result;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** proxy の認証情報から、出力に出てはいけない文字列(生の値・デコード後・Basic トークン)を列挙する */
function proxyCredentialSecrets(username: string, password: string): string[] {
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const user = decode(username);
  const pass = decode(password);
  const secrets = [username, password, user, pass];
  if (user !== "" || pass !== "") {
    const base64 = Buffer.from(`${user}:${pass}`).toString("base64");
    secrets.push(base64, `Basic ${base64}`, `${user}:${pass}`);
  }
  return secrets.filter((value) => value !== "");
}

/**
 * 実行単位(フロー 1 回の実行、または単発リクエスト 1 回)の HTTP クライアント。
 * 接続設定(proxy / TLS)、cookie jar をステップ間で共有し、実行終了時に close する。
 * 設定がすべて未指定なら dispatcher を作らず(undici の既定のまま)、従来と同じ挙動になる。
 */
export class HttpSession {
  /** cookies: true のときだけ存在する実行単位の cookie jar */
  readonly jar: CookieJar | undefined;
  private dispatcher: Dispatcher | undefined;
  private wsDispatcher: Dispatcher | undefined;
  private built = false;
  private readonly warned = new Set<string>();

  constructor(
    private readonly config: HttpConfig | undefined,
    private readonly onWarning?: (message: string) => void,
  ) {
    this.jar = config?.cookies === true ? new CookieJar() : undefined;
  }

  get followRedirects(): boolean {
    return this.config?.followRedirects === true;
  }

  get maxRedirects(): number {
    return this.config?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.onWarning?.(message);
  }

  /** TLS の接続オプションを組み立てる(設定が無ければ undefined) */
  private buildConnectOptions(): Record<string, unknown> | undefined {
    const tls = this.config?.tls;
    if (!tls) return undefined;
    if ((tls.cert === undefined) !== (tls.key === undefined)) {
      throw new RuntimeError("http.tls.cert and http.tls.key must be set together");
    }
    const options: Record<string, unknown> = {};
    if (tls.ca !== undefined) options.ca = readTlsFile("ca", tls.ca);
    if (tls.cert !== undefined && tls.key !== undefined) {
      options.cert = readTlsFile("cert", tls.cert);
      options.key = readTlsFile("key", tls.key);
    }
    if (tls.insecure === true) {
      options.rejectUnauthorized = false;
      this.warnOnce(
        "http.tls.insecure is enabled: TLS certificate verification is DISABLED for this run",
      );
    }
    return Object.keys(options).length > 0 ? options : undefined;
  }

  /**
   * dispatcher(proxy / TLS を反映したクライアント)を初回の送信時に作る。proxy はテンプレートを使えるため
   * 送信側のテンプレートコンテキストで展開する。認証情報つきの proxy URL は userinfo を取り除いて
   * undici に渡し、認証情報は秘密値としてマスク対象に登録する。
   * 設定が無ければ何も作らない(従来どおり undici の既定 dispatcher を使う)。
   */
  private build(context: TemplateContext, tunnel: boolean): void {
    const connect = this.buildConnectOptions();
    const proxyTemplate = this.config?.proxy;
    if (proxyTemplate === undefined) {
      // 明示的な Agent を常に使う。undici の既定(グローバル)dispatcher は、実行環境の設定次第で
      // 環境変数の proxy(NODE_USE_ENV_PROXY など)を読み得るため、klaus は設定ファイルの proxy 以外を使わない
      this.dispatcher = new Agent(connect ? { connect } : {});
      return;
    }

    // proxy のテンプレートで参照できるのは {{env.X}}(OS 環境変数)だけ。フローの変数や capture は渡さない
    const proxyContext: TemplateContext = {
      captures: {},
      env: {},
      ...(context.secrets ? { secrets: context.secrets } : {}),
    };
    const rendered = renderString(proxyTemplate, proxyContext);
    let proxyUrl: URL;
    try {
      proxyUrl = new URL(rendered);
    } catch {
      // 認証情報を含み得るため、URL 自体はメッセージに載せない
      throw new RuntimeError("http.proxy is not a valid URL");
    }
    if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
      throw new RuntimeError("http.proxy must use the http:// or https:// scheme");
    }
    let token: string | undefined;
    if (proxyUrl.username !== "" || proxyUrl.password !== "") {
      for (const secret of proxyCredentialSecrets(proxyUrl.username, proxyUrl.password)) {
        context.secrets?.add(secret);
      }
      const decode = (value: string) => decodeURIComponent(value);
      const credentials = `${decode(proxyUrl.username)}:${decode(proxyUrl.password)}`;
      token = `Basic ${Buffer.from(credentials).toString("base64")}`;
      proxyUrl.username = "";
      proxyUrl.password = "";
    }
    const agent = new ProxyAgent({
      uri: proxyUrl.href,
      ...(token !== undefined ? { token } : {}),
      ...(connect ? { requestTls: connect, proxyTls: connect } : {}),
      ...(tunnel ? { proxyTunnel: true } : {}),
    });
    if (tunnel) this.wsDispatcher = agent;
    else this.dispatcher = agent;
  }

  /** フローが与えたヘッダーのうち、proxy 設定時に Proxy-Authorization を落とす(proxy の認証は設定ファイルの URL だけ) */
  private sanitize(headers: Record<string, string>): Record<string, string> {
    return this.config?.proxy === undefined ? headers : omitHeaders(headers, PROXY_AUTH_HEADERS);
  }

  /** HTTP / SSE 用の dispatcher。実送信の直前に呼ぶ(replay では呼ばない)。 */
  prepare(context: TemplateContext): Dispatcher {
    if (!this.built) {
      this.build(context, false);
      this.built = true;
    }
    return this.dispatcher as Dispatcher;
  }

  /**
   * WebSocket 用の dispatcher と Cookie ヘッダー。ws:// のハンドシェイクを proxy 越しにするには
   * CONNECT トンネルが要るため、proxy 設定時は専用のトンネル dispatcher を使う。
   */
  prepareWebSocket(
    url: string,
    headers: Record<string, string>,
    context: TemplateContext,
  ): { dispatcher: Dispatcher | undefined; headers: Record<string, string> } {
    let dispatcher: Dispatcher | undefined;
    if (this.config?.proxy !== undefined) {
      if (!this.wsDispatcher) this.build(context, true);
      dispatcher = this.wsDispatcher;
    } else {
      dispatcher = this.prepare(context);
    }
    return { dispatcher, headers: this.withCookies(this.sanitize(headers), url) };
  }

  /** jar の cookie を Cookie ヘッダーに足す(ユーザー指定の Cookie ヘッダーは残し、jar の値を後ろに続ける) */
  private withCookies(headers: Record<string, string>, url: string): Record<string, string> {
    if (!this.jar) return headers;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return headers;
    }
    const jarValue = this.jar.headerFor(parsed);
    if (jarValue === undefined) return headers;
    const userKey = Object.keys(headers).find((key) => key.toLowerCase() === "cookie");
    if (userKey === undefined) return { ...headers, Cookie: jarValue };
    return { ...headers, [userKey]: `${headers[userKey]}; ${jarValue}` };
  }

  /** レスポンスの Set-Cookie を jar に取り込み、値を秘密値として登録する(cookies: false なら何もしない) */
  private absorb(url: string, response: HopResponse, context: TemplateContext): void {
    if (!this.jar) return;
    const lines =
      response.setCookies ??
      (response.headers["set-cookie"] !== undefined
        ? splitSetCookieHeader(response.headers["set-cookie"])
        : []);
    if (lines.length === 0) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    for (const value of this.jar.store(parsed, lines)) context.secrets?.add(value);
  }

  /** url に対して jar が送る cookie の値(capture の cookie 用)。cookies: false なら undefined */
  cookieValue(name: string, url: string): string | undefined {
    if (!this.jar) return undefined;
    try {
      return this.jar.valueFor(name, new URL(url));
    } catch {
      return undefined;
    }
  }

  /**
   * リダイレクトを 1 ホップずつ処理しながら送信する。followRedirects が false なら 1 ホップだけ送る。
   * 各ホップ(初回を含む)の送信直前に check で安全柵を再判定し、cookie は jar からホップの URL ごとに
   * 付け直す。別オリジンへ移るときは Authorization / Cookie / Proxy-Authorization を落とす。
   */
  async send<R extends HopResponse>(
    options: HttpRequestOptions,
    context: TemplateContext,
    check: HopCheck,
    sendOne: HopSender<R>,
    discard: (response: R) => void,
    /** true なら実送信しない(replay)ため dispatcher を作らない */
    offline: boolean,
  ): Promise<FollowResult<R>> {
    const startedAt = performance.now();
    const totalMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let method = options.method;
    let url = options.url;
    let baseHeaders = this.sanitize({ ...options.headers });
    let body = options.body;
    const redirects: string[] = [];
    let previousStatus = 0;

    for (let hop = 0; ; hop++) {
      try {
        check(method, url, baseHeaders);
      } catch (error) {
        if (hop > 0 && error instanceof GuardRefusalError) {
          throw new GuardRefusalError(
            `redirect hop ${hop} (after ${previousStatus}) refused: ${error.message}`,
          );
        }
        throw error;
      }
      const dispatcher = offline ? undefined : this.prepare(context);
      const remaining = totalMs - (performance.now() - startedAt);
      if (hop > 0 && remaining <= 0) {
        throw new RuntimeError(
          `request timed out after ${totalMs}ms: ${method} (redirect hop ${hop})`,
        );
      }

      const hopUrl = url;
      const response = await sendOne(
        {
          ...options,
          method,
          url,
          headers: this.withCookies(baseHeaders, url),
          body,
          timeoutMs: hop === 0 ? totalMs : remaining,
          ...(dispatcher ? { dispatcher } : {}),
        },
        (received) => this.absorb(hopUrl, received, context),
      );

      const location = response.headers.location;
      if (!this.followRedirects || !isRedirectStatus(response.status) || location === undefined) {
        return { response, redirects, elapsedMs: performance.now() - startedAt };
      }
      if (redirects.length >= this.maxRedirects) {
        discard(response);
        throw new RuntimeError(
          `too many redirects (more than ${this.maxRedirects}): ${options.method}`,
        );
      }
      discard(response);

      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new RuntimeError(
          `redirect response has an invalid Location header (status ${response.status})`,
        );
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new RuntimeError(
          `redirect to unsupported scheme "${next.protocol}" refused (status ${response.status})`,
        );
      }

      // 301 / 302 は POST のとき、303 は HEAD 以外のとき GET に変えてボディを落とす。307 / 308 は保つ
      const toGet =
        (response.status === 303 && method !== "GET" && method !== "HEAD") ||
        ((response.status === 301 || response.status === 302) && method === "POST");
      if (toGet) {
        method = "GET";
        body = undefined;
        baseHeaders = omitHeaders(baseHeaders, BODY_HEADERS);
      }
      // 別オリジンへ移るときは資格情報を落とす(以降の経路でも戻さない)
      if (originOf(url) !== next.origin) {
        baseHeaders = omitHeaders(baseHeaders, CREDENTIAL_HEADERS);
      }
      previousStatus = response.status;
      url = next.href;
      redirects.push(url);
    }
  }

  async close(): Promise<void> {
    const dispatchers = [this.dispatcher, this.wsDispatcher].filter(
      (dispatcher): dispatcher is Dispatcher => dispatcher !== undefined,
    );
    this.dispatcher = undefined;
    this.wsDispatcher = undefined;
    await Promise.all(dispatchers.map((dispatcher) => dispatcher.close().catch(() => undefined)));
  }
}
