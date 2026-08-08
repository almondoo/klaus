import { AlertTriangle, X } from "lucide-react";
import { useEffect } from "react";
import type { FlowListEntry } from "@/api/client";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// 読み込み中に表示するスケルトン行の数(index をそのまま key に使うと Biome の
// noArrayIndexKey に抵触するため、固定長の文字列配列を key として使う)
const SKELETON_ROWS = ["row-1", "row-2", "row-3", "row-4", "row-5", "row-6"];

export interface SidebarProps {
  flows: FlowListEntry[];
  loading: boolean;
  error: string | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  open: boolean;
  onClose: () => void;
}

/** フロー一覧サイドバー(固定 260px。768px 未満ではドロワー化) */
export function Sidebar({
  flows,
  loading,
  error,
  selectedPath,
  onSelect,
  open,
  onClose,
}: SidebarProps) {
  // モバイルドロワー表示中に Escape キーで閉じられるようにする(オーバーレイ UI の一般的な期待挙動)
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  return (
    <>
      {open && (
        <button
          type="button"
          className="fixed inset-0 z-20 bg-black/50 md:hidden"
          aria-label="サイドバーを閉じる"
          onClick={onClose}
        />
      )}
      <nav
        aria-label="フロー一覧"
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex h-screen w-sidebar min-w-sidebar -translate-x-full flex-col overflow-hidden border-r border-border bg-popover shadow-2xl transition-transform duration-[250ms] md:static md:translate-x-0 md:shadow-none",
          open && "translate-x-0",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3 font-semibold">
          <span>フロー</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="サイドバーを閉じる"
            onClick={onClose}
          >
            <X className="size-5" />
          </Button>
        </div>

        {loading && (
          // content-shaped なスケルトンでフロー一覧の読み込み中を示す(role="status" で AT に通知)
          <div
            role="status"
            aria-label="フロー一覧を読み込み中"
            className="flex flex-col gap-1.5 p-1.5"
          >
            {SKELETON_ROWS.map((key) => (
              <div key={key} className="flex flex-col gap-1.5 rounded-md px-3 py-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        )}

        {error && <div className="p-4 text-sm text-fail">{error}</div>}

        {!loading && !error && flows.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground">フローが見つかりません</div>
        )}

        <ScrollArea className="flex-1">
          <ul className="flex flex-col gap-0.5 p-1.5">
            {flows.map((flow) => (
              <li key={flow.path}>
                <FlowItem flow={flow} active={flow.path === selectedPath} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </ScrollArea>
      </nav>
    </>
  );
}

function FlowItem({
  flow,
  active,
  onSelect,
}: {
  flow: FlowListEntry;
  active: boolean;
  onSelect: (path: string) => void;
}) {
  const button = (
    <button
      type="button"
      className={cn(
        "flex min-h-11 w-full flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors duration-150 enabled:hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60",
        active && "bg-secondary shadow-[inset_3px_0_0_var(--color-primary)]",
      )}
      onClick={() => !flow.error && onSelect(flow.path)}
      disabled={Boolean(flow.error)}
      aria-disabled={Boolean(flow.error)}
    >
      <span className="flex items-center gap-1.5 font-sans font-medium">
        {flow.error && (
          <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
        )}
        {flow.name ?? flow.path}
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground">{flow.path}</span>
      {flow.error && <span className="text-xs text-destructive">{flow.error}</span>}
    </button>
  );

  if (!flow.error) return button;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{flow.error}</TooltipContent>
    </Tooltip>
  );
}
