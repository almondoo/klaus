import { useCallback, useEffect, useRef, useState } from "react";
import type { FlowDetail, FlowResult, StepResult } from "../api/client";
import { runFlow } from "../api/client";

export type RunStepStatus = "pending" | "running" | StepResult["status"];

/** 実行ビューが表示する1ステップ分の状態(SSE 進捗で pending → running → passed/failed/... と遷移する) */
export interface RunStepView {
  name: string;
  status: RunStepStatus;
  result?: StepResult;
}

export interface UseRunResult {
  steps: RunStepView[];
  runResult: FlowResult | null;
  running: boolean;
  error: string | null;
  /** 完了ステップ数(全体進捗 "Step n / m" の n) */
  completedCount: number;
  totalCount: number;
  start: (path: string, env?: string) => void;
  cancel: () => void;
}

/** フロー実行の SSE ストリームを購読し、ステップ単位の進捗状態を保持する hook */
export function useRun(flowDetail: FlowDetail | null): UseRunResult {
  const [steps, setSteps] = useState<RunStepView[]>([]);
  const [runResult, setRunResult] = useState<FlowResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const start = useCallback(
    (path: string, env?: string) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      setRunResult(null);
      setError(null);
      setRunning(true);
      setSteps(
        flowDetail ? flowDetail.steps.map((s) => ({ name: s.name, status: "pending" })) : [],
      );

      runFlow(
        { path, env },
        {
          onStepStart: (payload) => {
            setSteps((prev) =>
              prev.map((s) => (s.name === payload.step ? { ...s, status: "running" } : s)),
            );
          },
          onStepResult: (payload) => {
            setSteps((prev) =>
              prev.map((s) =>
                s.name === payload.result.name
                  ? { ...s, status: payload.result.status, result: payload.result }
                  : s,
              ),
            );
          },
          onRunResult: (payload) => {
            setRunResult(payload.flow);
          },
        },
        controller.signal,
      )
        .catch((err: unknown) => {
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (controllerRef.current === controller) setRunning(false);
        });
    },
    [flowDetail],
  );

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    setRunning(false);
  }, []);

  // アンマウント時に進行中のストリームを中断する
  useEffect(() => {
    return () => controllerRef.current?.abort();
  }, []);

  const completedCount = steps.filter(
    (s) => s.status !== "pending" && s.status !== "running",
  ).length;

  return {
    steps,
    runResult,
    running,
    error,
    completedCount,
    totalCount: steps.length,
    start,
    cancel,
  };
}
