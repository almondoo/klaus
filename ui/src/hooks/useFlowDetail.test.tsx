import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useFlowDetail } from "./useFlowDetail";

vi.mock("@/api/client", () => ({
  getFlowDetail: vi.fn(),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useFlowDetail", () => {
  it("does not fetch and keeps detail null while path is undefined (disabled)", async () => {
    const { getFlowDetail } = await import("@/api/client");

    const { result } = renderHook(() => useFlowDetail(undefined), { wrapper: createWrapper() });

    expect(result.current.detail).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(getFlowDetail).not.toHaveBeenCalled();
  });

  it("fetches and returns detail once path is provided (enabled)", async () => {
    const { getFlowDetail } = await import("@/api/client");
    vi.mocked(getFlowDetail).mockResolvedValueOnce({
      path: "a.yaml",
      name: "A",
      steps: [],
    });

    const { result } = renderHook(({ path }) => useFlowDetail(path), {
      wrapper: createWrapper(),
      initialProps: { path: "a.yaml" as string | undefined },
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(getFlowDetail).toHaveBeenCalledWith("a.yaml");
    expect(result.current.detail).toEqual({ path: "a.yaml", name: "A", steps: [] });
  });

  it("returns the error message on failure", async () => {
    const { getFlowDetail } = await import("@/api/client");
    vi.mocked(getFlowDetail).mockRejectedValueOnce(new Error("not found"));

    const { result } = renderHook(() => useFlowDetail("missing.yaml"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.detail).toBeNull();
    expect(result.current.error).toBe("not found");
  });
});
