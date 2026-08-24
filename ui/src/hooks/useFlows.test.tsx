import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useFlows } from "./useFlows";

vi.mock("@/api/client", () => ({
  getFlows: vi.fn(),
}));

/** テストごとに独立した QueryClient を生成する(キャッシュ汚染防止。retry は無効化して失敗を即座に反映させる) */
function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useFlows", () => {
  it("returns flows on success", async () => {
    const { getFlows } = await import("@/api/client");
    vi.mocked(getFlows).mockResolvedValueOnce([{ path: "a.yaml", name: "A", stepCount: 1 }]);

    const { result } = renderHook(() => useFlows(), { wrapper: createWrapper() });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.flows).toEqual([{ path: "a.yaml", name: "A", stepCount: 1 }]);
    expect(result.current.error).toBeNull();
  });

  it("returns the error message on failure", async () => {
    const { getFlows } = await import("@/api/client");
    vi.mocked(getFlows).mockRejectedValueOnce(new Error("network error"));

    const { result } = renderHook(() => useFlows(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.flows).toEqual([]);
    expect(result.current.error).toBe("network error");
  });
});
