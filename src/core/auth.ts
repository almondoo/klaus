import { RuntimeError } from "./errors.js";
import type { HttpResponse } from "./http.js";
import type { AuthDef } from "./schema.js";
import { renderString, type TemplateContext } from "./template.js";

/** 展開済み(テンプレート解決済み)の OAuth2 client credentials の設定 */
export interface OAuth2Params {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  audience?: string;
}

/**
 * request.auth / http.auth を展開した結果。basic / bearer はここで Authorization ヘッダー値まで確定する。
 * oauth2 はトークンの取得(ネットワークアクセス)が要るため、ここでは設定だけを返し、実行時に取得する
 * (dry-run は取得せず、header にはプレースホルダーを表示する)。
 */
export type ExpandedAuth =
  | { kind: "basic" | "bearer"; header: string }
  | { kind: "oauth2"; params: OAuth2Params; header: string };

/** dry-run が oauth2 のトークン取得の代わりに表示するプレースホルダー(実行時に取得したトークンに置き換わる) */
export const OAUTH2_PLACEHOLDER_HEADER = "Bearer <oauth2 access token: fetched when the step runs>";

/** 履歴・出力のマスク対象にするため、認証に使う秘密値を登録する */
function registerSecrets(context: TemplateContext, values: readonly string[]): void {
  for (const value of values) {
    if (value !== "") context.secrets?.add(value);
  }
}

/**
 * 有効な認証設定(ステップの request.auth、無ければ http.auth)を展開する。
 * 認証が無い・"none" なら undefined。パスワード・トークン・クライアントシークレットと、Basic の
 * base64 文字列を秘密値として登録する(エンコード形は履歴のマスク側が展開する)。
 * ステップが自分で Authorization ヘッダーを指定している場合は、どちらが効くか曖昧になるためエラーにする。
 */
export function expandAuth(
  stepAuth: AuthDef | undefined,
  defaultAuth: AuthDef | undefined,
  context: TemplateContext,
  headers: Record<string, string>,
): ExpandedAuth | undefined {
  const auth = stepAuth ?? defaultAuth;
  if (auth === undefined || auth === "none") return undefined;

  if (Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) {
    throw new RuntimeError(
      'the step sets both an Authorization header and an auth helper; remove one (use `auth: "none"` to opt out of an inherited http.auth)',
    );
  }

  if ("basic" in auth) {
    const username = renderString(auth.basic.username, context);
    const password = renderString(auth.basic.password, context);
    // dry-run で前段の capture に依存する値が未解決のまま残る場合は、base64 化せずその旨を表示する
    if (context.deferred && (username.includes("{{") || password.includes("{{"))) {
      return { kind: "basic", header: "Basic <depends on a variable captured by an earlier step>" };
    }
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    registerSecrets(context, [password, `${username}:${password}`, encoded]);
    return { kind: "basic", header: `Basic ${encoded}` };
  }
  if ("bearer" in auth) {
    const token = renderString(auth.bearer.token, context);
    registerSecrets(context, [token]);
    return { kind: "bearer", header: `Bearer ${token}` };
  }
  const oauth2 = auth.oauth2;
  const params: OAuth2Params = {
    tokenUrl: renderString(oauth2.tokenUrl, context),
    clientId: renderString(oauth2.clientId, context),
    clientSecret: renderString(oauth2.clientSecret, context),
    ...(oauth2.scope !== undefined ? { scope: renderString(oauth2.scope, context) } : {}),
    ...(oauth2.audience !== undefined ? { audience: renderString(oauth2.audience, context) } : {}),
  };
  registerSecrets(context, [params.clientSecret]);
  return { kind: "oauth2", params, header: OAUTH2_PLACEHOLDER_HEADER };
}

/** トークンエンドポイントへ送る application/x-www-form-urlencoded ボディ(client_secret_post) */
export function buildTokenRequestBody(params: OAuth2Params): string {
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: params.clientId,
    client_secret: params.clientSecret,
  });
  if (params.scope !== undefined) form.set("scope", params.scope);
  if (params.audience !== undefined) form.set("audience", params.audience);
  return form.toString();
}

/** キャッシュ済みトークン(実行単位の HttpSession が保持する) */
export interface CachedToken {
  /** そのまま Authorization ヘッダーに入れる値(例: `Bearer abc`) */
  header: string;
  /** 期限(エポック ms)。expires_in が無い場合は undefined(その実行の間は有効として扱う) */
  expiresAt: number | undefined;
}

/** 期限の直前に切れて 401 になるのを避けるため、この時間だけ早めに期限切れとみなす */
const EXPIRY_SKEW_MS = 5000;

/** キャッシュが有効か(期限なし、または期限までに十分な余裕がある) */
export function isTokenFresh(token: CachedToken, now: number = Date.now()): boolean {
  return token.expiresAt === undefined || now < token.expiresAt - EXPIRY_SKEW_MS;
}

/** キャッシュのキー(同じトークンエンドポイント・クライアント・スコープなら同じトークンを再利用する) */
export function tokenCacheKey(params: OAuth2Params): string {
  return JSON.stringify([
    params.tokenUrl,
    params.clientId,
    params.clientSecret,
    params.scope ?? null,
    params.audience ?? null,
  ]);
}

/**
 * トークンエンドポイントの応答からアクセストークンを取り出す。失敗時は RuntimeError。
 * メッセージにはクライアントシークレットやトークンを含めない(エラーコードの文字列だけを載せる)。
 */
export function parseTokenResponse(response: HttpResponse, now: number = Date.now()): CachedToken {
  const body = response.body;
  const record =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
  if (response.status < 200 || response.status >= 300) {
    const code = typeof record?.error === "string" ? `: ${record.error.slice(0, 100)}` : "";
    throw new RuntimeError(`oauth2 token request failed with status ${response.status}${code}`);
  }
  const accessToken = record?.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new RuntimeError("oauth2 token response has no access_token");
  }
  // Authorization ヘッダーにそのまま入れるため、改行・空白・制御文字を含む値は拒否する(ヘッダーインジェクション対策)。
  // 値そのものはメッセージに含めない
  if (!/^[\x21-\x7e]+$/.test(accessToken)) {
    throw new RuntimeError("oauth2 token response has an access_token with invalid characters");
  }
  const rawType = typeof record?.token_type === "string" ? record.token_type : "Bearer";
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawType)) {
    throw new RuntimeError("oauth2 token response has a token_type with invalid characters");
  }
  const type = rawType.toLowerCase() === "bearer" ? "Bearer" : rawType;
  const expiresIn = Number(record?.expires_in);
  return {
    header: `${type} ${accessToken}`,
    expiresAt:
      record?.expires_in !== undefined && Number.isFinite(expiresIn)
        ? now + expiresIn * 1000
        : undefined,
  };
}

/** 応答ボディから access_token を取り出す(取得に失敗した応答でも、あれば秘密値として登録するため) */
export function extractAccessToken(response: HttpResponse): string | undefined {
  const body = response.body;
  if (typeof body !== "object" || body === null) return undefined;
  const token = (body as Record<string, unknown>).access_token;
  return typeof token === "string" && token !== "" ? token : undefined;
}
