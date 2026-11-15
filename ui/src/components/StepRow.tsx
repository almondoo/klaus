import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { RunStepView } from "@/hooks/useRun";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/utils/format";
import { ErrorExplanation } from "./ErrorExplanation";
import { JsonBlock } from "./JsonBlock";
import { AssertionList, RedirectNotes } from "./ResultDetails";
import { StatusBadge } from "./StatusBadge";

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
    <Collapsible
      asChild
      disabled={!canExpand}
      open={expanded && canExpand}
      onOpenChange={setExpanded}
    >
      <li className="overflow-hidden rounded-md border border-border bg-card">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-150 enabled:hover:bg-muted focus-visible:-outline-offset-2",
              !canExpand && "cursor-default",
            )}
          >
            <span aria-hidden="true" className="flex w-4 shrink-0 text-muted-foreground">
              {canExpand ? (
                expanded ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )
              ) : null}
            </span>
            <span className="flex-1 font-sans font-medium">{step.name}</span>
            <span className="flex items-center gap-3">
              {result && (
                <span className="font-mono text-sm text-muted-foreground">
                  {formatDuration(result.durationMs)}
                </span>
              )}
              <StatusBadge status={step.status} />
            </span>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="flex flex-col gap-3 border-t border-border px-3 pb-3">
          {result?.error && (
            <div className="mt-2">
              <ErrorExplanation message={result.error} source={result} />
            </div>
          )}

          {result && <AssertionList assertions={result.assertions} />}

          {result && (
            <RedirectNotes redirects={result.redirects} droppedHeaders={result.droppedHeaders} />
          )}

          {result?.request && (
            <div>
              <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                リクエスト
              </h3>
              <p className="mb-1 flex gap-2 font-mono text-sm break-all">
                <span className="shrink-0 font-bold text-running">{result.request.method}</span>
                <span>{result.request.url}</span>
              </p>
              <JsonBlock value={result.request} />
            </div>
          )}

          {result?.response && (
            <div>
              <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                レスポンス({result.response.status})
              </h3>
              <JsonBlock value={result.response} />
            </div>
          )}
        </CollapsibleContent>
      </li>
    </Collapsible>
  );
}
