import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { AcceptSnapshotResult, SnapshotMismatch } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAcceptSnapshot, useSnapshotMismatches } from "@/hooks/useSnapshots";
import {
  describeAcceptState,
  groupMismatchesByFile,
  mismatchesForStep,
  mismatchId,
  SNAPSHOT_STATE_LABEL,
} from "@/utils/results";
import { DifferenceRows } from "./DiffParts";

export interface SnapshotReviewProps {
  /** 承認待ちを確認する run */
  runId: string;
  /** 他の画面(差分パネルのステップ操作)からフォーカスを移すための要素 id */
  id?: string;
}

/**
 * run の承認待ちスナップショット(不一致・基準なし)を確認し、人間が基準として承認するパネル。
 * 承認すると、その run で記録された応答がリポジトリ内のスナップショットファイルへ書き込まれる(ファイルが変わる)。
 * 履歴は追記のみで書き換わらないため、承認済みの項目も一覧には残る。承認したものはこの画面の状態として「承認済み」にする。
 * 承認待ちが無い・取得中の間は何も表示しない。
 */
export function SnapshotReview({ runId, id }: SnapshotReviewProps) {
  const { mismatches, acceptRefusal, loading, error } = useSnapshotMismatches(runId);
  const { accept, accepting } = useAcceptSnapshot(runId);
  const headingId = useId();
  const confirmRef = useRef<HTMLHeadingElement>(null);
  const [accepted, setAccepted] = useState<ReadonlyMap<string, AcceptSnapshotResult>>(new Map());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  const [confirmingAll, setConfirmingAll] = useState(false);

  // 別の run に切り替わったら、承認済みの記録は引き継がない
  // biome-ignore lint/correctness/useExhaustiveDependencies: runId が変わったときだけ初期化する
  useEffect(() => {
    setAccepted(new Map());
    setFailures(new Map());
    setConfirmingAll(false);
  }, [runId]);

  useEffect(() => {
    if (confirmingAll) confirmRef.current?.focus();
  }, [confirmingAll]);

  if (loading) {
    return <Skeleton role="status" aria-label="承認待ちを読み込み中" className="h-12 w-full" />;
  }
  if (error) return <p className="text-sm text-fail">{error}</p>;
  if (mismatches.length === 0) return null;

  const pending = mismatches.filter((item) => !accepted.has(mismatchId(item)));
  const blocked = acceptRefusal !== undefined;

  const acceptOne = async (item: SnapshotMismatch): Promise<boolean> => {
    const id = mismatchId(item);
    const outcome = await accept({
      runId: item.runId,
      snapshotFile: item.snapshotFile,
      key: item.key,
    });
    if ("result" in outcome) {
      setAccepted((current) => new Map(current).set(id, outcome.result));
      setFailures((current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      });
      return true;
    }
    setFailures((current) => new Map(current).set(id, outcome.error));
    return false;
  };

  const acceptAll = async () => {
    // 順に書き込む(同じファイルへの書き込みが競合しないように)。失敗した項目は残し、続きを試す
    for (const item of pending) await acceptOne(item);
    setConfirmingAll(false);
  };

  return (
    <section
      id={id}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border border-border bg-card p-3 outline-none"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={headingId} className="text-sm font-semibold">
          スナップショットの承認待ち({pending.length} 件
          {pending.length !== mismatches.length ? ` / 全 ${mismatches.length} 件` : ""})
        </h3>
        {pending.length > 0 && !confirmingAll && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={blocked || accepting}
            onClick={() => setConfirmingAll(true)}
          >
            すべて承認
          </Button>
        )}
      </div>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-skipped" />
        <span>
          承認すると、この run で記録された応答が基準として、リポジトリ内のスナップショットファイル(
          <code className="font-mono">__snapshots__/*.snap.json</code>
          )に書き込まれます。ファイルが変更されるので、承認後は git
          の差分を確認してコミットしてください。
        </span>
      </p>

      {blocked && (
        <p role="alert" className="flex items-start gap-2 text-xs text-fail">
          <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>この run は UI から承認できません: {acceptRefusal}</span>
        </p>
      )}

      {confirmingAll && (
        <section
          aria-labelledby={`${headingId}-confirm`}
          className="flex flex-col gap-2 rounded-md border border-skipped/40 bg-skipped/10 p-3"
        >
          <h4
            id={`${headingId}-confirm`}
            ref={confirmRef}
            tabIndex={-1}
            className="text-sm font-semibold outline-none"
          >
            次の {pending.length} 件を基準として書き込みます
          </h4>
          <p className="text-xs">
            リポジトリ内の次のファイルが書き換わります(既存のキーは置き換え、無いキーは追加されます)。
          </p>
          <ul className="flex flex-col gap-1.5 text-xs">
            {groupMismatchesByFile(pending).map((group) => (
              <li key={group.file}>
                <code className="font-mono font-semibold break-all">{group.file}</code>
                <ul className="mt-0.5 flex flex-col gap-0.5 pl-4">
                  {group.items.map((item) => (
                    <li key={mismatchId(item)} className="break-all">
                      <code className="font-mono">{item.key}</code>
                      <span className="text-muted-foreground">
                        {" "}
                        — {item.flow} / {item.step}({SNAPSHOT_STATE_LABEL[item.state]})
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={accepting} onClick={() => void acceptAll()}>
              {accepting ? "書き込み中…" : "書き込みを実行"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={accepting}
              onClick={() => setConfirmingAll(false)}
            >
              やめる
            </Button>
          </div>
        </section>
      )}

      <ul className="flex flex-col gap-3">
        {mismatches.map((item) => {
          const itemId = mismatchId(item);
          const done = accepted.get(itemId);
          const failure = failures.get(itemId);
          const label = `${item.flow} / ${item.step}${item.iteration !== undefined ? `(iteration ${item.iteration})` : ""}`;
          return (
            <li
              key={`${itemId}:${item.step}:${item.iteration ?? ""}`}
              className="flex flex-col gap-2 rounded-md border border-border bg-popover p-3"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <Badge variant={item.state === "mismatch" ? "fail" : "skipped"}>
                  {SNAPSHOT_STATE_LABEL[item.state]}
                </Badge>
                <span className="font-mono text-sm">{label}</span>
                <span className="text-muted-foreground">キー</span>
                <code className="font-mono break-all">{item.key}</code>
                <span className="text-muted-foreground">ファイル</span>
                <code className="font-mono break-all">{item.snapshotFile}</code>
              </div>
              <p className="text-xs text-muted-foreground">{item.message}</p>
              {item.differences.length > 0 && (
                <DifferenceRows
                  ignored={[]}
                  list={{
                    total: item.differenceCount,
                    omitted: Math.max(item.differenceCount - item.differences.length, 0),
                    differences: item.differences,
                  }}
                />
              )}
              {done ? (
                <p role="status" className="flex items-start gap-2 text-xs">
                  <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-pass" />
                  <span>
                    承認しました。<code className="font-mono">{done.snapshotFile}</code> に
                    {describeAcceptState(done.state)}
                    。変更されたファイルを確認してコミットしてください。
                  </span>
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    size="sm"
                    disabled={blocked || accepting}
                    aria-label={`${label} のキー ${item.key} を、この結果を基準として承認`}
                    onClick={() => void acceptOne(item)}
                  >
                    この結果を基準として承認
                  </Button>
                  {failure && (
                    <p role="alert" className="text-xs text-fail">
                      承認できませんでした: {failure}
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * 差分パネルのステップ見出しに置く操作。新しい方の run(B)のこのステップに承認待ちのスナップショットがあるときだけ、
 * 承認パネル(reviewId の要素)へ移動するボタンを出す。承認そのものは SnapshotReview で行う。
 */
export function SnapshotStepAction({
  runId,
  step,
  reviewId,
}: {
  runId: string;
  step: { flow: string; step: string; iteration?: number | undefined; change: string };
  reviewId: string;
}) {
  const { mismatches } = useSnapshotMismatches(runId, step.change !== "removed");
  const count = mismatchesForStep(mismatches, step).length;
  if (count === 0) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={() => {
        const target = document.getElementById(reviewId);
        target?.scrollIntoView?.({ block: "nearest" });
        target?.focus();
      }}
    >
      スナップショットの承認待ち {count} 件を確認
    </Button>
  );
}
