import { type ReactNode, useState } from "react";
import type { BodyDiff, DifferenceList, HeaderDiff, JsonDifference } from "@/api/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DIFFERENCE_KIND_LABEL,
  generalizePath,
  previewValue,
  withOccurrenceKeys,
} from "@/utils/runDiff";

/** 値の表示を折りたたむ文字数。これを超える値は先頭だけ見せ、「全文を表示」で開く */
const VALUE_LIMIT = 120;

/** 長い値を折りたたんで表示する(開閉はボタン。色ではなく文言で状態を示す) */
export function CollapsibleValue({ value, className }: { value: unknown; className?: string }) {
  const [open, setOpen] = useState(false);
  const preview = previewValue(value, VALUE_LIMIT);
  return (
    <span className={cn("min-w-0 text-xs", className)}>
      {open ? (
        <pre className="mt-1 max-h-64 overflow-auto rounded-sm border border-border bg-popover p-2 font-mono whitespace-pre-wrap break-all">
          {preview.full}
        </pre>
      ) : (
        <code className="font-mono break-all">{preview.text}</code>
      )}
      {preview.truncated && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ml-2 cursor-pointer text-running underline underline-offset-2 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {open ? "折りたたむ" : "全文を表示"}
        </button>
      )}
    </span>
  );
}

/** 「before → after」の 1 行(どちらかが無ければ片方だけ) */
export function BeforeAfter({
  before,
  after,
  hasBefore = true,
  hasAfter = true,
}: {
  before?: unknown;
  after?: unknown;
  hasBefore?: boolean;
  hasAfter?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
      {hasBefore && <CollapsibleValue value={before} className="text-fail" />}
      {hasBefore && hasAfter && (
        <span aria-hidden="true" className="text-muted-foreground">
          →
        </span>
      )}
      {hasBefore && hasAfter && <span className="sr-only">から</span>}
      {hasAfter && <CollapsibleValue value={after} className="text-pass" />}
    </span>
  );
}

function DifferenceRow({
  difference,
  ignored,
  onIgnore,
}: {
  difference: JsonDifference;
  ignored: readonly string[];
  onIgnore?: ((pattern: string) => void) | undefined;
}) {
  const { symbol, label } = DIFFERENCE_KIND_LABEL[difference.kind];
  const pattern = generalizePath(difference.path);
  const canIgnore = onIgnore !== undefined && difference.kind !== "too-deep";
  const alreadyIgnored = ignored.includes(pattern);
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-border px-3 py-2 first:border-t-0">
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium">
        <span aria-hidden="true" className="font-mono">
          {symbol}
        </span>
        {label}
      </span>
      <code className="shrink-0 font-mono text-xs break-all">{difference.path}</code>
      <span className="min-w-0 flex-1 text-xs">
        {difference.kind === "too-deep" && (
          <span className="text-muted-foreground">
            入れ子が深すぎるため、この位置から下の差分は列挙していません(部分木は異なります)
          </span>
        )}
        {difference.kind === "added" && (
          <CollapsibleValue value={difference.after} className="text-pass" />
        )}
        {difference.kind === "removed" && (
          <CollapsibleValue value={difference.before} className="text-fail" />
        )}
        {(difference.kind === "changed" || difference.kind === "type-changed") && (
          <BeforeAfter before={difference.before} after={difference.after} />
        )}
      </span>
      {canIgnore && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          disabled={alreadyIgnored}
          title={`除外パターン: ${pattern}`}
          aria-label={`${pattern} を比較から除外`}
          onClick={() => onIgnore?.(pattern)}
        >
          {alreadyIgnored ? "除外済み" : "除外"}
        </Button>
      )}
    </li>
  );
}

/** JSON の差分(path / kind / before → after)のリスト。省略された件数も示す */
export function DifferenceRows({
  list,
  ignored,
  onIgnore,
}: {
  list: DifferenceList;
  ignored: readonly string[];
  onIgnore?: ((pattern: string) => void) | undefined;
}) {
  return (
    <div>
      <ul className="overflow-hidden rounded-sm border border-border">
        {withOccurrenceKeys(list.differences, (d) => `${d.kind}:${d.path}`).map(({ key, item }) => (
          <DifferenceRow key={key} difference={item} ignored={ignored} onIgnore={onIgnore} />
        ))}
      </ul>
      {list.omitted > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          ほか {list.omitted} 件の差分は省略されました(全 {list.total} 件)
        </p>
      )}
    </div>
  );
}

/** body の差分。JSON は差分リスト、テキストは変更行(+ / -)を表示する */
export function BodyDiffView({
  body,
  ignored,
  onIgnore,
}: {
  body: BodyDiff;
  ignored: readonly string[];
  onIgnore?: ((pattern: string) => void) | undefined;
}) {
  if (body.kind === "json")
    return <DifferenceRows list={body} ignored={ignored} onIgnore={onIgnore} />;
  return (
    <div>
      <p className="mb-1 text-xs text-muted-foreground">
        テキストの差分: 追加 {body.added} 行 / 削除 {body.removed} 行
      </p>
      <ul className="overflow-hidden rounded-sm border border-border font-mono text-xs">
        {withOccurrenceKeys(body.lines, (l) => `${l.op}:${l.line}`).map(({ key, item: change }) => (
          <li key={key} className="flex gap-2 border-t border-border px-3 py-1 first:border-t-0">
            <span className="shrink-0">
              <span aria-hidden="true">{change.op}</span>
              <span className="sr-only">{change.op === "+" ? "追加された行" : "削除された行"}</span>
            </span>
            <span
              className={cn(
                "min-w-0 break-all whitespace-pre-wrap",
                change.op === "+" ? "text-pass" : "text-fail",
              )}
            >
              {change.line === "" ? "(空行)" : change.line}
            </span>
          </li>
        ))}
      </ul>
      {body.omitted > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          ほか {body.omitted} 行の差分は省略されました
        </p>
      )}
    </div>
  );
}

/** レスポンスヘッダーの差分(追加・削除・変更) */
export function HeaderDiffView({ headers }: { headers: HeaderDiff }) {
  const rows: Array<{ name: string; symbol: string; label: string; node: ReactNode }> = [
    ...Object.entries(headers.added).map(([name, value]) => ({
      name,
      symbol: "+",
      label: "追加",
      node: <CollapsibleValue value={value} className="text-pass" />,
    })),
    ...Object.entries(headers.removed).map(([name, value]) => ({
      name,
      symbol: "-",
      label: "削除",
      node: <CollapsibleValue value={value} className="text-fail" />,
    })),
    ...Object.entries(headers.changed).map(([name, value]) => ({
      name,
      symbol: "~",
      label: "変更",
      node: <BeforeAfter before={value.a} after={value.b} />,
    })),
  ];
  return (
    <ul className="overflow-hidden rounded-sm border border-border">
      {rows.map((row) => (
        <li
          key={`${row.label}:${row.name}`}
          className="flex flex-wrap items-start gap-x-3 gap-y-1 border-t border-border px-3 py-2 first:border-t-0"
        >
          <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium">
            <span aria-hidden="true" className="font-mono">
              {row.symbol}
            </span>
            {row.label}
          </span>
          <code className="shrink-0 font-mono text-xs break-all">{row.name}</code>
          <span className="min-w-0 flex-1 text-xs">{row.node}</span>
        </li>
      ))}
    </ul>
  );
}
