/**
 * タスクを 1 つずつ順番に実行する、プロセス内の直列キュー。
 * 送信・書き込みを伴うツール(フロー実行・単発リクエスト・promote・スナップショット承認)の呼び出しが
 * 並行して同じ履歴・スナップショットファイルに触れないよう、順序を保証するために使う。
 * 先行タスクの失敗は後続に影響しない(失敗は各呼び出し元にだけ返す)。
 */
export type SerialQueue = <T>(task: () => Promise<T>) => Promise<T>;

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    // 次のタスクは、このタスクが成功・失敗のどちらで終わっても続ける
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
