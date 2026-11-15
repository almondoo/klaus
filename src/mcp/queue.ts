/**
 * タスクを 1 つずつ順番に実行する、プロセス内の直列キュー。
 * 送信・書き込みを伴うツール(フロー実行・単発リクエスト・promote・スナップショット承認)の呼び出しが
 * 並行して同じ履歴・スナップショットファイルに触れないよう、順序を保証するために使う。
 * 先行タスクの失敗は後続に影響しない(失敗は各呼び出し元にだけ返す)。
 *
 * close() 以降は、まだ開始していないタスクを実行せずに QueueClosedError で拒否する(終了処理の一部。
 * 接続が閉じた後に、待たされていた送信が新たに始まらないようにする)。実行中のタスクは中断も待機もしない。
 */
export interface SerialQueue {
  <T>(task: () => Promise<T>): Promise<T>;
  /** 以降に開始するタスクを拒否する。すでに実行中のタスクには影響しない(冪等) */
  close(): void;
}

/** キューが閉じられた後に、開始前のタスクが拒否されるときのエラー */
export class QueueClosedError extends Error {
  constructor() {
    super("klaus mcp is shutting down; the call was not started");
    this.name = "QueueClosedError";
  }
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    // 開始する時点で閉じていれば実行しない(待たされている間に閉じられた場合も含む)
    const guarded = async (): Promise<T> => {
      if (closed) throw new QueueClosedError();
      return task();
    };
    // tail は常に成功・失敗のどちらで終わっても解決するため、先行タスクの失敗は後続に影響しない
    const run = tail.then(guarded);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return Object.assign(enqueue, {
    close: () => {
      closed = true;
    },
  });
}
