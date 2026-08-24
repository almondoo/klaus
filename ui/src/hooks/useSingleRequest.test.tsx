import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { StepResult } from "../api/client";
import { useSingleRequest } from "./useSingleRequest";

vi.mock("@/api/client", () => ({
  runSingleRequest: vi.fn(),
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function makeResult(name: string): StepResult {
  return {
    name,
    status: "passed",
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 5,
    assertions: [],
  };
}

/** resolve/reject を外部から任意のタイミングで発火できる Promise を作る(応答順序を意図的に逆転させるため) */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useSingleRequest", () => {
  it("executes a request and exposes the result, transitioning loading correctly", async () => {
    const { runSingleRequest } = await import("@/api/client");
    // 解決タイミングを明示的に制御し、実行中(loading=true)の状態を確実に観測する
    const deferred = createDeferred<{ result: StepResult }>();
    vi.mocked(runSingleRequest).mockReturnValueOnce(deferred.promise);

    const { result } = renderHook(() => useSingleRequest(), { wrapper: createWrapper() });

    expect(result.current.loading).toBe(false);
    expect(result.current.result).toBeNull();

    act(() => {
      result.current.execute({ url: "https://example.com" });
    });

    await waitFor(() => expect(result.current.loading).toBe(true));

    await act(async () => {
      deferred.resolve({ result: makeResult("step-1") });
      await deferred.promise;
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.result).toEqual(makeResult("step-1"));
    expect(result.current.error).toBeNull();
  });

  it("surfaces the error message on failure", async () => {
    const { runSingleRequest } = await import("@/api/client");
    vi.mocked(runSingleRequest).mockRejectedValueOnce(new Error("request failed"));

    const { result } = renderHook(() => useSingleRequest(), { wrapper: createWrapper() });

    act(() => {
      result.current.execute({ url: "https://example.com" });
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.result).toBeNull();
    expect(result.current.error).toBe("request failed");
  });

  it("latest-call-wins: 1 回目の応答が 2 回目より後に届いても、最終状態は 2 回目(最新)の結果になる", async () => {
    const { runSingleRequest } = await import("@/api/client");
    const first = createDeferred<{ result: StepResult }>();
    const second = createDeferred<{ result: StepResult }>();
    vi.mocked(runSingleRequest)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useSingleRequest(), { wrapper: createWrapper() });

    act(() => {
      result.current.execute({ url: "https://example.com/first" });
    });
    act(() => {
      result.current.execute({ url: "https://example.com/second" });
    });

    expect(runSingleRequest).toHaveBeenCalledTimes(2);

    // 到着順を意図的に逆転させる: 2 回目(最新)を先に解決し、その後で 1 回目(古い)を解決する
    await act(async () => {
      second.resolve({ result: makeResult("step-2") });
      await second.promise;
    });

    await act(async () => {
      first.resolve({ result: makeResult("step-1") });
      await first.promise;
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    // 古い呼び出し(1 回目)の応答が後から届いても、最新の呼び出し(2 回目)の結果で上書きされたままであること
    expect(result.current.result).toEqual(makeResult("step-2"));
    expect(result.current.error).toBeNull();
  });
});
