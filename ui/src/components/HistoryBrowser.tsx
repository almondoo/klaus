import { Fragment, useMemo, useState } from "react";
import type { FlowListEntry } from "../api/client";
import { useHistory } from "../hooks/useHistory";
import { formatDateTime, formatDuration } from "../utils/format";
import { groupHistoryByRun } from "../utils/history";
import { JsonBlock } from "./JsonBlock";
import { Spinner } from "./Spinner";
import { StatusBadge } from "./StatusBadge";
import "./HistoryBrowser.css";

export interface HistoryBrowserProps {
  flows: FlowListEntry[];
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
    <div className="klaus-history">
      <div className="klaus-history__toolbar">
        <label className="klaus-history__filter">
          <span>フロー</span>
          <select value={flowFilter} onChange={(e) => setFlowFilter(e.target.value)}>
            <option value="">すべて</option>
            {flowNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {history.error && <p className="klaus-history__error">{history.error}</p>}

      {!history.error && groups.length === 0 && !history.loading && (
        <p className="klaus-history__empty">履歴がありません</p>
      )}

      {groups.length > 0 && (
        <div className="klaus-history__table-wrap">
          <table className="klaus-history__table">
            <thead>
              <tr>
                <th>状態</th>
                <th>フロー</th>
                <th>開始時刻</th>
                <th>所要時間</th>
                <th>ステップ数</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group, i) => {
                const runExpanded = expandedRun === group.runId;
                return (
                  <Fragment key={group.runId}>
                    {/* <tr> はテーブル構造上 <button> にできないため、tabIndex + onKeyDown + aria-expanded でキーボード操作性を担保する */}
                    <tr
                      className={`klaus-history__row ${i % 2 === 1 ? "is-odd" : ""}`}
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
                      <td>
                        <StatusBadge status={group.status} />
                      </td>
                      <td className="klaus-history__flow">{group.flow}</td>
                      <td className="klaus-history__mono">{formatDateTime(group.startedAt)}</td>
                      <td className="klaus-history__mono">{formatDuration(group.durationMs)}</td>
                      <td className="klaus-history__mono">{group.steps.length}</td>
                    </tr>

                    {runExpanded &&
                      group.steps.map((step) => {
                        const stepKey = `${group.runId}:${step.step}`;
                        const stepExpanded = expandedStep === stepKey;
                        const stepStatus = step.assertions.some((a) => !a.ok) ? "failed" : "passed";
                        return (
                          <Fragment key={stepKey}>
                            <tr
                              className="klaus-history__step-row"
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
                              <td>
                                <StatusBadge status={stepStatus} />
                              </td>
                              <td className="klaus-history__step-name">{step.step}</td>
                              <td className="klaus-history__mono">
                                {formatDateTime(step.startedAt)}
                              </td>
                              <td className="klaus-history__mono">
                                {formatDuration(step.durationMs)}
                              </td>
                              <td className="klaus-history__mono">{step.response.status}</td>
                            </tr>
                            {stepExpanded && (
                              <tr className="klaus-history__detail-row">
                                <td colSpan={5}>
                                  <JsonBlock
                                    value={{ request: step.request, response: step.response }}
                                  />
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {history.loading && (
        <div className="klaus-history__loading">
          <Spinner label="履歴を読み込み中" />
          <span>読み込み中…</span>
        </div>
      )}

      {history.hasMore && !history.loading && (
        <button
          type="button"
          className="klaus-btn klaus-history__load-more"
          onClick={history.loadMore}
        >
          さらに読み込む
        </button>
      )}
    </div>
  );
}
