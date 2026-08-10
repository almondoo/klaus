import { ArrowLeft, History, Menu, Pencil, Play, Send } from "lucide-react";
import type { EnvironmentListEntry } from "@/api/client";
import { LabeledSelect } from "@/components/LabeledSelect";
import { Button } from "@/components/ui/button";
import { SelectItem } from "@/components/ui/select";

export interface TopBarProps {
  mode: "request" | "runner" | "history";
  flowName: string | null;
  environments: EnvironmentListEntry[];
  selectedEnv: string;
  onEnvChange: (env: string) => void;
  onRun: () => void;
  running: boolean;
  canRun: boolean;
  onOpenSidebar: () => void;
  onShowRequest: () => void;
  onShowHistory: () => void;
  onBack: () => void;
  envEditorOpen: boolean;
  onToggleEnvEditor: () => void;
}

/** メイン領域上部の固定バー。環境セレクタ・実行ボタン・画面切り替えを持つ */
export function TopBar({
  mode,
  flowName,
  environments,
  selectedEnv,
  onEnvChange,
  onRun,
  running,
  canRun,
  onOpenSidebar,
  onShowRequest,
  onShowHistory,
  onBack,
  envEditorOpen,
  onToggleEnvEditor,
}: TopBarProps) {
  return (
    <header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-popover px-4 py-3">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="フロー一覧を開く"
          onClick={onOpenSidebar}
        >
          <Menu className="size-5" />
        </Button>

        {mode === "history" ? (
          <Button type="button" variant="outline" onClick={onBack}>
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">前の画面に戻る</span>
          </Button>
        ) : mode === "runner" ? (
          <h1 className="font-sans text-base font-semibold">
            {flowName ?? "フローを選択してください"}
          </h1>
        ) : (
          <h1 className="font-sans text-base font-semibold">単発リクエスト実行</h1>
        )}
      </div>

      <div className="flex items-center gap-3">
        {mode !== "history" && (
          <>
            {/* 選択中の環境は単発実行モードでも実行に使われるため、runner に限らず常に表示する */}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LabeledSelect
                labelId="topbar-env-label"
                label="環境"
                triggerSize="sm"
                triggerClassName="font-mono"
                placeholder="(なし)"
                value={selectedEnv}
                onValueChange={onEnvChange}
                disabled={environments.length === 0}
              >
                {environments.map((env) => (
                  <SelectItem key={env.name} value={env.name}>
                    {env.name}
                  </SelectItem>
                ))}
              </LabeledSelect>
              <Button
                type="button"
                variant={envEditorOpen ? "secondary" : "ghost"}
                size="icon"
                aria-label="環境を編集"
                aria-pressed={envEditorOpen}
                disabled={!selectedEnv}
                onClick={onToggleEnvEditor}
              >
                <Pencil className="size-4" />
              </Button>
            </div>

            {mode === "runner" && (
              <Button type="button" onClick={onRun} disabled={!canRun || running}>
                <Play className="size-4" />
                <span>{running ? "実行中…" : "実行"}</span>
              </Button>
            )}
          </>
        )}

        {mode !== "request" && (
          <Button
            type="button"
            variant="outline"
            onClick={onShowRequest}
            aria-label="単発リクエスト実行を表示"
          >
            <Send className="size-4" />
            <span className="hidden sm:inline">単発実行</span>
          </Button>
        )}

        {mode !== "history" && (
          <Button type="button" variant="outline" onClick={onShowHistory} aria-label="履歴を表示">
            <History className="size-4" />
            <span className="hidden sm:inline">履歴</span>
          </Button>
        )}
      </div>
    </header>
  );
}
