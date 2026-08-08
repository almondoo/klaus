import { WarningCircle, X } from "@phosphor-icons/react";
import type { FlowListEntry } from "../api/client";
import { Spinner } from "./Spinner";
import "./Sidebar.css";

export interface SidebarProps {
  flows: FlowListEntry[];
  loading: boolean;
  error: string | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  open: boolean;
  onClose: () => void;
}

/** フロー一覧サイドバー(240–280px 固定。768px 未満ではドロワー化) */
export function Sidebar({
  flows,
  loading,
  error,
  selectedPath,
  onSelect,
  open,
  onClose,
}: SidebarProps) {
  return (
    <>
      {open && (
        <button
          type="button"
          className="klaus-sidebar-overlay"
          aria-label="サイドバーを閉じる"
          onClick={onClose}
        />
      )}
      <nav className={`klaus-sidebar ${open ? "klaus-sidebar--open" : ""}`} aria-label="フロー一覧">
        <div className="klaus-sidebar__header">
          <span>フロー</span>
          <button
            type="button"
            className="klaus-sidebar__close"
            aria-label="サイドバーを閉じる"
            onClick={onClose}
          >
            <X size={20} weight="regular" />
          </button>
        </div>

        {loading && (
          <div className="klaus-sidebar__status">
            <Spinner label="フロー一覧を読み込み中" />
            <span>読み込み中…</span>
          </div>
        )}

        {error && <div className="klaus-sidebar__status klaus-sidebar__status--error">{error}</div>}

        {!loading && !error && flows.length === 0 && (
          <div className="klaus-sidebar__status">フローが見つかりません</div>
        )}

        <ul className="klaus-sidebar__list">
          {flows.map((flow) => (
            <li key={flow.path}>
              <button
                type="button"
                className={`klaus-sidebar__item ${
                  flow.path === selectedPath ? "klaus-sidebar__item--active" : ""
                }`}
                onClick={() => !flow.error && onSelect(flow.path)}
                disabled={Boolean(flow.error)}
                aria-disabled={Boolean(flow.error)}
                title={flow.error ?? flow.path}
              >
                <span className="klaus-sidebar__item-main">
                  <span className="klaus-sidebar__item-name">
                    {flow.error && (
                      <WarningCircle
                        size={16}
                        weight="regular"
                        className="klaus-sidebar__item-error-icon"
                        aria-hidden="true"
                      />
                    )}
                    {flow.name ?? flow.path}
                  </span>
                  <span className="klaus-sidebar__item-path">{flow.path}</span>
                </span>
                {flow.error && <span className="klaus-sidebar__item-error-text">{flow.error}</span>}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
