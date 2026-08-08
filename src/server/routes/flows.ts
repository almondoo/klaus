/**
 * GET /api/flows・GET /api/flows/detail が使う共通ロジック。
 * core を再利用してパース・検証を行うだけで、実行・アサーションロジックは持たない。
 */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { ParseError, parseFlowYaml } from "../../core/index.js";
import type { Step } from "../../core/schema.js";
import type { FlowListEntry } from "../types.js";

/** 再帰走査時に除外するディレクトリ名 */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".klaus",
  "ui",
  "environments",
  "tmp",
]);

const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);

/** cwd 以下を再帰走査し、YAML ファイル(拡張子 .yaml/.yml)の絶対パス一覧を返す */
async function collectYamlFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      files.push(...(await collectYamlFiles(join(dir, entry.name))));
      continue;
    }
    if (entry.isFile()) {
      const dotIndex = entry.name.lastIndexOf(".");
      const ext = dotIndex === -1 ? "" : entry.name.slice(dotIndex);
      if (YAML_EXTENSIONS.has(ext)) files.push(join(dir, entry.name));
    }
  }
  return files;
}

/** ParseError のメッセージから "filePath: " の重複プレフィックスを取り除く(path は別フィールドで返すため) */
function formatParseErrorReason(error: ParseError): string {
  if (error.filePath && error.message.startsWith(`${error.filePath}: `)) {
    return error.message.slice(error.filePath.length + 2);
  }
  return error.message;
}

/**
 * cwd 以下のフロー候補 YAML(最上位に `steps` キーを持つもの)を走査し、パース結果を一覧化する。
 * 成功時は name/stepCount、失敗時はパースエラー理由(error)を返す。
 * YAML 構文自体が壊れていて top-level のキーを判定できないファイルは、フロー候補として扱わずスキップする。
 */
export async function listFlows(cwd: string): Promise<FlowListEntry[]> {
  const files = await collectYamlFiles(cwd);
  const results: FlowListEntry[] = [];

  for (const filePath of files) {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    let raw: unknown;
    try {
      raw = parseYaml(content);
    } catch {
      // YAML 構文エラーで最上位のキーを判定できない場合は候補外とする
      continue;
    }

    const isCandidate = typeof raw === "object" && raw !== null && "steps" in raw;
    if (!isCandidate) continue;

    const relPath = relative(cwd, filePath).split(sep).join("/");
    try {
      // loadFlow と同じパース経路(parseFlowYaml)を使う。ファイルは既に読み込み済みなので再読込は避ける
      const flow = parseFlowYaml(content, filePath);
      results.push({ path: relPath, name: flow.name, stepCount: flow.steps.length });
    } catch (error) {
      const message = error instanceof ParseError ? formatParseErrorReason(error) : String(error);
      results.push({ path: relPath, error: message });
    }
  }

  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

/**
 * FlowDetail.steps の1件分を作る(UI 契約(ui/src/api/types.ts)は method/url を必須の string としているため、
 * ws ステップ(HTTP メソッドを持たない)・graphql ステップ(method 省略可)もここで文字列に丸める)。
 * - request ステップ: method はそのまま(graphql で省略された場合は実行時と同じ既定値 "POST" を補う)
 * - ws ステップ: method は固定文字列 "WS"、url は ws.url
 */
export function summarizeStep(step: Step): { name: string; method: string; url: string } {
  if (step.request) {
    return { name: step.name, method: step.request.method ?? "POST", url: step.request.url };
  }
  return { name: step.name, method: "WS", url: step.ws?.url ?? "" };
}

/**
 * 与えられた相対パスを cwd 基準で正規化解決する。
 * 解決結果が cwd の外を指す場合(path traversal・絶対パス注入)は null を返す。
 */
export function resolveWithinCwd(cwd: string, relPath: string): string | null {
  const resolvedPath = resolve(cwd, relPath);
  const boundary = cwd.endsWith(sep) ? cwd : cwd + sep;
  if (resolvedPath !== cwd && !resolvedPath.startsWith(boundary)) return null;
  return resolvedPath;
}
