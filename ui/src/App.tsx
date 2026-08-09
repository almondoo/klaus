import { useEffect, useRef, useState } from "react";
import { getToken, onUnauthorized } from "@/api/client";
import { AuthGuard } from "@/components/AuthGuard";
import { EnvEditor } from "@/components/EnvEditor";
import { HistoryBrowser } from "@/components/HistoryBrowser";
import { RequestEditor } from "@/components/RequestEditor";
import { ResponseView } from "@/components/ResponseView";
import { RunView } from "@/components/RunView";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { useEnvironments } from "@/hooks/useEnvironments";
import { useFlowDetail } from "@/hooks/useFlowDetail";
import { useFlows } from "@/hooks/useFlows";
import { useRun } from "@/hooks/useRun";
import { useSingleRequest } from "@/hooks/useSingleRequest";

type Tab = "request" | "runner" | "history";

export function App() {
  const [authFailed, setAuthFailed] = useState(() => !getToken());

  useEffect(() => onUnauthorized(() => setAuthFailed(true)), []);

  const { flows, loading: flowsLoading, error: flowsError } = useFlows();
  const { environments } = useEnvironments();

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedEnv, setSelectedEnv] = useState("");
  // デフォルト画面は単発リクエスト実行(request)。フロー選択時のみ runner に切り替わる
  const [activeTab, setActiveTab] = useState<Tab>("request");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [envEditorOpen, setEnvEditorOpen] = useState(false);
  // capture 保存成功のたびにインクリメントし、EnvEditor の key に使うことで強制再マウント→
  // 再取得させる(開いたまま値を保存された場合の表示更新用。useEnvironmentDetail 自体に
  // 外部トリガーを追加すると影響範囲が広がるため、key による再マウントで代替する)
  const [envRefreshKey, setEnvRefreshKey] = useState(0);

  const {
    detail: flowDetail,
    loading: flowDetailLoading,
    error: flowDetailError,
  } = useFlowDetail(selectedPath ?? undefined);
  const run = useRun(flowDetail);
  const singleRequest = useSingleRequest();

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

  // 単発実行モード(デフォルト画面)は selectedPath を持たないため、上の effect は発火しない。
  // environments 読み込み後、まだ何も選択されていなければ一覧の先頭を初期選択する
  // (一度だけ。以後はユーザーの選択やフロー選択 effect による上書きを尊重する)
  const initializedDefaultEnvRef = useRef(false);
  useEffect(() => {
    if (initializedDefaultEnvRef.current) return;
    if (selectedEnv || environments.length === 0) return;
    setSelectedEnv(environments[0]?.name ?? "");
    initializedDefaultEnvRef.current = true;
  }, [selectedEnv, environments]);

  // 履歴画面から「前の画面に戻る」で復帰する先(request/runner のどちらだったか)を記録する
  const returnTabRef = useRef<Tab>("request");

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
          onShowRequest={() => setActiveTab("request")}
          onShowHistory={() => {
            returnTabRef.current = activeTab;
            setActiveTab("history");
          }}
          onBack={() => setActiveTab(returnTabRef.current)}
          envEditorOpen={envEditorOpen}
          onToggleEnvEditor={() => setEnvEditorOpen((open) => !open)}
        />

        {envEditorOpen && selectedEnv && (
          <EnvEditor
            key={envRefreshKey}
            envName={selectedEnv}
            onClose={() => setEnvEditorOpen(false)}
          />
        )}

        <div className="flex-1">
          {activeTab === "request" ? (
            <div className="flex flex-col gap-6 p-6 lg:flex-row lg:items-start">
              <div className="w-full lg:max-w-xl">
                <RequestEditor
                  onExecute={(request) => singleRequest.execute(request, selectedEnv || undefined)}
                  executing={singleRequest.loading}
                />
              </div>
              <div className="w-full flex-1">
                <ResponseView
                  loading={singleRequest.loading}
                  error={singleRequest.error}
                  result={singleRequest.result}
                  envName={selectedEnv || undefined}
                  onSaved={() => setEnvRefreshKey((k) => k + 1)}
                />
              </div>
            </div>
          ) : activeTab === "runner" ? (
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
