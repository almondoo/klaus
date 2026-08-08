import { CheckCircle2, Circle, Loader2, MinusCircle, XCircle } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { RunStepStatus } from "@/hooks/useRun";
import { cn } from "@/lib/utils";

const LABELS: Record<RunStepStatus, string> = {
  pending: "待機中",
  running: "実行中",
  passed: "成功",
  failed: "失敗",
  error: "エラー",
  skipped: "スキップ",
};

const VARIANTS: Record<RunStepStatus, NonNullable<BadgeProps["variant"]>> = {
  pending: "pending",
  running: "running",
  passed: "pass",
  failed: "fail",
  error: "fail",
  skipped: "skipped",
};

export interface StatusBadgeProps {
  status: RunStepStatus;
  className?: string;
}

/**
 * ステータスを色 + アイコン + テキストの3重表現で示す(色だけに意味を持たせないアクセシビリティ要件)。
 */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <Badge variant={VARIANTS[status]} className={cn(className)}>
      <StatusIcon status={status} />
      <span>{LABELS[status]}</span>
    </Badge>
  );
}

function StatusIcon({ status }: { status: RunStepStatus }) {
  switch (status) {
    case "passed":
      return <CheckCircle2 aria-hidden="true" />;
    case "failed":
    case "error":
      return <XCircle aria-hidden="true" />;
    case "skipped":
      return <MinusCircle aria-hidden="true" />;
    case "running":
      // data-spinner: prefers-reduced-motion の一括停止から除外し、回転だけは維持する
      return <Loader2 aria-hidden="true" data-spinner className="animate-spin" />;
    default:
      return <Circle aria-hidden="true" />;
  }
}
