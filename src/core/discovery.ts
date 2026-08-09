/**
 * フロー定義 YAML の探索ロジック。
 * server(routes/flows.ts の listFlows)と CLI(cli/validate.ts の引数なし探索)の双方から
 * 同じ仕様で使われる共通部分だけをここに切り出す(ファイルの意味づけ・エラーの扱いは呼び出し側の責務)。
 */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** 再帰走査時に除外するディレクトリ名 */
export const EXCLUDED_DISCOVERY_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".klaus",
  "ui",
  "environments",
  "tmp",
]);

const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);

/** dir 以下を再帰走査し、YAML ファイル(拡張子 .yaml/.yml)の絶対パス一覧を返す */
export async function collectYamlFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DISCOVERY_DIRS.has(entry.name)) continue;
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

/** YAML パース結果がフロー候補(トップレベルに `steps` キーを持つ)かどうかを判定する */
export function isFlowCandidate(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && "steps" in raw;
}

/**
 * dir 以下のフロー候補 YAML(最上位に `steps` キーを持つもの)の絶対パス一覧を返す。
 * YAML 構文自体が壊れていて最上位のキーを判定できないファイル・読み込めないファイルは候補外として除外する。
 */
export async function discoverFlowCandidates(dir: string): Promise<string[]> {
  const files = await collectYamlFiles(dir);
  const candidates: string[] = [];

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
      continue;
    }

    if (isFlowCandidate(raw)) candidates.push(filePath);
  }

  return candidates;
}
