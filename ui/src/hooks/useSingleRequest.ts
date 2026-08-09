import { useCallback, useRef, useState } from "react";
import type { SingleRequestRequestBody, StepResult } from "../api/client";
import { runSingleRequest } from "../api/client";

export interface UseSingleRequestResult {
  result: StepResult | null;
  loading: boolean;
  error: string | null;
  execute: (request: SingleRequestRequestBody["request"], env?: string) => void;
}

/**
 * POST /api/request を実行する hook(単発リクエスト実行版。useRun.ts の状態管理規約を参考にする。
 * SSE ではなく単発の JSON レスポンスのため、進捗ステップの概念は無く loading/error/result のみ持つ)。
 */
export function useSingleRequest(): UseSingleRequestResult {
  const [result, setResult] = useState<StepResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 実行のたびにインクリメントし、古い実行の応答が後から返ってきても
  // 最新の実行の状態を上書きしないようにするための世代カウンタ
  const requestIdRef = useRef(0);

  const execute = useCallback((request: SingleRequestRequestBody["request"], env?: string) => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    runSingleRequest({ request, env })
      .then((payload) => {
        if (requestIdRef.current !== requestId) return;
        setResult(payload.result);
      })
      .catch((err: unknown) => {
        if (requestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (requestIdRef.current !== requestId) return;
        setLoading(false);
      });
  }, []);

  return { result, loading, error, execute };
}
