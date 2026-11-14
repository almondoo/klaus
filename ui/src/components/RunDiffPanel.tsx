import { ChevronDown, ChevronRight, Diff, Equal, Minus, Plus, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RunDiff, RunSummary, StepDiff } from "@/api/types";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useHistoryDiff } from "@/hooks/useHistoryDiff";
import { cn } from "@/lib/utils";
import { formatDateTime, formatDuration } from "@/utils/format";
import { formatActor } from "@/utils/historyEvents";
import {
  describeCounts,
  normalizeIgnoreInput,
  requestChangeCount,
  responseChangeCount,
  STEP_CHANGE_LABEL,
  suggestIgnorePaths,
  summarizeStep,
  withOccurrenceKeys,
} from "@/utils/runDiff";
import { BeforeAfter, BodyDiffView, DifferenceRows, HeaderDiffView } from "./DiffParts";
import { Spinner } from "./Spinner";
import { StatusBadge } from "./StatusBadge";

/**
 * ステップごとの操作ボタンを差し込むための文脈。
 * 将来「スナップショットを承認」のようなステップ単位の操作をここに追加できるよう、
 * 比較結果全体(どの run のどのステップか)を渡す。
 */
export interface StepActionContext {
  step: StepDiff;
  diff: RunDiff;
  /** この比較に使った run ID(A: 前 / B: 後) */
  runIds: { a: string; b: string };
}

export interface RunDiffPanelProps {
  /** 比較する run(a: 古い方 / b: 新しい方) */
  a: string;
  b: string;
  /** 指定時は、そのフローのステップだけを比較する */
  flow?: string | undefined;
  onClose: () => void;
  /** ステップ見出しの右側に置く操作(省略可。スナップショット承認などの追加先) */
  renderStepActions?: ((context: StepActionContext) => ReactNode) | undefined;
}

const CHANGE_VARIANT: Record<StepDiff["change"], NonNullable<BadgeProps["variant"]>> = {
  same: "pending",
  different: "skipped",
  added: "pass",
  removed: "fail",
};

/** 色 + アイコン + テキストの 3 重表現でステップの比較結果を示す */
function ChangeBadge({ change }: { change: StepDiff["change"] }) {
  const Icon =
    change === "same" ? Equal : change === "added" ? Plus : change === "removed" ? Minus : Diff;
  return (
    <Badge variant={CHANGE_VARIANT[change]}>
      <Icon aria-hidden="true" />
      <span>{STEP_CHANGE_LABEL[change]}</span>
    </Badge>
  );
}

