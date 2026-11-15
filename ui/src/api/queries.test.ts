import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "./client";
import { refreshHistoryQueries } from "./queries";

vi.mock("./client", () => ({
  getHistory: vi.fn(),
}));

function makeEntry(runId: string): HistoryEntry {
  return {
    v: 1,
    runId,
    flow: "a.yaml",
    step: "s",
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1,
    assertions: [],
  };
}

describe("refreshHistoryQueries", () => {
  it("replaces each cached history query with one page covering the already-loaded count", async () => {
    const { getHistory } = await import("./client");
    const fresh = { entries: [makeEntry("new"), makeEntry("old")], nextBefore: "cursor" };
    vi.mocked(getHistory).mockResolvedValue(fresh);

    const client = new QueryClient();
    const pageOf = (n: number) => ({ entries: new Array(n).fill(makeEntry("x")), nextBefore: "c" });
    client.setQueryData(["history", null], {
      pages: [pageOf(20), pageOf(5)],
      pageParams: [undefined, "c"],
    });
    client.setQueryData(["history", "a.yaml"], { pages: [pageOf(3)], pageParams: [undefined] });
    client.setQueryData(["flows"], ["untouched"]);

    await refreshHistoryQueries(client);

    expect(getHistory).toHaveBeenCalledWith({ flow: undefined, limit: 25 });
    expect(getHistory).toHaveBeenCalledWith({ flow: "a.yaml", limit: 20 });
    expect(client.getQueryData(["history", null])).toEqual({
      pages: [fresh],
      pageParams: [undefined],
    });
    expect(client.getQueryData(["flows"])).toEqual(["untouched"]);
  });

  it("keeps the displayed data when the refetch fails", async () => {
    const { getHistory } = await import("./client");
    vi.mocked(getHistory).mockRejectedValue(new Error("boom"));
    const client = new QueryClient();
    const data = { pages: [{ entries: [makeEntry("x")] }], pageParams: [undefined] };
    client.setQueryData(["history", null], data);

    await refreshHistoryQueries(client);

    expect(client.getQueryData(["history", null])).toEqual(data);
  });
});
