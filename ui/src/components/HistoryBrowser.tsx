import { Fragment, useMemo, useState } from "react";
import type { FlowListEntry } from "@/api/client";
import { LabeledSelect } from "@/components/LabeledSelect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SelectItem } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useHistory } from "@/hooks/useHistory";
import { cn } from "@/lib/utils";
import { errorCodeOf, explainError } from "@/utils/errorExplain";
import { formatDateTime, formatDuration } from "@/utils/format";
import { groupHistoryByRun, type HistoryRunGroup, resolveStepStatus } from "@/utils/history";
import { formatActor, pickAudit } from "@/utils/historyEvents";
import { hasPendingSnapshot } from "@/utils/results";
import { commonFlow, findPreviousRun, isSingleGroup, orderRunPair } from "@/utils/runDiff";
import { ErrorExplanation } from "./ErrorExplanation";
import { JsonBlock } from "./JsonBlock";
import { PromoteDialog } from "./PromoteDialog";
import { AssertionList, RedirectNotes } from "./ResultDetails";
import { RunDiffPanel } from "./RunDiffPanel";
import { SnapshotReview, SnapshotStepAction } from "./SnapshotReview";
import { Spinner } from "./Spinner";
import { StatusBadge } from "./StatusBadge";

export interface HistoryBrowserProps {
  flows: FlowListEntry[];
}

// Radix Select の Item value には空文字列を使えない(未選択状態を表す予約値のため)ので、
// 「すべて」を表す番兵値を用意し、実際のフィルタ値("" = 絞り込みなし)とマッピングする
const ALL_FLOWS = "__all__";

// 初回読み込み中に表示するスケルトン行の数(固定長の文字列配列を key に使う。理由は Sidebar.tsx 参照)
const SKELETON_ROWS = ["row-1", "row-2", "row-3", "row-4", "row-5"];

/**
 * <tr> はテーブル構造上 <button> にできないため、tabIndex + onKeyDown + aria-expanded で
 * キーボード操作可能な行開閉トグルとして振る舞わせるための共通 props を返す。
 */
function rowToggleProps(expanded: boolean, toggle: () => void) {
  return {
    tabIndex: 0,
    "aria-expanded": expanded,
    onClick: toggle,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    },
  };
}

/** 行内のボタン操作が、行の開閉トグル(クリック・Enter / Space)まで伝わらないようにする共通 props */
const stopRowToggle = {
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
  onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
};

/**
 * 狭い画面(lg 未満)では副次列(開始時刻・所要時間・ステップ数・実行者・環境)を隠し、
 * フロー列の2行目に畳んで表示する。操作列が横スクロールで画面外に出ないようにするため。
 */
const WIDE_ONLY = "hidden lg:table-cell";

/** 開いている比較(a: 古い方 / b: 新しい方) */
interface DiffTarget {
  a: string;
  b: string;
  flow?: string;
}

