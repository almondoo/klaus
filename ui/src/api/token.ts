/**
 * 起動 URL の ?token= を読み取り sessionStorage に保持するモジュール。
 * 以降の全 API リクエストは getToken() の値を X-Klaus-Token ヘッダーに付与する。
 */

const STORAGE_KEY = "klaus.token";

let cachedToken: string | null | undefined;

/** URL の ?token= を読み取り sessionStorage へ保存し、URL から token パラメータを取り除く */
function consumeTokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get("token");
  if (!fromUrl) return null;

  sessionStorage.setItem(STORAGE_KEY, fromUrl);
  url.searchParams.delete("token");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  return fromUrl;
}

/** 現在保持しているトークンを返す(未取得なら URL → sessionStorage の順に解決する) */
export function getToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;

  const fromUrl = consumeTokenFromUrl();
  if (fromUrl) {
    cachedToken = fromUrl;
    return cachedToken;
  }

  cachedToken = typeof window === "undefined" ? null : sessionStorage.getItem(STORAGE_KEY);
  return cachedToken;
}

/** テスト用: キャッシュをクリアして再解決させる */
export function resetTokenCache(): void {
  cachedToken = undefined;
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** 401 応答を受け取ったときの通知を購読する(App 側で認証ガード画面への切り替えに使う) */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** api/http.ts から呼ぶ: 401 を検知したことを購読者に知らせる */
export function notifyUnauthorized(): void {
  for (const listener of unauthorizedListeners) listener();
}
