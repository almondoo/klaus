import { useMemo } from "react";
import { cn } from "@/lib/utils";

const TOKEN_PATTERN =
  /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;

/**
 * JSON 文字列を軽量にトークン化して HTML(エスケープ済み)を返す。依存追加なしの自前実装。
 * クラス名は Tailwind のユーティリティクラス(text-*)をそのまま使う。
 */
function highlightJson(json: string): string {
  const escaped = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return escaped.replace(TOKEN_PATTERN, (match) => {
    let className = "text-fuchsia-300";
    if (match.startsWith('"')) {
      className = match.endsWith(":") ? "text-sky-300" : "text-pass";
    } else if (match === "true" || match === "false") {
      className = "text-skipped";
    } else if (match === "null") {
      className = "text-muted-foreground";
    }
    return `<span class="${className}">${match}</span>`;
  });
}

export interface JsonBlockProps {
  value: unknown;
  className?: string;
  maxHeight?: number;
}

/** リクエスト/レスポンス JSON の表示用。内部スクロールのみ許可し、ページ全体には横スクロールを出さない */
export function JsonBlock({ value, className, maxHeight = 320 }: JsonBlockProps) {
  const html = useMemo(() => {
    const json = value === undefined ? "undefined" : JSON.stringify(value, null, 2);
    return highlightJson(json ?? "null");
  }, [value]);

  return (
    <pre
      className={cn(
        "overflow-auto rounded-sm border border-border bg-popover p-3 font-mono text-sm leading-relaxed whitespace-pre",
        className,
      )}
      style={{ maxHeight }}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: highlightJson は HTML エンティティをエスケープ済みの上で固定クラス名の <span> のみ追加するため安全
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
