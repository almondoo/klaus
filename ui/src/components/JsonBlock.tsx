import { useMemo } from "react";
import "./JsonBlock.css";

const TOKEN_PATTERN =
  /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;

/** JSON 文字列を軽量にトークン化して HTML(エスケープ済み)を返す。依存追加なしの自前実装 */
function highlightJson(json: string): string {
  const escaped = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return escaped.replace(TOKEN_PATTERN, (match) => {
    let className = "klaus-json__number";
    if (match.startsWith('"')) {
      className = match.endsWith(":") ? "klaus-json__key" : "klaus-json__string";
    } else if (match === "true" || match === "false") {
      className = "klaus-json__boolean";
    } else if (match === "null") {
      className = "klaus-json__null";
    }
    return `<span class="${className}">${match}</span>`;
  });
}

export interface JsonBlockProps {
  value: unknown;
  maxHeight?: number;
}

/** リクエスト/レスポンス JSON の表示用。内部スクロールのみ許可し、ページ全体には横スクロールを出さない */
export function JsonBlock({ value, maxHeight = 320 }: JsonBlockProps) {
  const html = useMemo(() => {
    const json = value === undefined ? "undefined" : JSON.stringify(value, null, 2);
    return highlightJson(json ?? "null");
  }, [value]);

  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: highlightJson は HTML エンティティをエスケープ済みの上で固定クラス名の <span> のみ追加するため安全
    <pre className="klaus-json" style={{ maxHeight }} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
