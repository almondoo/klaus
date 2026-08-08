import { CircleNotch } from "@phosphor-icons/react";
import "./Spinner.css";

export interface SpinnerProps {
  size?: number;
  label?: string;
}

/** 300ms を超える待ちに必ず出す実行中インジケータ。prefers-reduced-motion でも回転を維持する */
export function Spinner({ size = 16, label = "読み込み中" }: SpinnerProps) {
  return (
    // <output> は role="status" が暗黙に付与される(a11y: 実行中インジケータをスクリーンリーダーに通知する)
    <output className="klaus-spinner" data-spinner aria-label={label}>
      <CircleNotch size={size} weight="bold" />
    </output>
  );
}
