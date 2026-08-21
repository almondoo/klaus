import { realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

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

/** error が ENOENT(対象が存在しない)かどうかを判定する */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * path のシンボリックリンクを解決した実パスを返す。path 自体が存在しない場合は、
 * 実在する直近の祖先ディレクトリまで遡って realpath を解決し、そこから先の
 * (まだ存在しない)残りのセグメントをそのまま連結して返す。saveEnvironment のような
 * 「これから作成されるファイル」の境界チェックでも使えるようにするための挙動で、
 * 未解決のまま失敗扱いにはしない。
 * realpathSync が ENOENT 以外のエラー(パーミッション不足等)を投げた場合は解決不能とみなし
 * undefined を返す(呼び出し元は fail closed で拒否すること)。
 */
function resolveRealPathAllowingMissing(path: string): string | undefined {
  const missingSegments: string[] = [];
  let current = path;

  while (true) {
    try {
      const real = realpathSync(current);
      return missingSegments.length > 0 ? join(real, ...missingSegments.reverse()) : real;
    } catch (error) {
      if (!isEnoent(error)) return undefined;

      const parent = dirname(current);
      if (parent === current) {
        // ルート直下まで遡っても解決できない状況は通常発生しないが、
        // フェイルセーフとして「解決不能」= 拒否側に倒す
        return undefined;
      }
      missingSegments.push(basename(current));
      current = parent;
    }
  }
}

/**
 * candidate が dir 配下であるかを、双方のシンボリックリンクを解決した実パスで判定する。
 * isPathWithinDir は文字列比較のみのため、境界(dir)内に置かれたシンボリックリンクが
 * 境界外の実体を指していても検知できない(例: environments/ 配下に他ユーザーが仕込んだ
 * `prod.yaml -> /etc/secrets` のようなリンク)。SECURITY.md が明示する「共有ホスト上の
 * 悪意あるファイル」からの読み取りを防ぐため、既存の isPathWithinDir と併用すること。
 * - dir 自身は /tmp -> /private/tmp のようにシンボリックリンク経由で正当に到達しうるため、
 *   実在すれば realpath を、実在しなければ(境界ディレクトリがまだ無い等)非解決の絶対パスを
 *   そのまま境界として使う。
 * - candidate が実在しない場合(例: saveEnvironment が書き込む前の新規ファイル)は、
 *   実在する直近の祖先まで realpath を解決し、残りのセグメントを連結する。
 * - realpathSync が ENOENT 以外のエラーを返した場合は解決不能とみなし false(拒否)を返す。
 * dir・candidate はどちらも呼び出し元で解決済み(resolve 済み)の絶対パスを渡すこと。
 */
export function isRealPathWithinDir(dir: string, candidate: string): boolean {
  let realDir: string;
  try {
    realDir = realpathSync(dir);
  } catch (error) {
    if (!isEnoent(error)) return false;
    realDir = dir;
  }

  const realCandidate = resolveRealPathAllowingMissing(candidate);
  if (realCandidate === undefined) return false;

  return isPathWithinDir(realDir, realCandidate);
}
