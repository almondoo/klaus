import { useEffect, useState } from "react";
import { getToken, onUnauthorized } from "./api/client";
import { AuthGuard } from "./components/AuthGuard";
import { HistoryBrowser } from "./components/HistoryBrowser";
import { RunView } from "./components/RunView";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { useEnvironments } from "./hooks/useEnvironments";
import { useFlowDetail } from "./hooks/useFlowDetail";
import { useFlows } from "./hooks/useFlows";
import { useRun } from "./hooks/useRun";
import "./App.css";

type Tab = "runner" | "history";

export function App() {
  const [authFailed, setAuthFailed] = useState(() => !getToken());

  useEffect(() => onUnauthorized(() => setAuthFailed(true)), []);

  const { flows, loading: flowsLoading, error: flowsError } = useFlows();
  const { environments } = useEnvironments();

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedEnv, setSelectedEnv] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("runner");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const {
    detail: flowDetail,
    loading: flowDetailLoading,
    error: flowDetailError,
  } = useFlowDetail(selectedPath ?? undefined);
  const run = useRun(flowDetail);

  // 環境の初期選択: フローの既定 env → 先頭の環境、の順で補う
  useEffect(() => {
    if (flowDetail?.env) {
      setSelectedEnv(flowDetail.env);
    } else if (!selectedEnv && environments.length > 0) {
      setSelectedEnv(environments[0]?.name ?? "");
    }
  }, [flowDetail, environments, selectedEnv]);

  if (authFailed) {
    return <AuthGuard />;
  }

  const canRun =
    Boolean(selectedPath) && !flowDetailLoading && !flowDetailError && flowDetail !== null;

  return (
    <div className="klaus-app">
      <Sidebar
        flows={flows}
        loading={flowsLoading}
        error={flowsError}
        selectedPath={selectedPath}
        onSelect={(path) => {
          setSelectedPath(path);
          setActiveTab("runner");
          setSidebarOpen(false);
        }}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="klaus-app__main">
        <TopBar
          mode={activeTab}
          flowName={flowDetail?.name ?? null}
          environments={environments}
          selectedEnv={selectedEnv}
          onEnvChange={setSelectedEnv}
          onRun={() => selectedPath && run.start(selectedPath, selectedEnv || undefined)}
          running={run.running}
          canRun={canRun}
          onOpenSidebar={() => setSidebarOpen(true)}
          onShowHistory={() => setActiveTab("history")}
          onBackToRunner={() => setActiveTab("runner")}
        />

        <div className="klaus-app__content">
          {activeTab === "runner" ? (
            <RunView
              flowDetail={flowDetail}
              flowDetailLoading={flowDetailLoading}
              flowDetailError={flowDetailError}
              run={run}
            />
          ) : (
            <HistoryBrowser flows={flows} />
          )}
        </div>
      </div>
    </div>
  );
}
