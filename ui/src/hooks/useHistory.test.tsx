import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../api/client";
import { useHistory } from "./useHistory";

vi.mock("@/api/client", () => ({
  getHistory: vi.fn(),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function makeEntry(runId: string): HistoryEntry {
  return {
    v: 1,
    runId,
    flow: "a.yaml",
    step: "step-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 10,
    assertions: [],
  };
}

describe("useHistory", () => {
  it("accumulates entries across pages and stops once nextBefore is absent", async () => {
    const { getHistory } = await import("@/api/client");
    vi.mocked(getHistory).mockImplementation(async ({ before } = {}) => {
      if (before === undefined) {
        return { entries: [makeEntry("run-1")], nextBefore: "cursor-1" };
      }
      expect(before).toBe("cursor-1");
      return { entries: [makeEntry("run-2")], nextBefore: undefined };
    });

    const { result } = renderHook(() => useHistory(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toEqual([makeEntry("run-1")]);
    expect(result.current.hasMore).toBe(true);

    result.current.loadMore();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.entries).toEqual([makeEntry("run-1"), makeEntry("run-2")]);
    expect(result.current.hasMore).toBe(false);
    expect(getHistory).toHaveBeenCalledTimes(2);
  });

  it("returns the error message on failure", async () => {
    const { getHistory } = await import("@/api/client");
    vi.mocked(getHistory).mockRejectedValueOnce(new Error("history unavailable"));

    const { result } = renderHook(() => useHistory(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.entries).toEqual([]);
    expect(result.current.error).toBe("history unavailable");
  });
});
