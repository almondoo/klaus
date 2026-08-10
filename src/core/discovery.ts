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

/**
 * dir 以下を再帰走査し、YAML ファイル(拡張子 .yaml/.yml)の絶対パス一覧を返す。
 * サブディレクトリの再帰・各ファイルの判定は Promise.all で並行に行う
 * (Promise.all は入力順を保つため、返す配列は entries の並び順のまま平坦化される)。
 */
export async function collectYamlFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      if (entry.isDirectory()) {
        if (EXCLUDED_DISCOVERY_DIRS.has(entry.name)) return [];
        return collectYamlFiles(join(dir, entry.name));
      }
      if (entry.isFile()) {
        const dotIndex = entry.name.lastIndexOf(".");
        const ext = dotIndex === -1 ? "" : entry.name.slice(dotIndex);
        if (YAML_EXTENSIONS.has(ext)) return [join(dir, entry.name)];
      }
      return [];
    }),
  );
  return results.flat();
}

/** YAML パース結果がフロー候補(トップレベルに `steps` キーを持つ)かどうかを判定する */
export function isFlowCandidate(raw: unknown): boolean {
  return typeof raw === "object" && raw !== null && "steps" in raw;
}

/**
 * dir 以下のフロー候補 YAML(最上位に `steps` キーを持つもの)の絶対パス一覧を返す。
 * YAML 構文自体が壊れていて最上位のキーを判定できないファイル・読み込めないファイルは候補外として除外する。
 * 各ファイルの読み込み・パースは Promise.all で並行に行う(Promise.all は入力順を保つため、
 * 返す配列は files の並び順のまま候補外を取り除いたものになる)。
 */
export async function discoverFlowCandidates(dir: string): Promise<string[]> {
  const files = await collectYamlFiles(dir);

  const candidates = await Promise.all(
    files.map(async (filePath): Promise<string | undefined> => {
      let content: string;
      try {
        content = await readFile(filePath, "utf-8");
      } catch {
        return undefined;
      }

      let raw: unknown;
      try {
        raw = parseYaml(content);
      } catch {
        return undefined;
      }

      return isFlowCandidate(raw) ? filePath : undefined;
    }),
  );

  return candidates.filter((filePath): filePath is string => filePath !== undefined);
}
