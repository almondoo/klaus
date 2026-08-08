import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SpinnerProps {
  className?: string;
  label?: string;
}

/** 300ms を超える待ちに必ず出す実行中インジケータ。prefers-reduced-motion でも回転を維持する(data-spinner) */
export function Spinner({ className, label = "読み込み中" }: SpinnerProps) {
  return (
    // <output> は role="status" が暗黙に付与される(a11y: 実行中インジケータをスクリーンリーダーに通知する)
    <output aria-label={label} data-spinner className={cn("inline-flex text-running", className)}>
      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
    </output>
  );
}
