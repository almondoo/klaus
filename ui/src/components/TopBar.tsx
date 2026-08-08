import { ArrowLeft, History, Menu, Play } from "lucide-react";
import type { EnvironmentListEntry } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface TopBarProps {
  mode: "runner" | "history";
  flowName: string | null;
  environments: EnvironmentListEntry[];
  selectedEnv: string;
  onEnvChange: (env: string) => void;
  onRun: () => void;
  running: boolean;
  canRun: boolean;
  onOpenSidebar: () => void;
  onShowHistory: () => void;
  onBackToRunner: () => void;
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
  onShowHistory,
  onBackToRunner,
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
          <Button type="button" variant="outline" onClick={onBackToRunner}>
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">実行ビューに戻る</span>
          </Button>
        ) : (
          <h1 className="font-sans text-base font-semibold">
            {flowName ?? "フローを選択してください"}
          </h1>
        )}
      </div>

      <div className="flex items-center gap-3">
        {mode === "runner" && (
          <>
            {/* Select は独自コンポーネントで <label> の暗黙的な関連付けを静的解析で検証できないため、
                aria-labelledby で明示的に紐付ける(biome の lint/a11y/noLabelWithoutControl 対策) */}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span id="topbar-env-label">環境</span>
              <Select
                value={selectedEnv}
                onValueChange={onEnvChange}
                disabled={environments.length === 0}
              >
                <SelectTrigger size="sm" className="font-mono" aria-labelledby="topbar-env-label">
                  <SelectValue placeholder="(なし)" />
                </SelectTrigger>
                <SelectContent>
                  {environments.map((env) => (
                    <SelectItem key={env.name} value={env.name}>
                      {env.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Button type="button" onClick={onRun} disabled={!canRun || running}>
              <Play className="size-4" />
              <span>{running ? "実行中…" : "実行"}</span>
            </Button>

            <Button type="button" variant="outline" onClick={onShowHistory} aria-label="履歴を表示">
              <History className="size-4" />
              <span className="hidden sm:inline">履歴</span>
            </Button>
          </>
        )}
      </div>
    </header>
  );
}
