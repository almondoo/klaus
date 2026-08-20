/**
 * klaus.config.yaml(CLI オプションの既定値ファイル)の探索・読み込み・マージを行う。
 * - loadCliConfig: cwd から上方探索して klaus.config.yaml を読み込む(src/core/env.ts の
 *   resolveEnvironmentPath と同じ探索規則・信頼境界チェックを流用する)。
 * - applyConfigToRunOptions / applyConfigToUiOptions: commander から得たオプション値・
 *   オプション値の由来(source)・config を受け取り、「CLI 明示 > config > 組み込み既定」の
 *   優先順位でマージした結果を返す純関数。commander(Command インスタンス)には依存しない
 *   (呼び出し元の src/cli/index.ts が Command#getOptionValueSource から source を取り出して渡す)。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { ZodError } from "zod";
import {
  assertTrustedAncestorSource,
  type CliConfig,
  configSchema,
  formatZodError,
  ParseError,
} from "../core/index.js";
import type { RunCommandOptions } from "./run.js";
import type { UiCommandOptions } from "./ui.js";

const CONFIG_FILENAME = "klaus.config.yaml";

/**
 * cwd から上方探索で klaus.config.yaml を解決する。
 * 探索規則は resolveEnvironmentPath(src/core/env.ts)と同じ: 各ディレクトリ直下を確認し、
 * `.git` を含む祖先ディレクトリ(自身は調べて打ち切り)またはファイルシステムルートで終了する。
 * cwd より上の祖先で見つかった場合は assertTrustedAncestorSource で信頼境界を検証する
 * (cwd 自身はこの検査の対象外。利用者自身が選んだ作業ディレクトリのため)。
 * 見つからなければ undefined を返す(environments/<name>.yaml と異なり、klaus.config.yaml は
 * 任意ファイルなので「見つからない」場合のフォールバックパスは不要)。
 */
function resolveConfigPath(cwd: string): string | undefined {
  const startDir = resolve(cwd);
  let dir = startDir;

  while (true) {
    const candidatePath = join(dir, CONFIG_FILENAME);
    if (existsSync(candidatePath)) {
      if (dir !== startDir) {
        assertTrustedAncestorSource(dir, candidatePath);
      }
      return candidatePath;
    }
    if (existsSync(join(dir, ".git"))) {
      break;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return undefined;
}

/** YAML 構文エラー / zod スキーマ違反を、ファイルパス付きの ParseError に整形する(loader.ts の toParseError と同じ方針) */
function toConfigParseError(error: unknown, path: string): ParseError {
  if (error instanceof YAMLParseError) {
    const pos = error.linePos?.[0];
    const location = pos ? ` (line ${pos.line}, column ${pos.col})` : "";
    return new ParseError(`YAML syntax error${location}: ${error.message}`, path);
  }
  if (error instanceof ZodError) {
    return new ParseError(`schema validation failed: ${formatZodError(error)}`, path);
  }
  if (error instanceof Error) {
    return new ParseError(error.message, path);
  }
  return new ParseError(String(error), path);
}

/**
 * cwd から上方探索して klaus.config.yaml を読み込み、検証済みの CliConfig を返す。
 * 見つからなければ undefined を返す(エラーではない。config ファイルは任意)。
 * YAML 構文エラー・スキーマ違反(未知キー含む)はファイルパス付きの ParseError を投げる
 * (呼び出し元の src/cli/index.ts の action で捕捉し、環境ファイルと同じ exit code 2 で扱う)。
 */
export async function loadCliConfig(cwd: string): Promise<CliConfig | undefined> {
  const path = resolveConfigPath(cwd);
  if (path === undefined) {
    return undefined;
  }

  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (error) {
    throw new ParseError(
      `failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      path,
    );
  }

  try {
    const raw: unknown = parseYaml(content);
    return configSchema.parse(raw);
  } catch (error) {
    throw toConfigParseError(error, path);
  }
}

/**
 * commander の Command#getOptionValueSource が返す値の型(戻り値は string | undefined、
 * 代表的な値は "default" | "cli" | "env" | "implied" 等だが LiteralUnion のため他の文字列も
 * 型上許容される)。ここでは "cli"(利用者が明示的にそのオプションを指定した)かどうかだけを
 * 判定するため、commander の型定義には依存せず string | undefined として受け取る
 * (このモジュールを commander から独立させておくため)。
 */
export type CliOptionSource = string | undefined;

export interface RunOptionSources {
  env?: CliOptionSource;
  report?: CliOptionSource;
  reportFile?: CliOptionSource;
  history?: CliOptionSource;
  mask?: CliOptionSource;
}

/**
 * run コマンドのオプションに klaus.config.yaml の `run` 既定値を適用する。
 * 「CLI 明示(source === "cli") > config > 組み込み既定(options のまま)」の優先順位。
 * `--no-history` / `--no-mask` の負論理も source 判定で自然に扱える(未指定=default のときだけ
 * config の値で上書きし、明示指定(source "cli")なら常に CLI 側を優先する)。
 * `--allow-protected` / `--record` / `--replay` / `--json` / `--text` / `--var` / `--env-file` は対象外
 * (configSchema に定義がないため、options はそのまま素通りする。`--var` / `--env-file` は
 * その場限り・呼び出しごとの指定であることが本質のため、恒久的な既定値を持つ config には馴染まない)。
 * `run.env` の適用には例外がある: `--env-file` が明示指定されている場合、config の `run.env` は
 * 注入しない(config 由来の既定値はあくまで既定値であり、利用者が明示した `--env-file` に道を譲る。
 * ここで注入すると、-e/--env を一度も打っていないのに run.ts の「明示的な -e/--env と --env-file の
 * 同時指定はエラー」という契約に誤って抵触してしまう)。
 */
export function applyConfigToRunOptions(
  options: RunCommandOptions,
  sources: RunOptionSources,
  config: CliConfig | undefined,
): RunCommandOptions {
  const runConfig = config?.run;
  if (runConfig === undefined) {
    return options;
  }

  return {
    ...options,
    ...(runConfig.env !== undefined && sources.env !== "cli" && options.envFile === undefined
      ? { env: runConfig.env }
      : {}),
    ...(runConfig.report !== undefined && sources.report !== "cli"
      ? { report: runConfig.report }
      : {}),
    ...(runConfig.reportFile !== undefined && sources.reportFile !== "cli"
      ? { reportFile: runConfig.reportFile }
      : {}),
    ...(runConfig.history !== undefined && sources.history !== "cli"
      ? { history: runConfig.history }
      : {}),
    ...(runConfig.mask !== undefined && sources.mask !== "cli" ? { mask: runConfig.mask } : {}),
  };
}

export interface UiOptionSources {
  port?: CliOptionSource;
  host?: CliOptionSource;
  open?: CliOptionSource;
}

/**
 * ui コマンドのオプションに klaus.config.yaml の `ui` 既定値を適用する。
 * 優先順位・`--no-open` の負論理の扱いは applyConfigToRunOptions と同じ。
 */
export function applyConfigToUiOptions(
  options: UiCommandOptions,
  sources: UiOptionSources,
  config: CliConfig | undefined,
): UiCommandOptions {
  const uiConfig = config?.ui;
  if (uiConfig === undefined) {
    return options;
  }

  return {
    ...options,
    ...(uiConfig.port !== undefined && sources.port !== "cli" ? { port: uiConfig.port } : {}),
    ...(uiConfig.host !== undefined && sources.host !== "cli" ? { host: uiConfig.host } : {}),
    ...(uiConfig.open !== undefined && sources.open !== "cli" ? { open: uiConfig.open } : {}),
  };
}
