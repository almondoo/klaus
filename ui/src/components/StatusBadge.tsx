import { CheckCircle, Circle, CircleNotch, MinusCircle, XCircle } from "@phosphor-icons/react";
import type { RunStepStatus } from "../hooks/useRun";
import "./StatusBadge.css";

const LABELS: Record<RunStepStatus, string> = {
  pending: "待機中",
  running: "実行中",
  passed: "成功",
  failed: "失敗",
  error: "エラー",
  skipped: "スキップ",
};

/**
 * ステータスを色 + アイコン + テキストの3重表現で示す(色だけに意味を持たせないアクセシビリティ要件)。
 */
export function StatusBadge({ status }: { status: RunStepStatus }) {
  const label = LABELS[status];

  return (
    <span className={`klaus-status-badge klaus-status-badge--${status}`}>
      <StatusIcon status={status} />
      <span>{label}</span>
    </span>
  );
}

function StatusIcon({ status }: { status: RunStepStatus }) {
  switch (status) {
    case "passed":
      return <CheckCircle size={16} weight="regular" />;
    case "failed":
    case "error":
      return <XCircle size={16} weight="regular" />;
    case "skipped":
      return <MinusCircle size={16} weight="regular" />;
    case "running":
      return (
        <span data-spinner className="klaus-status-badge__spin">
          <CircleNotch size={16} weight="regular" />
        </span>
      );
    default:
      return <Circle size={16} weight="regular" />;
  }
}
