import { useCallback, useState } from "react";
import type { EnvironmentDetail } from "../api/client";
import { captureToEnvironment } from "../api/client";

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

/**
 * POST /api/environments/:name/capture を実行する hook。
 * useSingleRequest / useEnvironmentDetail の状態管理規約(loading→saving・error は setState で保持し、
 * 実行のたびに前回の状態をリセットする)を踏襲する。
 */
export function useCaptureToEnvironment(): UseCaptureToEnvironmentResult {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);

  const capture = useCallback(async (envName: string, key: string, path: string, json: unknown) => {
    setSaving(true);
    setError(null);
    setSavedKey(null);
    try {
      const detail = await captureToEnvironment(envName, { key, path, json });
      setSavedKey(key);
      return detail;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setSaving(false);
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setSavedKey(null);
  }, []);

  return { saving, error, savedKey, capture, reset };
}