/** 履歴ブラウザ: 新しい順テーブル(run 単位グルーピング → ステップ詳細ドリルダウン)。run の比較・フローとしての保存もここから行う */
export function HistoryBrowser({ flows }: HistoryBrowserProps) {
  const [flowFilter, setFlowFilter] = useState("");
  const history = useHistory(flowFilter || undefined);
  const groups = useMemo(() => groupHistoryByRun(history.entries), [history.entries]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);
  // 比較: 1 つ目の run を選んで 2 つ目を待っている状態(comparingFrom)と、開いている比較(diffTarget)
  const [comparingFrom, setComparingFrom] = useState<HistoryRunGroup | null>(null);
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);
  // フローとして保存: チェックで選んだ run(runId)と、開いているダイアログの対象
  const [selectedRunIds, setSelectedRunIds] = useState<ReadonlySet<string>>(new Set());
  const [promoteGroups, setPromoteGroups] = useState<HistoryRunGroup[] | null>(null);

  const previousOfComparing = useMemo(
    () => (comparingFrom ? findPreviousRun(groups, comparingFrom) : undefined),
    [groups, comparingFrom],
  );
  const selectedGroups = useMemo(
    () => groups.filter((group) => selectedRunIds.has(group.runId)),
    [groups, selectedRunIds],
  );

  const toggleSelected = (runId: string) =>
    setSelectedRunIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });

  const openDiff = (x: HistoryRunGroup, y: HistoryRunGroup) => {
    const { a, b } = orderRunPair(x, y);
    setDiffTarget({ a, b, ...commonFlow(x, y) });
    setComparingFrom(null);
  };

  const flowNames = useMemo(
    () => Array.from(new Set(flows.filter((f) => f.name).map((f) => f.name as string))),
    [flows],
  );

  return (
    <div className="flex flex-col gap-3 p-6">
      <div className="flex gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LabeledSelect
            labelId="history-flow-label"
            label="フロー"
            triggerSize="sm"
            triggerClassName="font-mono"
            value={flowFilter || ALL_FLOWS}
            onValueChange={(v) => setFlowFilter(v === ALL_FLOWS ? "" : v)}
          >
            <SelectItem value={ALL_FLOWS}>すべて</SelectItem>
            {flowNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </LabeledSelect>
        </div>
      </div>

      {diffTarget && (
        <RunDiffPanel
          // 別の比較を開いたら、除外パスなどの入力状態を作り直す
          key={`${diffTarget.a}:${diffTarget.b}:${diffTarget.flow ?? ""}`}
          a={diffTarget.a}
          b={diffTarget.b}
          flow={diffTarget.flow}
          onClose={() => setDiffTarget(null)}
          // 新しい方の run(B)の承認待ちスナップショットを、ステップごとの操作と下部の承認パネルで扱う
          renderStepActions={({ step, runIds }) => (
            <SnapshotStepAction
              runId={runIds.b}
              step={step}
              reviewId={`snapshot-review-diff-${runIds.b}`}
            />
          )}
          extra={
            <SnapshotReview runId={diffTarget.b} id={`snapshot-review-diff-${diffTarget.b}`} />
          }
        />
      )}

      {comparingFrom && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-md border border-running/40 bg-running/10 px-3 py-2 text-sm"
        >
          <span>
            比較元: <span className="font-mono">{comparingFrom.flow}</span>(
            {formatDateTime(comparingFrom.startedAt)})。比較する相手の run
            で「これと比較」を選んでください
          </span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={previousOfComparing === undefined}
            onClick={() => previousOfComparing && openDiff(previousOfComparing, comparingFrom)}
          >
            前回の同じフローと比較
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setComparingFrom(null)}>
            比較をやめる
          </Button>
          {previousOfComparing === undefined && (
            <span className="text-xs text-muted-foreground">
              {isSingleGroup(comparingFrom)
                ? "単発リクエストには「前回の同じフロー」がありません。比較する run を一覧から選んでください"
                : history.hasMore
                  ? "同じフローの前回の run が読み込み済みの履歴にありません。「さらに読み込む」で履歴を増やすか、一覧から選んでください"
                  : "同じフローの前回の run がありません"}
            </span>
          )}
        </div>
      )}

      {selectedGroups.length > 0 && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-3 py-2 text-sm"
        >
          <span>{selectedRunIds.size} 件の run を選択中(実行順にフローのステップになります)</span>
          <Button type="button" size="sm" onClick={() => setPromoteGroups(selectedGroups)}>
            選択した run をフローとして保存
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSelectedRunIds(new Set())}
          >
            選択を解除
          </Button>
        </div>
      )}

      {history.error && <p className="text-sm text-fail">{history.error}</p>}

      {!history.error && groups.length === 0 && !history.loading && (
        <p className="text-sm text-muted-foreground">履歴がありません</p>
      )}

      {history.loading && groups.length === 0 && (
        // 初回読み込みは content-shaped なスケルトンで示す(role="status" で AT に通知)
        <div role="status" aria-label="履歴を読み込み中" className="flex flex-col gap-1.5">
          {SKELETON_ROWS.map((key) => (
            <Skeleton key={key} className="h-9 w-full" />
          ))}
        </div>
      )}

      {groups.length > 0 && (
        <div className="overflow-hidden rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow className="bg-popover hover:bg-popover">
                <TableHead className="w-10">
                  <span className="sr-only">フローとして保存する run の選択</span>
                </TableHead>
                <TableHead>状態</TableHead>
                <TableHead>フロー</TableHead>
                <TableHead className={WIDE_ONLY}>開始時刻</TableHead>
                {/* run 行は全ステップの durationMs 合計、ステップ行は単一ステップの durationMs。
                    実行画面のサマリー(FlowResult.durationMs)はステップ間のオーバーヘッドも含む
                    wall-clock 時間のため、run 行の値とは意味が異なる場合がある旨を title で補足する */}
                <TableHead
                  className={WIDE_ONLY}
                  title="run 行は全ステップの所要時間の合計です(実行画面のサマリー時間とは計測範囲が異なる場合があります)"
                >
                  所要時間
                </TableHead>
                <TableHead className={WIDE_ONLY}>ステップ数</TableHead>
                <TableHead className={WIDE_ONLY}>実行者</TableHead>
                <TableHead className={WIDE_ONLY}>環境</TableHead>
                <TableHead>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group, i) => {
                // --data 実行では同一 runId の下に複数 iteration の行が並ぶため、runId 単体では
                // グループを一意に特定できない。runId + iteration を React key / 開閉トグルのキーとする
                // (iteration が無い通常実行では従来どおり runId のみと同じ挙動になる)
                const groupKey = `${group.runId}:${group.iteration ?? 0}`;
                const runExpanded = expandedRun === groupKey;
                const audit = pickAudit(group.steps);
                const actorLabel = formatActor(audit.actor);
                return (
                  <Fragment key={groupKey}>
                    <TableRow
                      className={cn("h-9 cursor-pointer hover:bg-muted", i % 2 === 1 && "bg-muted")}
                      {...rowToggleProps(runExpanded, () =>
                        setExpandedRun(runExpanded ? null : groupKey),
                      )}
                    >
                      <TableCell {...stopRowToggle}>
                        <input
                          type="checkbox"
                          checked={selectedRunIds.has(group.runId)}
                          onChange={() => toggleSelected(group.runId)}
                          aria-label={`${group.flow}(${formatDateTime(group.startedAt)})をフローとして保存する対象に選ぶ`}
                          className="size-4 cursor-pointer accent-primary"
                        />
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={group.status} />
                      </TableCell>
                      <TableCell className="font-medium max-lg:break-all max-lg:whitespace-normal">
                        {group.flow}
                        {/* lg 未満: 副次列をここに畳む */}
                        <span className="block font-mono text-xs font-normal text-muted-foreground lg:hidden">
                          {formatDateTime(group.startedAt)} / {formatDuration(group.durationMs)} /{" "}
                          {group.steps.length} ステップ
                          {actorLabel ? ` / ${actorLabel}` : ""}
                          {audit.env ? ` / ${audit.env}` : ""}
                        </span>
                      </TableCell>
                      <TableCell className={cn(WIDE_ONLY, "font-mono text-muted-foreground")}>
                        {formatDateTime(group.startedAt)}
                      </TableCell>
                      <TableCell className={cn(WIDE_ONLY, "font-mono text-muted-foreground")}>
                        {formatDuration(group.durationMs)}
                      </TableCell>
                      <TableCell className={cn(WIDE_ONLY, "font-mono text-muted-foreground")}>
                        {group.steps.length}
                      </TableCell>
                      <TableCell className={cn(WIDE_ONLY, "font-mono")}>
                        {actorLabel ? (
                          // agent / ci を human と見分けやすいよう、human 以外は強調表示する
                          <Badge variant={audit.actor?.kind === "human" ? "outline" : "running"}>
                            {actorLabel}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell className={cn(WIDE_ONLY, "font-mono text-muted-foreground")}>
                        {audit.env ?? "-"}
                      </TableCell>
                      <TableCell {...stopRowToggle}>
                        <div className="flex flex-wrap gap-1.5 lg:flex-nowrap">
                          {comparingFrom === null ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              aria-label={`${group.flow}(${formatDateTime(group.startedAt)})を比較する`}
                              onClick={() => setComparingFrom(group)}
                            >
                              比較
                            </Button>
                          ) : comparingFrom.runId === group.runId ? (
                            <span className="text-xs text-muted-foreground">比較元</span>
                          ) : (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              aria-label={`${group.flow}(${formatDateTime(group.startedAt)})とこれから選んだ run を比較する`}
                              onClick={() => openDiff(comparingFrom, group)}
                            >
                              これと比較
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            aria-label={`${group.flow}(${formatDateTime(group.startedAt)})をフローとして保存`}
                            onClick={() => setPromoteGroups([group])}
                          >
                            フローとして保存
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>

                    {runExpanded && hasPendingSnapshot(group.steps) && (
                      <TableRow className="bg-popover hover:bg-popover">
                        <TableCell colSpan={9} className="whitespace-normal py-3">
                          <SnapshotReview runId={group.runId} />
                        </TableCell>
                      </TableRow>
                    )}

                    {runExpanded &&
                      group.steps.map((step) => {
                        const stepKey = `${groupKey}:${step.step}`;
                        const stepExpanded = expandedStep === stepKey;
                        const stepStatus = resolveStepStatus(step);
                        // skipped では request/response が省略されるため、詳細表示用に存在するものだけ集める
                        const stepDetail: Record<string, unknown> = {};
                        if (step.request) stepDetail.request = step.request;
                        if (step.response) stepDetail.response = step.response;
                        if (step.events) stepDetail.events = step.events;
                        // 安全柵に拒否された(error)エントリは拒否理由を詳細に出す
                        // errorCode が既知なら日本語の説明で出すため、JSON からは外す(未知・未指定は従来どおり JSON)
                        const explainable =
                          Boolean(step.error) && explainError(errorCodeOf(step)) !== null;
                        if (step.error && !explainable) stepDetail.error = step.error;
                        // 監査項目(誰が・どこで・どのコミットで実行したか)
                        if (step.actor) stepDetail.actor = step.actor;
                        if (step.env) stepDetail.env = step.env;
                        if (step.file) stepDetail.file = step.file;
                        if (step.git) stepDetail.git = step.git;
                        const hasStepDetail = Object.keys(stepDetail).length > 0;
                        const hasAnyDetail = hasStepDetail || explainable;
                        return (
                          <Fragment key={stepKey}>
                            <TableRow
                              className="h-9 cursor-pointer bg-card hover:bg-muted"
                              {...rowToggleProps(stepExpanded, () =>
                                setExpandedStep(stepExpanded ? null : stepKey),
                              )}
                            >
                              <TableCell />
                              <TableCell>
                                <StatusBadge status={stepStatus} />
                              </TableCell>
                              <TableCell className="pl-8 font-mono max-lg:break-all max-lg:whitespace-normal">
                                {step.step}
                                <span className="block text-xs text-muted-foreground lg:hidden">
                                  {formatDateTime(step.startedAt)} /{" "}
                                  {formatDuration(step.durationMs)}
                                </span>
                              </TableCell>
                              <TableCell
                                className={cn(WIDE_ONLY, "font-mono text-muted-foreground")}
                              >
                                {formatDateTime(step.startedAt)}
                              </TableCell>
                              <TableCell
                                className={cn(WIDE_ONLY, "font-mono text-muted-foreground")}
                              >
                                {formatDuration(step.durationMs)}
                              </TableCell>
                              <TableCell
                                className={cn(WIDE_ONLY, "font-mono text-muted-foreground")}
                              >
                                {/* skipped は HTTP レスポンスを持たないため、ステータスコードの代わりにその旨を表示する */}
                                {step.response
                                  ? step.response.status
                                  : stepStatus === "error"
                                    ? "エラー"
                                    : "スキップ"}
                              </TableCell>
                              <TableCell className={WIDE_ONLY} />
                              <TableCell className={WIDE_ONLY} />
                              <TableCell />
                            </TableRow>
                            {stepExpanded && (
                              <TableRow className="bg-popover hover:bg-popover">
                                <TableCell colSpan={9} className="whitespace-normal py-3">
                                  {step.assertions.length > 0 && (
                                    <div className="mb-3">
                                      <AssertionList assertions={step.assertions} />
                                    </div>
                                  )}
                                  <RedirectNotes
                                    redirects={step.redirects}
                                    droppedHeaders={step.droppedHeaders}
                                  />
                                  {explainable && step.error && (
                                    <div className="mb-3">
                                      <ErrorExplanation message={step.error} source={step} />
                                    </div>
                                  )}
                                  {hasStepDetail ? (
                                    <JsonBlock value={stepDetail} />
                                  ) : hasAnyDetail ? null : (
                                    <p className="text-sm text-muted-foreground">
                                      スキップされたステップのため詳細はありません
                                    </p>
                                  )}
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        );
                      })}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {history.loading && groups.length > 0 && (
        // 追加読み込み(さらに読み込む)は既存行を維持したままスピナーで示す
        <div className="flex items-center gap-2 text-muted-foreground">
          <Spinner label="履歴を読み込み中" />
          <span>読み込み中…</span>
        </div>
      )}

      {history.hasMore && !history.loading && (
        <Button
          type="button"
          variant="secondary"
          className="self-center"
          onClick={history.loadMore}
        >
          さらに読み込む
        </Button>
      )}

      {promoteGroups && (
        <PromoteDialog groups={promoteGroups} onClose={() => setPromoteGroups(null)} />
      )}
    </div>
  );
}
