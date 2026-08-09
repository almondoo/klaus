import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import type { StepResult } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCaptureToEnvironment } from "@/hooks/useCaptureToEnvironment";
import { formatDuration } from "@/utils/format";
import { JsonBlock } from "./JsonBlock";
import { Spinner } from "./Spinner";
import { StatusBadge } from "./StatusBadge";

export interface ResponseViewProps {
  loading: boolean;
  /** ネットワークエラーや 4xx/5xx など、apiFetchJson が投げた通信レベルのエラー */
  error: string | null;
  result: StepResult | null;
  /** レスポンスの抽出値を保存する対象の env 名(TopBar の env セレクタと同期。未選択時は保存不可) */
  envName?: string | undefined;
  /** env への保存に成功した直後に呼ばれる(EnvEditor を開いている場合の表示更新のトリガー用) */
  onSaved?: (() => void) | undefined;
}

/**
 * 単発リクエスト実行の結果表示: ステータス・所要時間・レスポンスヘッダー・ボディ。
 * StepRow.tsx の request/response 表示パターン(見出し + JsonBlock)を踏襲する。
 * レスポンスボディがある場合のみ、JSONPath で値を抽出して env に保存するセクションを表示する。
 */
export function ResponseView({ loading, error, result, envName, onSaved }: ResponseViewProps) {
  // 早期 return より前でフックを呼ぶ(Rules of Hooks)。result が無い間も captureJsonPath 等の
  // 入力状態は保持して構わない(実行ごとにリセットする必要は無い簡易な下書き扱い)。
  const [captureKey, setCaptureKey] = useState("");
  const [capturePath, setCapturePath] = useState("");
  const capture = useCaptureToEnvironment();

  if (loading) {
    return <Spinner label="リクエストを実行中…" />;
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-fail/30 bg-fail/12 p-3 text-sm text-fail">
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        <span>{error}</span>
      </div>
    );
  }

  if (!result) {
    return (
      <p className="text-sm text-muted-foreground">
        左のフォームを入力して「実行」を押すと、ここに結果が表示されます。
      </p>
    );
  }

  const responseBody = result.response?.body;
  const canCapture = Boolean(envName) && captureKey.trim() !== "" && capturePath.trim() !== "";

  async function handleCapture(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!envName || !canCapture) return;
    const saved = await capture.capture(
      envName,
      captureKey.trim(),
      capturePath.trim(),
      responseBody,
    );
    if (saved) onSaved?.();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={result.status} />
        {result.response && (
          <span className="font-mono text-sm text-muted-foreground">
            HTTP {result.response.status}
          </span>
        )}
        <span className="font-mono text-sm text-muted-foreground">
          {formatDuration(result.durationMs)}
        </span>
      </div>

      {result.error && <p className="text-sm text-fail">{result.error}</p>}

      {result.response && (
        <div>
          <h2 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            レスポンスヘッダー
          </h2>
          <JsonBlock value={result.response.headers} />
        </div>
      )}

      {result.response && (
        <div>
          <h2 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            レスポンスボディ
          </h2>
          <JsonBlock value={result.response.body} />
        </div>
      )}

      {result.response && (
        <form
          onSubmit={handleCapture}
          className="flex flex-col gap-2 rounded-md border border-border bg-popover p-3"
        >
          <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            レスポンスから env に保存
          </h2>

          <p className="text-xs text-muted-foreground">
            値は environments/*.yaml に平文で保存され、そのファイルが git 管理下であれば
            そのままコミットされます。シークレット相当の値は .gitignore 済みの env
            を使ってください。
          </p>

          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex-1">
              <label htmlFor="capture-path" className="sr-only">
                JSONPath
              </label>
              <Input
                id="capture-path"
                className="font-mono"
                placeholder="$.token"
                value={capturePath}
                onChange={(event) => {
                  setCapturePath(event.target.value);
                  capture.reset();
                }}
              />
            </div>
            <div className="flex-1">
              <label htmlFor="capture-key" className="sr-only">
                保存先キー名
              </label>
              <Input
                id="capture-key"
                className="font-mono"
                placeholder="保存先キー名(例: token)"
                value={captureKey}
                onChange={(event) => {
                  setCaptureKey(event.target.value);
                  capture.reset();
                }}
              />
            </div>
            <Button type="submit" disabled={!canCapture || capture.saving}>
              {capture.saving ? "保存中…" : "保存"}
            </Button>
          </div>

          {!envName && (
            <p className="text-xs text-muted-foreground">
              env が選択されていません。TopBar で保存先の env を選択してください。
            </p>
          )}
          {capture.error && <p className="text-sm text-fail">{capture.error}</p>}
          {capture.savedKey && (
            <p className="text-sm text-pass">
              env "{envName}" のキー "{capture.savedKey}" に保存しました。
            </p>
          )}
        </form>
      )}
    </div>
  );
}
