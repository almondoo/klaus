/**
 * `klaus validate` サブコマンドの実装。
 * 実行・ネットワークアクセスは一切せず、フロー定義 YAML のスキーマ検証のみを行う。
 */
import { discoverFlowCandidates, type FlowIssue, validateFlowFile } from "../core/index.js";
import { toDisplayPath } from "./fs-utils.js";
import { isJsonOutputMode } from "./reporters/text.js";

/** validate コマンドのオプション(commander から渡される値を正規化した形) */
export interface ValidateCommandOptions {
  json?: boolean;
}

/** 1ファイル分の検証結果(JSON 出力の files[] の1要素と同じ形) */
export interface ValidateFileReport {
  path: string;
  valid: boolean;
  errors: FlowIssue[];
}

/** JSON モードの出力ペイロード。将来フィールドを変える場合は version を上げる */
export interface ValidateJsonReport {
  version: 1;
  files: ValidateFileReport[];
}

/**
 * 引数なし実行時のフロー探索。cwd 以下を再帰走査し、フロー候補 YAML(最上位に `steps` キーを持つもの)を
 * server(routes/flows.ts の listFlows)と同じ仕様で列挙する(除外ディレクトリ・候補判定は core/discovery.js を共有)。
 * 戻り値は絶対パス(ファイル読み込みに使う)。localeCompare で cwd 内の相対順に整列される。
 */
async function discoverFlowFiles(cwd: string): Promise<string[]> {
  const absolutePaths = await discoverFlowCandidates(cwd);
  absolutePaths.sort((a, b) => a.localeCompare(b));
  return absolutePaths;
}

/**
 * validate コマンド本体。
 * 引数ありは指定ファイルをそのまま検証し、引数なしは cwd 以下を探索して見つかったフロー候補を検証する。
 * 戻り値は exit code(全ファイル valid なら 0、1件でもエラーがあれば 2)。
 */
export async function validateCommand(
  files: string[],
  options: ValidateCommandOptions,
): Promise<number> {
  const cwd = process.cwd();
  // 引数ありの場合はユーザー指定のパスをそのまま表示に使う。引数なし(探索)の場合は
  // 探索で得た絶対パスを読み込みに使いつつ、表示は listFlows と同じく cwd 相対の POSIX パスにする
  const targets: Array<{ readPath: string; displayPath: string }> =
    files.length > 0
      ? files.map((file) => ({ readPath: file, displayPath: file }))
      : (await discoverFlowFiles(cwd)).map((absolutePath) => ({
          readPath: absolutePath,
          displayPath: toDisplayPath(cwd, absolutePath),
        }));

  // validateFlowFile は読み込み専用(共有の変更可能な状態を持たない)ため並列実行してよい。
  // Promise.all は入力順を保つので出力(表示順)は元のシーケンシャル実行と変わらない
  const reports: ValidateFileReport[] = await Promise.all(
    targets.map(async (target) => {
      const result = await validateFlowFile(target.readPath);
      return result.valid
        ? { path: target.displayPath, valid: true, errors: [] }
        : { path: target.displayPath, valid: false, errors: result.errors };
    }),
  );

  const useJson = isJsonOutputMode(options.json);
  if (useJson) {
    const report: ValidateJsonReport = { version: 1, files: reports };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    printText(reports);
  }

  const hasError = reports.some((report) => !report.valid);
  return hasError ? 2 : 0;
}

/** TTY 向けのテキスト出力: ファイルごとに OK/NG と、NG の場合はエラー一覧+ヒントを表示する */
function printText(reports: ValidateFileReport[]): void {
  for (const report of reports) {
    if (report.valid) {
      process.stdout.write(`OK   ${report.path}\n`);
      continue;
    }
    process.stdout.write(`NG   ${report.path}\n`);
    for (const error of report.errors) {
      const path = error.path || "(root)";
      const location = error.line !== undefined ? `${path} (line ${error.line})` : path;
      process.stdout.write(`  - ${location}: ${error.message}\n`);
      if (error.hint) {
        process.stdout.write(`    ${error.hint}\n`);
      }
    }
  }
}
