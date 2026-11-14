import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../api/client";
import {
  backoffDelay,
  formatActor,
  isLocalRunEcho,
  LOCAL_RUN_GRACE_MS,
  loadedEntryCount,
  nextNewRunCount,
  pickAudit,
} from "./historyEvents";

describe("backoffDelay", () => {
  it("doubles per consecutive failure and caps at 30s", () => {
    expect([0, 1, 2, 3].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffDelay(5)).toBe(30_000);
    expect(backoffDelay(50)).toBe(30_000);
  });
});

describe("isLocalRunEcho", () => {
  it("treats notifications during a local run and within the grace window after it as local", () => {
    expect(isLocalRunEcho(true, 0, 1_000_000)).toBe(true);
    expect(isLocalRunEcho(false, 1000, 1000 + LOCAL_RUN_GRACE_MS - 1)).toBe(true);
    expect(isLocalRunEcho(false, 1000, 1000 + LOCAL_RUN_GRACE_MS)).toBe(false);
    expect(isLocalRunEcho(false, Number.NEGATIVE_INFINITY, 0)).toBe(false);
  });
});

describe("nextNewRunCount", () => {
  it("counts only external notifications while away from the history tab", () => {
    expect(nextNewRunCount(0, { viewingHistory: false, localEcho: false })).toBe(1);
    expect(nextNewRunCount(2, { viewingHistory: false, localEcho: true })).toBe(2);
    expect(nextNewRunCount(2, { viewingHistory: true, localEcho: false })).toBe(0);
  });
});

describe("loadedEntryCount", () => {
  it("sums loaded entries across pages with the page size as the floor", () => {
    const page = (n: number) => ({ entries: new Array(n).fill(null) });
    expect(loadedEntryCount({ pages: [page(20), page(20), page(7)] }, 20)).toBe(47);
    expect(loadedEntryCount({ pages: [page(3)] }, 20)).toBe(20);
    expect(loadedEntryCount(undefined, 20)).toBe(20);
  });
});

describe("formatActor / pickAudit", () => {
  it("formats actor with optional name", () => {
    expect(formatActor(undefined)).toBeNull();
    expect(formatActor({ kind: "human" })).toBe("human");
    expect(formatActor({ kind: "agent", name: "claude" })).toBe("agent:claude");
  });

  it("picks the first actor and env found among the steps", () => {
    const steps = [
      { step: "a" },
      { step: "b", actor: { kind: "agent", name: "x" }, env: "staging" },
    ] as unknown as HistoryEntry[];
    expect(pickAudit(steps)).toEqual({ actor: { kind: "agent", name: "x" }, env: "staging" });
    expect(pickAudit([{ step: "a" }] as unknown as HistoryEntry[])).toEqual({
      actor: undefined,
      env: undefined,
    });
  });
});
