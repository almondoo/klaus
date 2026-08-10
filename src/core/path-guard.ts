import { sep } from "node:path";

/**
 * candidate が dir 自身、または dir 配下(サブパス)であるかどうかを判定する。
 * dir との比較はセパレータ境界で行うため、"/foo/bar" が "/foo/barbaz" のような
 * 名前衝突で誤って dir 配下と判定されることはない。
 * env.ts(environments/ 配下の path traversal チェック)・loader.ts(use ステップの
 * cwd 境界チェック)で同一ロジックを共有する。dir・candidate はどちらも呼び出し元で
 * 解決済み(resolve 済み)のパスを渡すこと。
 */
export function isPathWithinDir(dir: string, candidate: string): boolean {
  const boundary = dir.endsWith(sep) ? dir : dir + sep;
  return candidate === dir || candidate.startsWith(boundary);
}
