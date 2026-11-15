/**
 * GET /api/history/events: 履歴ディレクトリの変化を SSE で通知する。
 * 通知に履歴の中身は含めない(連番と変更日付のみ)。UI は受信後に GET /api/history を取り直す。
 *
 * イベント:
 * - `ready`   購読開始直後に 1 回(監視の基準確定後)。data = {}
 * - `busy`    購読者数が上限のとき 1 回送って切断する。data = {}
 * - `history` 変化のたび。id = seq、data = {"seq": n, "dates": ["YYYY-MM-DD", ...]}
 * - コメント行 `: ping` を一定間隔で送り、アイドル接続が切られないようにする(同時に切断検知にもなる)
 */
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { HistoryWatcher } from "../history-watcher.js";

/** ハートビート間隔(ms) */
const HEARTBEAT_MS = 15_000;

export async function handleHistoryEvents(c: Context, watcher: HistoryWatcher): Promise<Response> {
  return streamSSE(c, async (stream) => {
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    stream.onAbort(finish);

    const unsubscribe = await watcher.subscribe({
      onChange: (change) => {
        stream
          .writeSSE({ event: "history", id: String(change.seq), data: JSON.stringify(change) })
          .catch(finish);
      },
      onClose: finish,
    });
    if (!unsubscribe) {
      // 上限超過・サーバー停止中。クライアントは再接続を待つ(バックオフ)
      await stream.writeSSE({ event: "busy", data: "{}" });
      return;
    }

    const heartbeat = setInterval(() => {
      stream.write(": ping\n\n").catch(finish);
    }, HEARTBEAT_MS);

    try {
      await stream.writeSSE({ event: "ready", data: "{}" });
      await finished;
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
}
