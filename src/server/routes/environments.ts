/** GET /api/environments が使うロジック。environments/*.yaml の名前一覧を返す。 */
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { EnvironmentListEntry } from "../types.js";

const YAML_EXT = ".yaml";

/** environments/*.yaml の名前一覧を返す(ディレクトリが無ければ空配列) */
export async function listEnvironments(cwd: string): Promise<EnvironmentListEntry[]> {
  const dir = join(cwd, "environments");
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(YAML_EXT))
    .map((entry) => ({ name: entry.name.slice(0, -YAML_EXT.length) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
