import { ArrowLeft, ClockCounterClockwise, List, Play } from "@phosphor-icons/react";
import type { EnvironmentListEntry } from "../api/client";
import "./TopBar.css";

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
    <header className="klaus-topbar">
      <div className="klaus-topbar__left">
        <button
          type="button"
          className="klaus-topbar__menu-btn"
          aria-label="フロー一覧を開く"
          onClick={onOpenSidebar}
        >
          <List size={20} weight="regular" />
        </button>

        {mode === "history" ? (
          <button type="button" className="klaus-topbar__back-btn" onClick={onBackToRunner}>
            <ArrowLeft size={20} weight="regular" />
            <span>実行ビューに戻る</span>
          </button>
        ) : (
          <h1 className="klaus-topbar__title">{flowName ?? "フローを選択してください"}</h1>
        )}
      </div>

      <div className="klaus-topbar__right">
        {mode === "runner" && (
          <>
            <label className="klaus-topbar__env">
              <span>環境</span>
              <select
                value={selectedEnv}
                onChange={(e) => onEnvChange(e.target.value)}
                disabled={environments.length === 0}
              >
                {environments.length === 0 && <option value="">(なし)</option>}
                {environments.map((env) => (
                  <option key={env.name} value={env.name}>
                    {env.name}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="klaus-btn klaus-btn--primary"
              onClick={onRun}
              disabled={!canRun || running}
            >
              <Play size={18} weight="regular" />
              <span>{running ? "実行中…" : "実行"}</span>
            </button>

            <button
              type="button"
              className="klaus-topbar__history-btn"
              onClick={onShowHistory}
              aria-label="履歴を表示"
            >
              <ClockCounterClockwise size={20} weight="regular" />
              <span>履歴</span>
            </button>
          </>
        )}
      </div>
    </header>
  );
}
