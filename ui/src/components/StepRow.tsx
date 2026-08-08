import { CaretDown, CaretRight, CheckCircle, XCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { RunStepView } from "../hooks/useRun";
import { formatDuration } from "../utils/format";
import { JsonBlock } from "./JsonBlock";
import { StatusBadge } from "./StatusBadge";
import "./StepRow.css";

export interface StepRowProps {
  step: RunStepView;
}

/**
 * 実行ビューの1ステップ行。
 * 失敗/エラー時は初回のみ自動展開する(以後はユーザー操作を優先する)。成功時はデフォルト折り畳み。
 */
export function StepRow({ step }: StepRowProps) {
  const [expanded, setExpanded] = useState(false);
  const autoExpandedRef = useRef(false);

  useEffect(() => {
    const isFailure = step.status === "failed" || step.status === "error";
    if (isFailure && !autoExpandedRef.current) {
      setExpanded(true);
      autoExpandedRef.current = true;
    }
  }, [step.status]);

  const result = step.result;
  const canExpand = Boolean(result);

  return (
    <li className="klaus-step-row">
      <button
        type="button"
        className="klaus-step-row__header"
        onClick={() => canExpand && setExpanded((v) => !v)}
        disabled={!canExpand}
        aria-expanded={expanded}
      >
        <span className="klaus-step-row__toggle" aria-hidden="true">
          {canExpand ? (
            expanded ? (
              <CaretDown size={14} weight="regular" />
            ) : (
              <CaretRight size={14} weight="regular" />
            )
          ) : null}
        </span>
        <span className="klaus-step-row__name">{step.name}</span>
        <span className="klaus-step-row__meta">
          {result && (
            <span className="klaus-step-row__duration">{formatDuration(result.durationMs)}</span>
          )}
          <StatusBadge status={step.status} />
        </span>
      </button>

      {expanded && result && (
        <div className="klaus-step-row__detail">
          {result.error && <p className="klaus-step-row__error">{result.error}</p>}

          {result.assertions.length > 0 && (
            <ul className="klaus-step-row__assertions">
              {result.assertions.map((assertion, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: assertions は実行結果の静的リストで並び替え・挿入が発生せず、kind + message も重複定義があり得るため一意性を保証できない
                <li key={`${assertion.kind}-${i}`} className={assertion.ok ? "is-ok" : "is-fail"}>
                  {assertion.ok ? (
                    <CheckCircle size={14} weight="regular" />
                  ) : (
                    <XCircle size={14} weight="regular" />
                  )}
                  <span>{assertion.message}</span>
                </li>
              ))}
            </ul>
          )}

          {result.request && (
            <div className="klaus-step-row__section">
              <h3>リクエスト</h3>
              <p className="klaus-step-row__request-line">
                <span className="klaus-step-row__method">{result.request.method}</span>
                <span className="klaus-step-row__url">{result.request.url}</span>
              </p>
              <JsonBlock value={result.request} />
            </div>
          )}

          {result.response && (
            <div className="klaus-step-row__section">
              <h3>レスポンス({result.response.status})</h3>
              <JsonBlock value={result.response} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}
