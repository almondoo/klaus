/**
 * `.klaus/history/` の変化を監視し、購読者へ変更通知を配るハブ。
 * GET /api/history/events(SSE)が使う。通知に履歴の中身は含めず、連番と変更のあった日付だけを配る
 * (UI は通知を受けて認証付きの GET /api/history を取り直す)。
 *
 * - 購読者が 1 人以上いる間だけ監視する(0 人になったら fs.watch・タイマーを全て解放する)
 * - fs.watch はプラットフォームによって信頼できず、起動時にディレクトリが無いこともあるため、
 *   低頻度のポーリング(ファイルのサイズ・mtime 比較)を常に併用し、そこでディレクトリ作成後の watch 再接続も行う
 */
import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface HistoryChange {
  /** 単調増加する通知連番(ハブ生成時を 0 とし、変化の検知ごとに +1) */
  seq: number;
  /** 変化のあった履歴ファイルの日付(UTC, YYYY-MM-DD)。昇順 */
  dates: string[];
}

export interface HistorySubscriber {
  onChange: (change: HistoryChange) => void;
  /** ハブが閉じられたときに呼ばれる */
  onClose: () => void;
}

export interface HistoryWatcherOptions {
  /** 同時購読者数の上限。既定 16 */
  maxSubscribers?: number;
  /** fs.watch イベントのデバウンス(ms)。既定 100 */
  debounceMs?: number;
  /** フォールバックのポーリング間隔(ms)。既定 2000 */
  pollMs?: number;
}

export interface HistoryWatcher {
  /** 購読を開始する。上限超過なら undefined。返した関数で購読解除する。初回の基準スキャン完了後に resolve する */
  subscribe: (subscriber: HistorySubscriber) => Promise<(() => void) | undefined>;
  /** 全購読者へ onClose を通知して監視を止める */
  close: () => void;
}

const HISTORY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** 日付 → "size:mtimeMs" のスナップショットを取る。ディレクトリが無ければ空 */
async function scan(dir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return snapshot;
  }
  await Promise.all(
    names.map(async (name) => {
      const match = HISTORY_FILE.exec(name);
      if (!match) return;
      try {
        const s = await stat(join(dir, name));
        snapshot.set(match[1] as string, `${s.size}:${s.mtimeMs}`);
      } catch {
        // 走査中に消えたファイルは無視する
      }
    }),
  );
  return snapshot;
}

/** 前回との差分(追加・変更・削除された日付)を昇順で返す */
export function diffSnapshots(prev: Map<string, string>, next: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [date, sig] of next) if (prev.get(date) !== sig) changed.add(date);
  for (const date of prev.keys()) if (!next.has(date)) changed.add(date);
  return [...changed].sort();
}

export function createHistoryWatcher(
  cwd: string,
  options: HistoryWatcherOptions = {},
): HistoryWatcher {
  const { maxSubscribers = 16, debounceMs = 100, pollMs = 2000 } = options;
  const dir = join(cwd, ".klaus", "history");

  const subscribers = new Set<HistorySubscriber>();
  let seq = 0;
  let snapshot = new Map<string, string>();
  let watcher: FSWatcher | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let debounceTimer: NodeJS.Timeout | undefined;
  // 起動処理(基準スキャン)の完了待ち。2 人目以降の購読者も基準確定後に ready とする
  let starting: Promise<void> | undefined;
  let checking = false;
  let recheck = false;
  let closed = false;

  function attachWatch(): void {
    if (watcher) return;
    try {
      watcher = watch(dir, () => schedule());
      watcher.on("error", () => detachWatch());
    } catch {
      // ディレクトリが未作成など。次回のポーリングで再試行する
      watcher = undefined;
    }
  }

  function detachWatch(): void {
    watcher?.close();
    watcher = undefined;
  }

  function schedule(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void check();
    }, debounceMs);
  }

  async function check(): Promise<void> {
    // 走査中に再度呼ばれたら、終了後にもう一度だけ走査する(直列化)
    if (checking) {
      recheck = true;
      return;
    }
    checking = true;
    try {
      do {
        recheck = false;
        const next = await scan(dir);
        if (subscribers.size === 0) return;
        const dates = diffSnapshots(snapshot, next);
        snapshot = next;
        if (dates.length > 0) {
          seq += 1;
          const change = { seq, dates };
          for (const s of [...subscribers]) s.onChange(change);
        }
      } while (recheck);
    } finally {
      checking = false;
    }
  }

  function start(): Promise<void> {
    starting = (async () => {
      snapshot = await scan(dir);
      if (subscribers.size === 0 || closed) return;
      attachWatch();
      pollTimer = setInterval(() => {
        attachWatch();
        void check();
      }, pollMs);
      pollTimer.unref();
    })();
    return starting;
  }

  function stop(): void {
    detachWatch();
    if (pollTimer) clearInterval(pollTimer);
    if (debounceTimer) clearTimeout(debounceTimer);
    pollTimer = undefined;
    debounceTimer = undefined;
    starting = undefined;
  }

  return {
    async subscribe(subscriber) {
      if (closed || subscribers.size >= maxSubscribers) return undefined;
      subscribers.add(subscriber);
      await (starting ?? start());
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(subscriber);
        if (subscribers.size === 0) stop();
      };
    },
    close() {
      closed = true;
      const all = [...subscribers];
      subscribers.clear();
      stop();
      for (const s of all) s.onClose();
    },
  };
}
