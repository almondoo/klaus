import { Fragment, useMemo, useState } from "react";
import type { FlowListEntry } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
        {/* Select は独自コンポーネントで <label> の暗黙的な関連付けを静的解析で検証できないため、
            aria-labelledby で明示的に紐付ける(biome の lint/a11y/noLabelWithoutControl 対策) */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span id="history-flow-label">フロー</span>
          <Select
            value={flowFilter || ALL_FLOWS}
            onValueChange={(v) => setFlowFilter(v === ALL_FLOWS ? "" : v)}
          >
            <SelectTrigger size="sm" className="font-mono" aria-labelledby="history-flow-label">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_FLOWS}>すべて</SelectItem>
              {flowNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
                <TableHead>所要時間</TableHead>
                <TableHead>ステップ数</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group, i) => {
                const runExpanded = expandedRun === group.runId;
                return (
                  <Fragment key={group.runId}>
                    {/* <tr> はテーブル構造上 <button> にできないため、tabIndex + onKeyDown + aria-expanded でキーボード操作性を担保する */}
                    <TableRow
                      className={cn("h-9 cursor-pointer hover:bg-muted", i % 2 === 1 && "bg-muted")}
                      tabIndex={0}
                      aria-expanded={runExpanded}
                      onClick={() => setExpandedRun(runExpanded ? null : group.runId)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setExpandedRun(runExpanded ? null : group.runId);
                        }
                      }}
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
                        const stepKey = `${group.runId}:${step.step}`;
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
                              tabIndex={0}
                              aria-expanded={stepExpanded}
                              onClick={() => setExpandedStep(stepExpanded ? null : stepKey)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  setExpandedStep(stepExpanded ? null : stepKey);
                                }
                              }}
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
