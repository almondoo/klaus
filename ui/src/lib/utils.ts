import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * clsx + tailwind-merge(shadcn/ui 標準パターン)。
 * 条件付きクラス名を結合しつつ、Tailwind のユーティリティクラスが重複した場合は
 * 後勝ちでマージする(例: cn("p-2", condition && "p-4") は "p-4" のみ残る)。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
