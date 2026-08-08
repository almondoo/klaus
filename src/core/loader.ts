import { readFile } from "node:fs/promises";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { ZodError } from "zod";
import { ParseError } from "./errors.js";
import { type Environment, environmentSchema, type Flow, flowSchema } from "./schema.js";

/** zod のエラーを人間可読な1行にまとめる */
function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** YAML の構文エラーをファイル名・位置付きのメッセージに整形して ParseError を投げる */
function toParseError(error: unknown, filePath?: string): ParseError {
  if (error instanceof YAMLParseError) {
    const pos = error.linePos?.[0];
    const location = pos ? ` (line ${pos.line}, column ${pos.col})` : "";
    return new ParseError(`YAML syntax error${location}: ${error.message}`, filePath);
  }
  if (error instanceof ZodError) {
    return new ParseError(`schema validation failed: ${formatZodError(error)}`, filePath);
  }
  if (error instanceof Error) {
    return new ParseError(error.message, filePath);
  }
  return new ParseError(String(error), filePath);
}

/** フロー定義 YAML の文字列を検証済みの Flow に変換する */
export function parseFlowYaml(content: string, filePath?: string): Flow {
  try {
    const raw: unknown = parseYaml(content);
    return flowSchema.parse(raw);
  } catch (error) {
    throw toParseError(error, filePath);
  }
}

/** 環境ファイル YAML の文字列を検証済みの Environment に変換する */
export function parseEnvironmentYaml(content: string, filePath?: string): Environment {
  try {
    const raw: unknown = parseYaml(content);
    return environmentSchema.parse(raw);
  } catch (error) {
    throw toParseError(error, filePath);
  }
}

/** フロー定義 YAML ファイルを読み込んで検証する */
export async function loadFlow(filePath: string): Promise<Flow> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new ParseError(
      `failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    );
  }
  return parseFlowYaml(content, filePath);
}

/** 環境ファイル YAML を読み込んで検証する */
export async function loadEnvironmentFile(filePath: string): Promise<Environment> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    throw new ParseError(
      `failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      filePath,
    );
  }
  return parseEnvironmentYaml(content, filePath);
}
