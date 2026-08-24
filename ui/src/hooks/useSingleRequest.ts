import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import type { SingleRequestRequestBody, StepResult } from "../api/client";
import { runSingleRequest } from "../api/client";

export interface UseSingleRequestResult {
  result: StepResult | null;
  loading: boolean;
  error: string | null;
  execute: (request: SingleRequestRequestBody["request"], env?: string) => void;
}

/**
 * POST /api/request を実行する hook(単発リクエスト実行版)。
 * useMutation の呼び出しごとの state が最新実行を表すため、古い実行の応答が
 * 後から返ってきても上書きされない(旧来の requestIdRef による世代管理は不要)。
 */
export function useSingleRequest(): UseSingleRequestResult {
  const mutation = useMutation({
    mutationFn: ({
      request,
      env,
    }: {
      request: SingleRequestRequestBody["request"];
      env?: string;
    }) => runSingleRequest({ request, env }),
  });

  const execute = useCallback(
    (request: SingleRequestRequestBody["request"], env?: string) => {
      mutation.mutate({ request, env });
    },
    [mutation],
  );

  return {
    result: mutation.data?.result ?? null,
    loading: mutation.isPending,
    error:
      mutation.error instanceof Error
        ? mutation.error.message
        : mutation.error
          ? String(mutation.error)
          : null,
    execute,
  };
}
