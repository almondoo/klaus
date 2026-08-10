/**
 * src/cli 配下の複数コマンドで共有する小さなファイルシステム / パス関連のユーティリティ。
 */
import { access } from "node:fs/promises";
import { relative, sep } from "node:path";

/** 指定パスが存在するかどうかを bool で返す(権限エラー等も含め、アクセスできなければ false) */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 絶対パスを cwd 相対の POSIX 形式(/ 区切り)の表示用パスに変換する */
export function toDisplayPath(cwd: string, path: string): string {
  return relative(cwd, path).split(sep).join("/");
}
