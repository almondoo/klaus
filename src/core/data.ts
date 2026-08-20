/**
 * データ駆動実行(`klaus run --data`)向けのデータファイルローダー。
 *
 * 設計判断: 対応フォーマットは JSON / YAML のみで、CSV には非対応とする。新規依存も追加しない
 * (JSON はネイティブ JSON.parse、YAML は既存依存の `yaml` パッケージのみで完結するため)。
 * CSV 対応の要望が将来出た場合は、この判断(依存追加なし・スカラー値限定という契約との相性)を
 * 踏まえたうえで改めて検討すること。
 *
 * 読み込んだ行(DataRow)は runner.ts(runLoadedFlows)がテンプレートの env 名前空間へ注入する
 * (number/boolean は String() で文字列化、null のキーは注入しない)。このモジュール自体は
 * テンプレートロジックを一切持たない。
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { ZodError, z } from "zod";
import { ParseError } from "./errors.js";
import { formatZodError } from "./loader.js";

/** データファイル1行分。値はスカラー(string | number | boolean | null)のみ */
export type DataRow = Record<string, string | number | boolean | null>;

/** DataRow のスカラー値制約(ネストしたオブジェクト・配列は許容しない) */
const dataRowSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

/** データファイル全体: オブジェクトの配列。空配列は不正(実行対象の行が無いため) */
const dataFileSchema = z.array(dataRowSchema).min(1, "data file has no rows");

/** サポートする拡張子(小文字で判定) */
const SUPPORTED_EXTENSIONS = [".json", ".yaml", ".yml"];

/**
 * パース・検証系の例外をファイルパス付きの ParseError に整形する。
 * loader.ts の toParseError と同じ方針(YAML 構文エラー・zod エラーをそれぞれ人間可読な
 * 1行にまとめる)を踏襲しつつ、JSON.parse が投げる SyntaxError も同様に扱う。
 */
function toParseError(error: unknown, filePath: string): ParseError {
  if (error instanceof YAMLParseError) {
    const pos = error.linePos?.[0];
    const location = pos ? ` (line ${pos.line}, column ${pos.col})` : "";
    return new ParseError(`YAML syntax error${location}: ${error.message}`, filePath);
  }
  if (error instanceof ZodError) {
    return new ParseError(`schema validation failed: ${formatZodError(error)}`, filePath);
  }
  if (error instanceof SyntaxError) {
    return new ParseError(`JSON syntax error: ${error.message}`, filePath);
  }
  if (error instanceof Error) {
    return new ParseError(error.message, filePath);
  }
  return new ParseError(String(error), filePath);
}

/**
 * データファイル(.json / .yaml / .yml)を読み込み、検証済みの DataRow[] を返す。
 * ドキュメントはオブジェクトの配列でなければならず、各値はスカラーのみ許容する
 * (ネストしたオブジェクト・配列は検証エラーになる)。
 */
export async function loadDataFile(filePath: string): Promise<DataRow[]> {
  const ext = extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new ParseError(
      `unsupported data file extension "${ext || "(none)"}" (supported: ${SUPPORTED_EXTENSIONS.join(", ")})`,
      filePath,
    );
  }

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new ParseError(
      `failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    );
  }

  try {
    const raw: unknown = ext === ".json" ? JSON.parse(content) : parseYaml(content);
    return dataFileSchema.parse(raw);
  } catch (error) {
    throw toParseError(error, filePath);
  }
}
