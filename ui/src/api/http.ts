import { getToken, notifyUnauthorized } from "./token";

/** API エラー。status を保持し、呼び出し側で 401 判定などに使う */
export class ApiError extends Error {
  readonly status: number;
  /** サーバーが JSON エラー本文に付けた機械可読の理由(例: フロー保存の template-literal)。無ければ undefined */
  readonly code?: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * エラー応答の本文を表示用に解釈する。サーバーの JSON エラー(`{"error": "...", "code"?: "..."}`)は
 * メッセージ(と code)を取り出し、それ以外(text 応答など)は本文をそのまま使う。
 */
export function parseErrorBody(text: string): { message: string; code?: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { error?: unknown }).error === "string"
    ) {
      const { error, code } = parsed as { error: string; code?: unknown };
      return { message: error, ...(typeof code === "string" ? { code } : {}) };
    }
  } catch {
    // JSON ではない本文はそのまま扱う
  }
  return { message: text };
}

/** すべての API リクエストに X-Klaus-Token を付与する fetch ラッパー */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("X-Klaus-Token", token);

  const response = await fetch(path, { ...init, headers });

  if (response.status === 401) {
    notifyUnauthorized();
    throw new ApiError(401, "認証に失敗しました。CLI から `klaus ui` で起動し直してください。");
  }
  return response;
}

/** JSON を返す API 用のヘルパー。非 2xx はエラーとして投げる */
export async function apiFetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    const { message, code } = parseErrorBody(text);
    throw new ApiError(response.status, message || `Request failed: ${response.status}`, code);
  }
  return (await response.json()) as T;
}
