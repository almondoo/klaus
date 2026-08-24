import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { environmentsOptions } from "../api/queries";
import { useEnvironmentDetail } from "./useEnvironmentDetail";

vi.mock("@/api/client", () => ({
  getEnvironmentDetail: vi.fn(),
  updateEnvironment: vi.fn(),
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

describe("useEnvironmentDetail", () => {
  it("save() updates the detail cache and invalidates the environments list", async () => {
    const { getEnvironmentDetail, updateEnvironment } = await import("@/api/client");
    vi.mocked(getEnvironmentDetail).mockResolvedValueOnce({
      name: "dev",
      values: { token: "old" },
    });
    vi.mocked(updateEnvironment).mockResolvedValueOnce({
      name: "dev",
      values: { token: "new" },
    });

    const { Wrapper, queryClient } = createWrapper();
    // 一覧クエリをあらかじめ fresh な状態でキャッシュしておき、invalidate されることを検証する
    queryClient.setQueryData(environmentsOptions().queryKey, [{ name: "dev" }]);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useEnvironmentDetail("dev"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.detail).toEqual({ name: "dev", values: { token: "old" } });

    let ok = false;
    await act(async () => {
      ok = await result.current.save({ token: "new" });
    });
    expect(ok).toBe(true);

    await waitFor(() =>
      expect(result.current.detail).toEqual({ name: "dev", values: { token: "new" } }),
    );
    expect(result.current.saving).toBe(false);
    expect(result.current.saveError).toBeNull();
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: environmentsOptions().queryKey,
      exact: true,
    });
  });

  it("save() returns false and exposes the error message via saveError on failure", async () => {
    const { getEnvironmentDetail, updateEnvironment } = await import("@/api/client");
    vi.mocked(getEnvironmentDetail).mockResolvedValueOnce({
      name: "dev",
      values: { token: "old" },
    });
    vi.mocked(updateEnvironment).mockRejectedValueOnce(new Error("update failed"));

    const { Wrapper } = createWrapper();
    const { result } = renderHook(() => useEnvironmentDetail("dev"), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = true;
    await act(async () => {
      ok = await result.current.save({ token: "new" });
    });
    expect(ok).toBe(false);

    await waitFor(() => expect(result.current.saving).toBe(false));
    expect(result.current.saveError).toBe("update failed");
    // 保存に失敗しているため詳細キャッシュは更新前の値のまま
    expect(result.current.detail).toEqual({ name: "dev", values: { token: "old" } });
  });
});
