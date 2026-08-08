import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, apiFetchJson } from "./http";
import { onUnauthorized, resetTokenCache } from "./token";

describe("apiFetch", () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetTokenCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches the X-Klaus-Token header from sessionStorage", async () => {
    sessionStorage.setItem("klaus.token", "secret-token");
    resetTokenCache();

    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/flows");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Klaus-Token")).toBe("secret-token");
  });

  it("does not attach the header when no token is present", async () => {
    resetTokenCache();
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/api/flows");

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.has("X-Klaus-Token")).toBe(false);
  });

  it("throws ApiError and notifies subscribers on 401", async () => {
    const fetchMock = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);

    await expect(apiFetch("/api/flows")).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("apiFetchJson throws ApiError with response body text on non-2xx", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetchJson("/api/flows")).rejects.toMatchObject({ status: 500 });
  });
});
