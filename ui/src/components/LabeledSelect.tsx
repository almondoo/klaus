import type { ReactNode } from "react";
import { Select, SelectContent, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface LabeledSelectProps {
  /** aria-labelledby で紐付けるラベルの id(呼び出し側で一意な値を渡す) */
  labelId: string;
  /** ラベルのテキスト */
  label: string;
  /** true の場合ラベルを画面上には表示せず sr-only にする(省略時は表示する) */
  srOnlyLabel?: boolean;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  triggerSize?: "sm" | "default";
  triggerClassName?: string;
  placeholder?: string;
  /** SelectItem 群 */
  children: ReactNode;
}

/**
 * ラベル付き Select の共通ラッパー。
 * Select は独自コンポーネントで <label> の暗黙的な関連付けを静的解析で検証できないため、
 * span + aria-labelledby で明示的に紐付ける(biome の lint/a11y/noLabelWithoutControl 対策)。
 * ラベルと Select 本体のみを Fragment で返すため、周囲のレイアウト(gap 等)は呼び出し側の
 * ラッパー要素に委ねる。
 */
export function LabeledSelect({
  labelId,
  label,
  srOnlyLabel,
  value,
  onValueChange,
  disabled,
  triggerSize = "default",
  triggerClassName,
  placeholder,
  children,
}: LabeledSelectProps) {
  return (
    <>
      <span id={labelId} className={srOnlyLabel ? "sr-only" : undefined}>
        {label}
      </span>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger size={triggerSize} className={triggerClassName} aria-labelledby={labelId}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </>
  );
}