function RunSummaryCard({ label, run }: { label: string; run: RunSummary }) {
  const actor = formatActor(run.actor);
  return (
    <div className="min-w-0 flex-1 rounded-md border border-border bg-card p-3 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-semibold">{label}</span>
        <StatusBadge status={run.status} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted-foreground">run</dt>
        <dd className="font-mono break-all">{run.runId}</dd>
        <dt className="text-muted-foreground">開始</dt>
        <dd className="font-mono">{formatDateTime(run.startedAt)}</dd>
        <dt className="text-muted-foreground">フロー</dt>
        <dd className="font-mono break-all">{run.flows.join(", ")}</dd>
        <dt className="text-muted-foreground">ステップ数</dt>
        <dd className="font-mono">{run.steps}</dd>
        {run.env && (
          <>
            <dt className="text-muted-foreground">環境</dt>
            <dd className="font-mono">{run.env}</dd>
          </>
        )}
        {actor && (
          <>
            <dt className="text-muted-foreground">実行者</dt>
            <dd className="font-mono">{actor}</dd>
          </>
        )}
        {run.git && (
          <>
            <dt className="text-muted-foreground">git</dt>
            <dd className="font-mono">
              {run.git.commit.slice(0, 7)}
              {run.git.dirty ? "+dirty" : ""}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="text-xs font-semibold text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

function StatusLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function StepDetails({
  step,
  ignored,
  onIgnore,
}: {
  step: StepDiff;
  ignored: readonly string[];
  onIgnore: (pattern: string) => void;
}) {
  const hasStatus = step.status || step.httpStatus || step.error || step.durationMs;
  const requestCount = requestChangeCount(step);
  const responseCount = responseChangeCount(step);
  return (
    <div className="flex flex-col gap-4 border-t border-border px-3 py-3">
      {step.change === "added" && (
        <p className="text-xs text-muted-foreground">このステップは B(新しい方)にだけあります</p>
      )}
      {step.change === "removed" && (
        <p className="text-xs text-muted-foreground">このステップは A(古い方)にだけあります</p>
      )}

      {hasStatus && (
        <Section title="結果">
          {step.status && (
            <StatusLine label="状態">
              <BeforeAfter
                before={step.status.a}
                after={step.status.b}
                hasBefore={step.status.a !== undefined}
                hasAfter={step.status.b !== undefined}
              />
            </StatusLine>
          )}
          {step.httpStatus && (
            <StatusLine label="HTTP ステータス">
              <BeforeAfter
                before={step.httpStatus.a}
                after={step.httpStatus.b}
                hasBefore={step.httpStatus.a !== undefined}
                hasAfter={step.httpStatus.b !== undefined}
              />
            </StatusLine>
          )}
          {step.error && (
            <StatusLine label="エラー">
              <BeforeAfter
                before={step.error.a}
                after={step.error.b}
                hasBefore={step.error.a !== undefined}
                hasAfter={step.error.b !== undefined}
              />
            </StatusLine>
          )}
          {step.durationMs && (
            <StatusLine label="所要時間">
              <span className="font-mono">
                {formatDuration(step.durationMs.a)} → {formatDuration(step.durationMs.b)}
              </span>
            </StatusLine>
          )}
        </Section>
      )}

      {requestCount > 0 && step.request && (
        <Section title="リクエストの変更">
          {step.request.method && (
            <StatusLine label="メソッド">
              <BeforeAfter before={step.request.method.a} after={step.request.method.b} />
            </StatusLine>
          )}
          {step.request.url && (
            <StatusLine label="URL">
              <BeforeAfter before={step.request.url.a} after={step.request.url.b} />
            </StatusLine>
          )}
          {step.request.body && (
            <BodyDiffView body={step.request.body} ignored={ignored} onIgnore={onIgnore} />
          )}
        </Section>
      )}

      {responseCount > 0 && (
        <Section title="レスポンスの変更">
          {step.responseHeaders && <HeaderDiffView headers={step.responseHeaders} />}
          {step.body && <BodyDiffView body={step.body} ignored={ignored} onIgnore={onIgnore} />}
          {step.events && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">SSE イベント</span>
              <DifferenceRows list={step.events} ignored={ignored} onIgnore={onIgnore} />
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

function StepCard({
  step,
  diff,
  runIds,
  ignored,
  onIgnore,
  renderStepActions,
}: {
  step: StepDiff;
  diff: RunDiff;
  runIds: { a: string; b: string };
  ignored: readonly string[];
  onIgnore: (pattern: string) => void;
  renderStepActions: RunDiffPanelProps["renderStepActions"];
}) {
  const detailId = useId();
  // 差分のあるステップは最初から開く。「同じ」は中身が無いので開閉しない
  const expandable = step.change !== "same";
  const [open, setOpen] = useState(expandable);
  const summary = summarizeStep(step);
  const title = (
    <>
      <ChangeBadge change={step.change} />
      <span className="font-mono text-sm">{step.step}</span>
      {step.iteration !== undefined && (
        <span className="text-xs text-muted-foreground">(iteration {step.iteration})</span>
      )}
      {summary.length > 0 && (
        <span className="min-w-0 text-xs text-muted-foreground">{summary.join(" / ")}</span>
      )}
    </>
  );
  const actions = renderStepActions?.({ step, diff, runIds });
  return (
    <li className={cn("rounded-md border border-border", expandable ? "bg-card" : "bg-muted/40")}>
      <div className="flex items-center gap-2 px-3 py-2">
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-sm text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {open ? (
              <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
            )}
            {title}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 pl-6">
            {title}
          </div>
        )}
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {expandable && open && (
        <div id={detailId}>
          <StepDetails step={step} ignored={ignored} onIgnore={onIgnore} />
        </div>
      )}
    </li>
  );
}

/** 除外パスの追加・解除と、差分から作った除外候補の UI */
function IgnorePaths({
  ignored,
  suggestions,
  onAdd,
  onRemove,
}: {
  ignored: readonly string[];
  suggestions: ReturnType<typeof suggestIgnorePaths>;
  onAdd: (pattern: string) => void;
  onRemove: (pattern: string) => void;
}) {
  const [input, setInput] = useState("");
  const inputId = useId();
  const normalized = normalizeIgnoreInput(input, ignored);
  const submit = () => {
    if (normalized === null) return;
    onAdd(normalized);
    setInput("");
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <h3 className="text-xs font-semibold">比較から除外するパス</h3>
      <p className="text-xs text-muted-foreground">
        id や時刻のように実行ごとに変わる値を除くと、意味のある差分だけが残ります(body・リクエスト
        body・SSE イベントに効きます)。
      </p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          除外する JSONPath
        </label>
        <Input
          id={inputId}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="$.items[*].createdAt や $..updatedAt"
          className="h-9 max-w-sm font-mono text-xs"
        />
        <Button type="submit" variant="secondary" size="sm" disabled={normalized === null}>
          除外に追加
        </Button>
      </form>

      {ignored.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="除外中のパス">
          {ignored.map((pattern) => (
            <li key={pattern}>
              <button
                type="button"
                onClick={() => onRemove(pattern)}
                aria-label={`${pattern} を除外から外す`}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 py-1 font-mono text-xs outline-none hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {pattern}
                <X aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {suggestions.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">
            差分に現れたパス(クリックで除外に追加)
          </span>
          <ul className="flex flex-wrap gap-2">
            {suggestions.map((suggestion) => (
              <li key={suggestion.pattern}>
                <button
                  type="button"
                  onClick={() => onAdd(suggestion.pattern)}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 font-mono text-xs outline-none hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <Plus aria-hidden="true" className="size-3" />
                  <span>{suggestion.pattern}</span>
                  {suggestion.count > 1 && (
                    <span className="text-muted-foreground">×{suggestion.count}</span>
                  )}
                  {suggestion.volatile && (
                    <span className="rounded-sm bg-skipped/12 px-1 font-sans text-skipped">
                      変わりやすい値
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * 2 つの run の差分パネル(履歴タブの比較ビュー)。
 * ステップごとに「同じ / 差分あり / 追加 / 削除」と、結果(状態・HTTP ステータス)・リクエスト・レスポンスの差分を示す。
 * 除外パスを変えると再取得する。値は履歴に保存済みのマスク済みのもの(アンマスクはしない)。
 */
export function RunDiffPanel({ a, b, flow, onClose, renderStepActions }: RunDiffPanelProps) {
  const [ignored, setIgnored] = useState<string[]>([]);
  const { diff, loading, refetching, error } = useHistoryDiff({
    a,
    b,
    ...(flow !== undefined ? { flow } : {}),
    ignorePaths: ignored,
  });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();

  // 比較を開いたら見出しへフォーカスを移し、画面内に入れる(キーボード・スクリーンリーダー利用者向け)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a / b が変わった(別の比較を開いた)ときだけ移す
  useEffect(() => {
    headingRef.current?.focus();
    headingRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [a, b]);

  const suggestions = useMemo(
    () => (diff ? suggestIgnorePaths(diff.steps, ignored) : []),
    [diff, ignored],
  );
  const runIds = { a, b };

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border border-border bg-popover p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-semibold outline-none"
        >
          実行の比較(A: 古い方 → B: 新しい方)
        </h2>
        <div className="flex items-center gap-2">
          {refetching && <Spinner label="差分を再取得中" />}
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            <X aria-hidden="true" className="size-4" />
            比較を閉じる
          </Button>
        </div>
      </div>

      {loading && (
        <div role="status" aria-label="差分を読み込み中" className="flex flex-col gap-1.5">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-fail">
          {error}
        </p>
      )}

      {diff && (
        <>
          <div className="flex flex-col gap-3 sm:flex-row">
            <RunSummaryCard label="A(古い方)" run={diff.runs.a} />
            <RunSummaryCard label="B(新しい方)" run={diff.runs.b} />
          </div>

          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <Badge variant={diff.status === "same" ? "pass" : "skipped"}>
              {diff.status === "same" ? <Equal aria-hidden="true" /> : <Diff aria-hidden="true" />}
              <span>{diff.status === "same" ? "差分なし" : "差分あり"}</span>
            </Badge>
            <span className="text-xs text-muted-foreground">{describeCounts(diff.counts)}</span>
          </p>

          <IgnorePaths
            ignored={ignored}
            suggestions={suggestions}
            onAdd={(pattern) => setIgnored((current) => [...current, pattern])}
            onRemove={(pattern) => setIgnored((current) => current.filter((p) => p !== pattern))}
          />

          <ul className="flex flex-col gap-2" aria-label="ステップごとの比較結果">
            {withOccurrenceKeys(
              diff.steps,
              (step) => `${step.flow}:${step.step}:${step.iteration ?? ""}`,
            ).map(({ key, item: step }) => (
              <StepCard
                key={key}
                step={step}
                diff={diff}
                runIds={runIds}
                ignored={ignored}
                onIgnore={(pattern) =>
                  setIgnored((current) =>
                    current.includes(pattern) ? current : [...current, pattern],
                  )
                }
                renderStepActions={renderStepActions}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
