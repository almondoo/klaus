import { useEffect, useRef, useState } from "react";
import { getToken, onUnauthorized } from "@/api/client";
import { AuthGuard } from "@/components/AuthGuard";
import { HistoryBrowser } from "@/components/HistoryBrowser";
import { RunView } from "@/components/RunView";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { useEnvironments } from "@/hooks/useEnvironments";
import { useFlowDetail } from "@/hooks/useFlowDetail";
import { useFlows } from "@/hooks/useFlows";
import { useRun } from "@/hooks/useRun";

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

  // selectedPath ごとに初期 env をすでに適用したかどうかを記録する(下記 effect 参照)
  const initializedEnvForPathRef = useRef<string | null>(null);

  // 環境の初期選択: フローが切り替わった(selectedPath が変わった)時に一度だけ、
  // フローの既定 env → 環境一覧の先頭、の順で初期選択を適用する。
  //
  // 回帰防止コメント: 以前は selectedEnv 自体をこの effect の依存配列に含めていたため、
  // ユーザーが TopBar の環境セレクタを変更するたびにこの effect が再実行され、
  // flowDetail.env がある限り毎回そこへ selectedEnv を巻き戻していた
  // (「フロー選択後に環境セレクタを変えても即座に元に戻る」バグ)。
  // selectedEnv を依存配列からも effect 本体からも完全に外し、「同じ selectedPath に
  // 対しては1回しか初期化しない」ことを ref で明示的に管理することで、
  // ユーザーによる変更を以後尊重するようにする。
  useEffect(() => {
    if (!selectedPath || !flowDetail) return;
    if (initializedEnvForPathRef.current === selectedPath) return;

    if (flowDetail.env) {
      setSelectedEnv(flowDetail.env);
      initializedEnvForPathRef.current = selectedPath;
    } else if (environments.length > 0) {
      setSelectedEnv(environments[0]?.name ?? "");
      initializedEnvForPathRef.current = selectedPath;
    }
    // environments の読み込みがフロー選択より遅れた場合は、読み込み完了後にこの
    // effect が再実行されて初めて初期化される(その間は上の early return で待機する)
  }, [selectedPath, flowDetail, environments]);

  if (authFailed) {
    return <AuthGuard />;
  }

  const canRun =
    Boolean(selectedPath) && !flowDetailLoading && !flowDetailError && flowDetail !== null;

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
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

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
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

        <div className="flex-1">
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
