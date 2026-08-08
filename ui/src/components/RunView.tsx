import { CheckCircle2, XCircle } from "lucide-react";
import type { FlowDetail } from "@/api/client";
import { Progress } from "@/components/ui/progress";
import type { UseRunResult } from "@/hooks/useRun";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/utils/format";
import { StepRow } from "./StepRow";

export interface RunViewProps {
  flowDetail: FlowDetail | null;
  flowDetailLoading: boolean;
  flowDetailError: string | null;
  run: UseRunResult;
}

/** 実行ビュー: ステップ縦リスト + 全体進捗 + 完了サマリー */
export function RunView({ flowDetail, flowDetailLoading, flowDetailError, run }: RunViewProps) {
  if (flowDetailLoading) {
    return <div className="p-8 text-center text-muted-foreground">フロー定義を読み込み中…</div>;
  }

  if (flowDetailError) {
    return <div className="p-8 text-center text-fail">{flowDetailError}</div>;
  }

  if (!flowDetail) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        左のサイドバーからフローを選択してください。
      </div>
    );
  }

  const hasStarted = run.steps.length > 0;
  const progressValue = run.totalCount ? (run.completedCount / run.totalCount) * 100 : 0;

  return (
    <div className="flex max-w-3xl flex-col gap-4 p-6">
      {hasStarted && (
        // <output> は role="status" が暗黙に付与される(全体進捗 "Step n / m" のライブ通知)
        <output className="flex items-center gap-3 font-mono text-sm">
          <span>
            Step {Math.min(run.completedCount + (run.running ? 1 : 0), run.totalCount)} /{" "}
            {run.totalCount}
          </span>
          <Progress value={progressValue} className="flex-1" />
        </output>
      )}

      {run.error && <p className="text-sm text-fail">{run.error}</p>}

      {!hasStarted && (
        <p className="text-sm text-muted-foreground">
          右上の「実行」ボタンでこのフローを実行します({flowDetail.steps.length} ステップ)。
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {run.steps.map((step) => (
          <StepRow key={step.name} step={step} />
        ))}
      </ul>

      {run.runResult && (
        <output
          className={cn(
            "flex items-center gap-2 rounded-md p-3 font-semibold",
            run.runResult.status === "passed" ? "bg-pass/12 text-pass" : "bg-fail/12 text-fail",
          )}
        >
          {run.runResult.status === "passed" ? (
            <CheckCircle2 className="size-5" aria-hidden="true" />
          ) : (
            <XCircle className="size-5" aria-hidden="true" />
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
