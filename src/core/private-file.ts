/**
 * 平文の認証情報が残り得るファイル(実行履歴・カセット)を所有者限定権限で追記するヘルパー。
 */
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * filePath の親ディレクトリ(無ければ作成)配下の filePath へ line を1行として追記する。
 * 履歴・カセットには平文の認証情報が残り得るため、ディレクトリ・ファイルを所有者のみ読み書き可能な権限
 * (0o700 / 0o600)で作成する。既存の(緩い権限で作られた)ディレクトリ・ファイルについては、
 * 書き込み前に締め直す(書き込み後に締め直すと、緩い権限のまま新しい行が追記される瞬間が生じ、
 * 平文の認証情報が一時的に世界読み取り可能になり得るため)。ファイルが未作成の場合の
 * chmod(ENOENT)は無視し、appendFile の mode オプションによる新規作成時の 0o600 に委ねる
 * (POSIX のみ。Windows では no-op)。
 * line には末尾の改行を含めない(ここで "\n" を付与する)。
 */
export async function appendPrivateLine(filePath: string, line: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(dir, 0o700);
    try {
      await chmod(filePath, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await appendFile(filePath, `${line}\n`, { encoding: "utf-8", mode: 0o600 });
}
