import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { EnvironmentDetail } from "../api/client";
import { captureToEnvironment } from "../api/client";
import { environmentDetailOptions } from "../api/queries";

export interface UseCaptureToEnvironmentResult {
  saving: boolean;
  error: string | null;
  /** 直近の capture 呼び出しで保存に成功したキー名(成功メッセージ表示用) */
  savedKey: string | null;
  capture: (
    envName: string,
    key: string,
    path: string,
    json: unknown,
  ) => Promise<EnvironmentDetail | null>;
  /** 入力変更時などに前回の成功/エラー表示を消すためのリセット */
  reset: () => void;
}

interface CaptureVariables {
  envName: string;
  key: string;
  path: string;
  json: unknown;
}

/** POST /api/environments/:name/capture を実行する hook */
export function useCaptureToEnvironment(): UseCaptureToEnvironmentResult {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: ({ envName, key, path, json }: CaptureVariables) =>
      captureToEnvironment(envName, { key, path, json }),
    onSuccess: (_detail, variables) => {
      // 保存先 env の詳細キャッシュを無効化し、開いていれば EnvEditor 側に再取得させる
      queryClient.invalidateQueries({
        queryKey: environmentDetailOptions(variables.envName).queryKey,
      });
    },
  });

  const capture = useCallback(
    async (envName: string, key: string, path: string, json: unknown) => {
      try {
        return await mutation.mutateAsync({ envName, key, path, json });
      } catch {
        return null;
      }
    },
    [mutation],
  );

  const reset = useCallback(() => {
    mutation.reset();
  }, [mutation]);

  return {
    saving: mutation.isPending,
    error:
      mutation.error instanceof Error
        ? mutation.error.message
        : mutation.error
          ? String(mutation.error)
          : null,
    savedKey: mutation.isSuccess ? (mutation.variables?.key ?? null) : null,
    capture,
    reset,
  };
}
