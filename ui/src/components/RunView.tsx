import { CheckCircle, XCircle } from "@phosphor-icons/react";
import type { FlowDetail } from "../api/client";
import type { UseRunResult } from "../hooks/useRun";
import { formatDuration } from "../utils/format";
import { StepRow } from "./StepRow";
import "./RunView.css";

export interface RunViewProps {
  flowDetail: FlowDetail | null;
  flowDetailLoading: boolean;
  flowDetailError: string | null;
  run: UseRunResult;
}

/** 実行ビュー: ステップ縦リスト + 全体進捗 + 完了サマリー */
export function RunView({ flowDetail, flowDetailLoading, flowDetailError, run }: RunViewProps) {
  if (flowDetailLoading) {
    return <div className="klaus-run-view__placeholder">フロー定義を読み込み中…</div>;
  }

  if (flowDetailError) {
    return (
      <div className="klaus-run-view__placeholder klaus-run-view__placeholder--error">
        {flowDetailError}
      </div>
    );
  }

  if (!flowDetail) {
    return (
      <div className="klaus-run-view__placeholder">
        左のサイドバーからフローを選択してください。
      </div>
    );
  }

  const hasStarted = run.steps.length > 0;

  return (
    <div className="klaus-run-view">
      {hasStarted && (
        // <output> は role="status" が暗黙に付与される(全体進捗 "Step n / m" のライブ通知)
        <output className="klaus-run-view__progress">
          <span>
            Step {Math.min(run.completedCount + (run.running ? 1 : 0), run.totalCount)} /{" "}
            {run.totalCount}
          </span>
          <div className="klaus-run-view__progress-bar">
            <div
              className="klaus-run-view__progress-fill"
              style={{
                width: `${run.totalCount ? (run.completedCount / run.totalCount) * 100 : 0}%`,
              }}
            />
          </div>
        </output>
      )}

      {run.error && <p className="klaus-run-view__error">{run.error}</p>}

      {!hasStarted && (
        <p className="klaus-run-view__hint">
          右上の「実行」ボタンでこのフローを実行します({flowDetail.steps.length} ステップ)。
        </p>
      )}

      <ul className="klaus-run-view__steps">
        {run.steps.map((step) => (
          <StepRow key={step.name} step={step} />
        ))}
      </ul>

      {run.runResult && (
        <output
          className={`klaus-run-view__summary klaus-run-view__summary--${run.runResult.status}`}
        >
          {run.runResult.status === "passed" ? (
            <CheckCircle size={20} weight="regular" />
          ) : (
            <XCircle size={20} weight="regular" />
          )}
          <span>
            {run.runResult.status === "passed" ? "全ステップ成功" : "失敗したステップがあります"}(
            {run.runResult.steps.length} ステップ, {formatDuration(run.runResult.durationMs)})
          </span>
        </output>
      )}
    </div>
  );
}
