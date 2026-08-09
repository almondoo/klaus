/**
 * レポーター共通の制御文字サニタイズ関数。
 * 外部(HTTP レスポンス本文等)由来の文字列は ANSI/C0/C1 制御シーケンスを含み得るため、
 * そのまま端末やレポートファイルへ出力すると出力の偽装(端末)や well-formedness 違反(XML)を招く。
 * 用途(端末向け / XML 向け)ごとに適切な可視エスケープへ変換するのがこのモジュールの責務。
 */

/** C0 制御文字・DEL・C1 制御文字をまとめて検出する正規表現(端末向け・XML 向け共通の対象範囲) */
// biome-ignore lint/suspicious/noControlCharactersInRegex: このモジュールの目的そのものが制御文字の検出・無害化のため意図的に含む
const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F\x80-\x9F]/g;

/** 1 文字を \xNN(16進2桁・大文字)形式の可視エスケープに変換する */
function toHexEscape(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  return `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`;
}

/**
 * 端末出力用のサニタイズ。C0/DEL/C1 の制御文字を全て可視エスケープに置き換える。
 * 改行(\n)・復帰(\r)・タブ(\t)も対象に含める: レスポンス本文に改行を仕込まれると
 * 偽の PASS 行を捏造できてしまうため、行構造の完全性を守る目的で可視化する。
 */
export function sanitizeForTerminal(text: string): string {
  return text.replace(CONTROL_CHAR_PATTERN, (char) => {
    if (char === "\n") return "\\n";
    if (char === "\r") return "\\r";
    if (char === "\t") return "\\t";
    return toHexEscape(char);
  });
}

/**
 * XML 出力用のサニタイズ。XML 1.0 が許容するタブ(\x09)・LF(\x0A)・CR(\x0D)はそのまま残し、
 * それ以外の C0/DEL/C1 制御文字を \xNN 形式の可視エスケープに置き換える。
 * 数値文字参照(&#x1B; 等)は使わない: C0 制御文字は XML 1.0 では数値文字参照でも不正なため。
 */
export function sanitizeForXml(text: string): string {
  return text.replace(CONTROL_CHAR_PATTERN, (char) => {
    if (char === "\t" || char === "\n" || char === "\r") return char;
    return toHexEscape(char);
  });
}
