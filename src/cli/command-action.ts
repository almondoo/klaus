/**
 * diff / promote コマンドの action を包み、予期しない例外を exit 1 に変換する薄いラッパー
 * (index.ts の runAction と同じ契約。index.ts を変更せずに各コマンドを自己完結させるため別に持つ)。
 */
export async function runCommandAction(fn: () => Promise<number>): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`klaus: unexpected error: ${message}\n`);
    process.exitCode = 1;
  }
}
