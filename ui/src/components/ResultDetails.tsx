import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type {
  AssertionResult,
  OpenApiAssertionDetail,
  OpenApiRunSummary,
  SnapshotAssertionDetail,
} from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  capList,
  countSnapshotStates,
  describeDroppedHeaders,
  describeOpenApiCoverage,
  OPENAPI_STATE_LABEL,
  SNAPSHOT_STATE_LABEL,
} from "@/utils/results";
import { withOccurrenceKeys } from "@/utils/runDiff";
import { DifferenceRows } from "./DiffParts";

/** OpenAPI の違反を一覧に出す最大件数(それ以上は件数だけ示す) */
const MAX_SHOWN_VIOLATIONS = 10;
/** カバレッジ集計の一覧を出す最大件数 */
const MAX_SHOWN_COVERAGE_ITEMS = 10;

function SnapshotDetail({ detail }: { detail: SnapshotAssertionDetail }) {
  const pending = detail.state === "mismatch" || detail.state === "missing";
  const differences = detail.differences ?? [];
  return (
    <div className="mt-1 flex flex-col gap-1.5 pl-5 text-xs text-foreground">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={pending ? "fail" : detail.state === "matched" ? "pass" : "skipped"}>
          {SNAPSHOT_STATE_LABEL[detail.state]}
        </Badge>
        <span className="text-muted-foreground">キー</span>
        <code className="font-mono break-all">{detail.key}</code>
        <span className="text-muted-foreground">ファイル</span>
        <code className="font-mono break-all">{detail.file}</code>
      </p>
      {differences.length > 0 && (
        <DifferenceRows
          ignored={[]}
          list={{
            total: detail.differenceCount ?? differences.length,
            omitted: Math.max(
              (detail.differenceCount ?? differences.length) - differences.length,
              0,
            ),
            differences,
          }}
        />
      )}
    </div>
  );
}

function OpenApiDetail({ detail }: { detail: OpenApiAssertionDetail }) {
  const violations = detail.violations ?? [];
  const { shown, omitted } = capList(violations, MAX_SHOWN_VIOLATIONS, detail.violationCount);
  const bad = detail.state === "invalid";
  return (
    <div className="mt-1 flex flex-col gap-1.5 pl-5 text-xs text-foreground">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={bad ? "fail" : detail.state === "valid" ? "pass" : "skipped"}>
          {OPENAPI_STATE_LABEL[detail.state]}
        </Badge>
        {detail.operation && <code className="font-mono break-all">{detail.operation}</code>}
        {detail.document && (
          <>
            <span className="text-muted-foreground">仕様</span>
            <code className="font-mono break-all">{detail.document}</code>
          </>
        )}
      </p>
      {shown.length > 0 && (
        <ul className="overflow-hidden rounded-sm border border-border">
          {shown.map((violation) => (
            <li
              key={`${violation.location}:${violation.path ?? ""}:${violation.message}`}
              className="flex flex-wrap gap-x-3 gap-y-0.5 border-t border-border px-3 py-1.5 first:border-t-0"
            >
              <span className="shrink-0 text-muted-foreground">{violation.location}</span>
              {violation.path !== undefined && (
                <code className="shrink-0 font-mono break-all">
                  {violation.path === "" ? "(ルート)" : violation.path}
                </code>
              )}
              <span className="min-w-0 break-words">{violation.message}</span>
            </li>
          ))}
        </ul>
      )}
      {omitted > 0 && (
        <p className="text-muted-foreground">
          ほか {omitted} 件の違反は表示していません(全 {detail.violationCount ?? violations.length}{" "}
          件)
        </p>
      )}
    </div>
  );
}

/**
 * アサーション結果の一覧(実行ビューと履歴のステップ詳細で共通)。
 * 通常のアサーションはメッセージ 1 行、snapshot / openapi は状態・差分・違反の詳細を続けて表示する。
 */
