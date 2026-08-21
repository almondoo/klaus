import { Fragment, useMemo, useState } from "react";
import type { FlowListEntry } from "@/api/client";
import { LabeledSelect } from "@/components/LabeledSelect";
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
import { formatDateTime, formatDuration } from "@/utils/format";
import { groupHistoryByRun, resolveStepStatus } from "@/utils/history";
import { JsonBlock } from "./JsonBlock";
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

/** 履歴ブラウザ: 新しい順テーブル(run 単位グルーピング → ステップ詳細ドリルダウン) */
export function HistoryBrowser({ flows }: HistoryBrowserProps) {
  const [flowFilter, setFlowFilter] = useState("");
  const history = useHistory(flowFilter || undefined);
  const groups = useMemo(() => groupHistoryByRun(history.entries), [history.entries]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

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
                <TableHead>状態</TableHead>
                <TableHead>フロー</TableHead>
                <TableHead>開始時刻</TableHead>
                {/* run 行は全ステップの durationMs 合計、ステップ行は単一ステップの durationMs。
                    実行画面のサマリー(FlowResult.durationMs)はステップ間のオーバーヘッドも含む
                    wall-clock 時間のため、run 行の値とは意味が異なる場合がある旨を title で補足する */}
                <TableHead title="run 行は全ステップの所要時間の合計です(実行画面のサマリー時間とは計測範囲が異なる場合があります)">
                  所要時間
                </TableHead>
                <TableHead>ステップ数</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group, i) => {
                // --data 実行では同一 runId の下に複数 iteration の行が並ぶため、runId 単体では
                // グループを一意に特定できない。runId + iteration を React key / 開閉トグルのキーとする
                // (iteration が無い通常実行では従来どおり runId のみと同じ挙動になる)
                const groupKey = `${group.runId}:${group.iteration ?? 0}`;
                const runExpanded = expandedRun === groupKey;
                return (
                  <Fragment key={groupKey}>
                    <TableRow
                      className={cn("h-9 cursor-pointer hover:bg-muted", i % 2 === 1 && "bg-muted")}
                      {...rowToggleProps(runExpanded, () =>
                        setExpandedRun(runExpanded ? null : groupKey),
                      )}
                    >
                      <TableCell>
                        <StatusBadge status={group.status} />
                      </TableCell>
                      <TableCell className="font-medium">{group.flow}</TableCell>
                      <TableCell className="font-mono text-muted-foreground">
                        {formatDateTime(group.startedAt)}
                      </TableCell>
                      <TableCell className="font-mono text-muted-foreground">
                        {formatDuration(group.durationMs)}
                      </TableCell>
                      <TableCell className="font-mono text-muted-foreground">
                        {group.steps.length}
                      </TableCell>
                    </TableRow>

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
                        const hasStepDetail = Object.keys(stepDetail).length > 0;
                        return (
                          <Fragment key={stepKey}>
                            <TableRow
                              className="h-9 cursor-pointer bg-card hover:bg-muted"
                              {...rowToggleProps(stepExpanded, () =>
                                setExpandedStep(stepExpanded ? null : stepKey),
                              )}
                            >
                              <TableCell>
                                <StatusBadge status={stepStatus} />
                              </TableCell>
                              <TableCell className="pl-8 font-mono">{step.step}</TableCell>
                              <TableCell className="font-mono text-muted-foreground">
                                {formatDateTime(step.startedAt)}
                              </TableCell>
                              <TableCell className="font-mono text-muted-foreground">
                                {formatDuration(step.durationMs)}
                              </TableCell>
                              <TableCell className="font-mono text-muted-foreground">
                                {/* skipped は HTTP レスポンスを持たないため、ステータスコードの代わりにその旨を表示する */}
                                {step.response ? step.response.status : "スキップ"}
                              </TableCell>
                            </TableRow>
                            {stepExpanded && (
                              <TableRow className="bg-popover hover:bg-popover">
                                <TableCell colSpan={5} className="whitespace-normal py-3">
                                  {hasStepDetail ? (
                                    <JsonBlock value={stepDetail} />
                                  ) : (
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
    </div>
  );
}
