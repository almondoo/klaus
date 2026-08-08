import { getToken, notifyUnauthorized } from "./token";

/** API エラー。status を保持し、呼び出し側で 401 判定などに使う */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
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
    const message = await response.text().catch(() => response.statusText);
    throw new ApiError(response.status, message || `Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}
