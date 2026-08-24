import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { environmentDetailOptions } from "../api/queries";
import { useCaptureToEnvironment } from "./useCaptureToEnvironment";

vi.mock("@/api/client", () => ({
  captureToEnvironment: vi.fn(),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper, queryClient };
}

describe("useCaptureToEnvironment", () => {
  it("on success invalidates the captured environment's detail query", async () => {
    const { captureToEnvironment } = await import("@/api/client");
    vi.mocked(captureToEnvironment).mockResolvedValueOnce({
      name: "dev",
      values: { token: "captured" },
    });

    const { Wrapper, queryClient } = createWrapper();
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useCaptureToEnvironment(), { wrapper: Wrapper });

    let detail: unknown;
    await act(async () => {
      detail = await result.current.capture("dev", "token", "$.token", { token: "captured" });
    });

    expect(detail).toEqual({ name: "dev", values: { token: "captured" } });
    await waitFor(() => expect(result.current.savedKey).toBe("token"));
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBeNull();
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: environmentDetailOptions("dev").queryKey,
    });
  });

  it("returns null and exposes the error message on failure", async () => {
    const { captureToEnvironment } = await import("@/api/client");
    vi.mocked(captureToEnvironment).mockRejectedValueOnce(new Error("capture failed"));

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useCaptureToEnvironment(), { wrapper: Wrapper });

    let detail: unknown;
    await act(async () => {
      detail = await result.current.capture("dev", "token", "$.token", { token: "captured" });
    });

    expect(detail).toBeNull();
    await waitFor(() => expect(result.current.saving).toBe(false));
    expect(result.current.error).toBe("capture failed");
    expect(result.current.savedKey).toBeNull();
  });
});
