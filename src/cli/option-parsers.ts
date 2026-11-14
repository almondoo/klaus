/**
 * commander のオプション値パーサー(run / req で共有する)。
 * commander の _callParseArg は InvalidArgumentError のみ特別扱いして整形する
 * (それ以外の例外は素通しで re-throw され未捕捉スタックトレースになる)ため、不正値はすべてこれで拒否する。
 */
import { InvalidArgumentError } from "commander";
import { MAX_ACTOR_NAME_LENGTH } from "./audit.js";

/**
 * `key=value` を最初の "=" だけで分割する。区切りが無い・キーが空の場合は undefined。
 * 値側に "=" を含められるようにするため、最初の "=" だけを区切りとして扱う。
 */
function splitKeyValue(value: string): { key: string; value: string } | undefined {
  const separatorIndex = value.indexOf("=");
  // separatorIndex === -1(区切りの "=" が無い)、0(キーが空)のいずれも不正値として扱う
  if (separatorIndex <= 0) return undefined;
  return { key: value.slice(0, separatorIndex), value: value.slice(separatorIndex + 1) };
}

/** --var <key=value> の累積パーサー(Record<string,string> に集約する) */
export function collectVarOption(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const pair = splitKeyValue(value);
  if (!pair) {
    throw new InvalidArgumentError(`invalid --var value (expected key=value): ${value}`);
  }
  return { ...previous, [pair.key]: pair.value };
}

/** --query <k=v> の累積パーサー。同名キーを複数回指定した場合は後勝ち(request.query は Record のため) */
export function collectQueryOption(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const pair = splitKeyValue(value);
  if (!pair) {
    throw new InvalidArgumentError(`invalid --query value (expected key=value): ${value}`);
  }
  return { ...previous, [pair.key]: pair.value };
}

/** RFC 9110 の token(ヘッダー名・HTTP メソッドに使える文字) */
const TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * -H, --header <name:value> の累積パーサー。最初の ":" で分割し、名前は token 文字のみ、
 * 値は前後の空白を除去する(CR/LF を含む値はヘッダー注入になり得るため拒否する)。
 * 同名ヘッダー(大文字小文字を区別しない)を複数回指定した場合は後勝ちにする(request.headers は Record のため)。
 */
export function collectHeaderOption(
  value: string,
  previous: Record<string, string>,
): Record<string, string> {
  const separatorIndex = value.indexOf(":");
  const name = separatorIndex > 0 ? value.slice(0, separatorIndex).trim() : "";
  const headerValue = separatorIndex > 0 ? value.slice(separatorIndex + 1).trim() : "";
  if (!TOKEN_PATTERN.test(name) || /[\r\n]/.test(headerValue)) {
    throw new InvalidArgumentError(`invalid --header value (expected name:value): ${value}`);
  }
  const lowerName = name.toLowerCase();
  const kept = Object.entries(previous).filter(([key]) => key.toLowerCase() !== lowerName);
  return { ...Object.fromEntries(kept), [name]: headerValue };
}

/** req の <method> 引数のパーサー。token 文字のみ許可する(大文字化は requestSchema が行う) */
export function parseMethodArgument(value: string): string {
  if (!TOKEN_PATTERN.test(value)) {
    throw new InvalidArgumentError(`invalid HTTP method: ${value}`);
  }
  return value;
}

/** --actor <name> のパーサー。1 以上 MAX_ACTOR_NAME_LENGTH 以下の文字列(前後の空白は除去) */
export function parseActorOption(value: string): string {
  const name = value.trim();
  if (name === "" || name.length > MAX_ACTOR_NAME_LENGTH) {
    throw new InvalidArgumentError(
      `invalid --actor value (expected 1-${MAX_ACTOR_NAME_LENGTH} characters): ${value}`,
    );
  }
  return name;
}

/** --timeout <ms> のパーサー。正の整数(ミリ秒) */
export function parseTimeoutOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError(
      `invalid --timeout value (expected a positive integer): ${value}`,
    );
  }
  return parsed;
}
