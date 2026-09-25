/**
 * src/cli 配下の複数コマンドで共有する小さなファイルシステム関連のユーティリティ。
 */
import { access } from "node:fs/promises";

/** 指定パスが存在するかどうかを bool で返す(権限エラー等も含め、アクセスできなければ false) */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