export function AssertionList({ assertions }: { assertions: readonly AssertionResult[] }) {
  if (assertions.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {assertions.map((assertion, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: assertions は実行結果の静的リストで並び替え・挿入が発生せず、kind + message も重複定義があり得るため一意性を保証できない
        <li key={`${assertion.kind}-${i}`}>
          <p className={cn("flex items-center gap-1.5", assertion.ok ? "text-pass" : "text-fail")}>
            {assertion.ok ? (
              <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <XCircle className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            <span>{assertion.message}</span>
          </p>
          {assertion.snapshot && <SnapshotDetail detail={assertion.snapshot} />}
          {assertion.openapi && <OpenApiDetail detail={assertion.openapi} />}
        </li>
      ))}
    </ul>
  );
}

/** リダイレクトで辿った URL と、別オリジンへの移動で落としたヘッダー名(値は含まれない) */
export function RedirectNotes({
  redirects,
  droppedHeaders,
}: {
  redirects?: readonly string[] | undefined;
  droppedHeaders?: ReadonlyArray<{ hop: number; headers: string[] }> | undefined;
}) {
  if ((redirects?.length ?? 0) === 0 && (droppedHeaders?.length ?? 0) === 0) return null;
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <h3 className="font-semibold tracking-wide text-muted-foreground uppercase">リダイレクト</h3>
      {redirects && redirects.length > 0 && (
        <ol
          className="flex list-decimal flex-col gap-0.5 pl-5 font-mono break-all"
          aria-label="リダイレクトで辿った URL"
        >
          {withOccurrenceKeys(redirects, (url) => url).map(({ key, item }) => (
            <li key={key}>{item}</li>
          ))}
        </ol>
      )}
      {droppedHeaders && droppedHeaders.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {droppedHeaders.map((dropped) => (
            <li key={dropped.hop} className="text-skipped">
              {describeDroppedHeaders(dropped)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CoverageList({ title, items }: { title: string; items: string[] }) {
  const { shown, omitted } = capList(items, MAX_SHOWN_COVERAGE_ITEMS);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground">
        {title}({items.length} 件)
      </span>
      <ul className="flex flex-col gap-0.5 font-mono break-all">
        {shown.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      {omitted > 0 && <span className="text-muted-foreground">ほか {omitted} 件</span>}
    </div>
  );
}

/**
 * 実行全体の注意と集計: 警告(tls.insecure の使用など)、スナップショットの集計、OpenAPI のカバレッジ。
 * 該当する情報が何も無ければ何も表示しない。
 */
export function RunNotices({
  warnings,
  steps,
  openapi,
}: {
  warnings: readonly string[];
  steps: ReadonlyArray<{ assertions: readonly AssertionResult[] }>;
  openapi: OpenApiRunSummary | null;
}) {
  const snapshots = countSnapshotStates(steps);
  if (warnings.length === 0 && !snapshots && !openapi) return null;
  const pending = snapshots ? snapshots.mismatch + snapshots.missing : 0;
  const wrote = snapshots ? snapshots.written + snapshots.updated : 0;
  return (
    <div className="flex flex-col gap-3">
      {warnings.length > 0 && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-skipped/40 bg-skipped/10 p-3 text-sm"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-skipped" />
          <div>
            <p className="font-semibold">警告</p>
            <ul className="list-disc pl-5">
              {warnings.map((warning) => (
                <li key={warning} className="break-words">
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {snapshots && (
        <section
          aria-label="スナップショットの集計"
          className="rounded-md border border-border bg-card p-3 text-sm"
        >
          <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            スナップショット
          </h3>
          <p>
            一致 {snapshots.matched} / 新規書き込み {snapshots.written} / 更新 {snapshots.updated} /
            不一致 {snapshots.mismatch} / 基準なし {snapshots.missing}
          </p>
          {wrote > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              基準ファイルを書き込みました。リポジトリの変更を確認してコミットしてください。
            </p>
          )}
          {pending > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              差分を確認して基準として承認するには、履歴タブでこの run を開いてください。
            </p>
          )}
        </section>
      )}

      {openapi && (
        <section
          aria-label="OpenAPI のカバレッジ"
          className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 text-sm"
        >
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            OpenAPI
          </h3>
          <p>{describeOpenApiCoverage(openapi)}</p>
          <div className="flex flex-col gap-2 text-xs">
            <CoverageList
              title="照合されなかったオペレーション"
              items={openapi.uncovered.map((item) => item.operation)}
            />
            <CoverageList
              title="どのオペレーションにも対応しなかったリクエスト"
              items={openapi.unmatched.map((item) => `${item.method} ${item.url} ×${item.count}`)}
            />
            {openapi.excluded.length > 0 && (
              <p className="text-muted-foreground">
                検証の対象外にしたステップ: {openapi.excluded.length}{" "}
                件(SSE・WebSocket・リダイレクトを追ったもの)
              </p>
            )}
            {openapi.truncated && (
              <p className="text-muted-foreground">一覧は件数上限で切り詰められています</p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
