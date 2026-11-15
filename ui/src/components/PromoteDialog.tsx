import { AlertTriangle, CheckCircle2, X, XCircle } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { PromoteResponse } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { type PromoteFailure, usePromotePreview, usePromoteSave } from "@/hooks/usePromote";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/utils/format";
import type { HistoryRunGroup } from "@/utils/history";
import {
  ASSERT_OPTIONS,
  buildPromoteBody,
  DEFAULT_PROMOTE_FORM,
  describeRedactionReason,
  distinctFlowNames,
  explainPromoteError,
  orderedRunIds,
  type PromoteForm,
  validateBaseUrlVar,
} from "@/utils/promote";
import { Spinner } from "./Spinner";

export interface PromoteDialogProps {
  /** 保存の元にする run(履歴の run 行)。フローのステップは実行順(古い順)に並ぶ */
  groups: HistoryRunGroup[];
  onClose: () => void;
}

/** 入力が止まってからプレビューを取り直すまでの待ち時間(入力のたびに API を呼ばない) */
const PREVIEW_DEBOUNCE_MS = 400;

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-semibold">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-fail">
          {error}
        </p>
      )}
    </div>
  );
}

function ReviewSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-3">
      <h3 className="text-xs font-semibold">{title}</h3>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {children}
    </section>
  );
}

/** 生成結果の確認項目(置き換えるべき値・検証すべき推論・注意)。保存前にすべて見せる */
function PreviewReview({ preview }: { preview: PromoteResponse }) {
  return (
    <div className="flex flex-col gap-3">
      {preview.placeholders.length > 0 && (
        <ReviewSection
          title="実行前に設定する OS 環境変数"
          description="履歴ではマスクされていた値です。フローを実行する前に、同名の OS 環境変数として設定してください。"
        >
          <ul className="flex flex-col gap-1">
            {preview.placeholders.map((placeholder) => (
              <li key={placeholder.name} className="text-xs">
                <code className="font-mono font-semibold">{placeholder.name}</code>
                <span className="text-muted-foreground"> — {placeholder.locations.join("、")}</span>
              </li>
            ))}
          </ul>
        </ReviewSection>
      )}

      {preview.variables.length > 0 && (
        <ReviewSection
          title="環境ファイルに定義する変数"
          description="ベース URL を変数に置き換えました。environments/ の環境ファイルに次の値を定義してください。"
        >
          <ul className="flex flex-col gap-1">
            {preview.variables.map((variable) => (
              <li key={variable.name} className="text-xs">
                <code className="font-mono font-semibold">{variable.name}</code>
                <span className="text-muted-foreground"> = </span>
                <code className="font-mono break-all">{variable.value}</code>
              </li>
            ))}
          </ul>
        </ReviewSection>
      )}

      {preview.redacted.length > 0 && (
        <ReviewSection
          title="秘密情報らしいためプレースホルダーに置き換えた値"
          description="リテラルとしては保存していません。上の OS 環境変数に実際の値を設定してください。"
        >
          <ul className="flex flex-col gap-1">
            {preview.redacted.map((item) => (
              <li key={`${item.name}:${item.location}`} className="text-xs">
                <code className="font-mono font-semibold">{item.name}</code>
                <span className="text-muted-foreground">
                  {" "}
                  — {item.location}({describeRedactionReason(item.reason)})
                </span>
              </li>
            ))}
          </ul>
        </ReviewSection>
      )}

      {preview.captures.length > 0 && (
        <ReviewSection
          title="推論したキャプチャ(つながりを確認してください)"
          description="先行ステップのレスポンスの値が後続のリクエストにそのまま現れたため、キャプチャでつなぎました。偶然の一致でないか確認してください。"
        >
          <ul className="flex flex-col gap-1">
            {preview.captures.map((capture) => (
              <li
                key={`${capture.name}:${capture.from.step}:${capture.from.path}`}
                className="text-xs"
              >
                <code className="font-mono font-semibold">{capture.name}</code>
                <span className="text-muted-foreground"> — ステップ「{capture.from.step}」の </span>
                <code className="font-mono">{capture.from.path}</code>
                <span className="text-muted-foreground">
                  {" "}
                  →{" "}
                  {capture.used
                    .map((use) => `ステップ「${use.step}」の ${use.location}`)
                    .join("、")}
                </span>
              </li>
            ))}
          </ul>
        </ReviewSection>
      )}

      {preview.skipped.length > 0 && (
        <ReviewSection title="スキップしたステップ">
          <ul className="flex flex-col gap-1">
            {preview.skipped.map((item) => (
              <li key={`${item.runId}:${item.flow}:${item.step}`} className="text-xs">
                <code className="font-mono">{item.step}</code>
                <span className="text-muted-foreground"> — {item.reason}</span>
              </li>
            ))}
          </ul>
        </ReviewSection>
      )}

      {preview.notes.length > 0 && (
        <ReviewSection title="補足">
          <ul className="list-disc pl-5">
            {preview.notes.map((note) => (
              <li key={note} className="text-xs">
                {note}
              </li>
            ))}
          </ul>
        </ReviewSection>
      )}

      <p className="flex items-start gap-2 rounded-md border border-skipped/40 bg-skipped/10 p-3 text-xs">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-skipped" />
        <span>
          <span className="font-semibold">コミット前に確認してください: </span>
          記録した通信から生成したファイルです。トークン、パスワード、個人情報などの機微な値が残っていないか確認してください。
          <span className="mt-1 block font-mono text-muted-foreground">{preview.notice}</span>
        </span>
      </p>
    </div>
  );
}

function FailureNotice({ failure }: { failure: PromoteFailure }) {
  const explanation = explainPromoteError(failure.status, failure.message, failure.code);
  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 rounded-md border border-fail/40 bg-fail/10 p-3"
    >
      <p className="flex items-start gap-2 text-sm font-semibold">
        <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fail" />
        {explanation.title}
      </p>
      <p className="font-mono text-xs break-all text-muted-foreground">{explanation.detail}</p>
      {explanation.hint && <p className="text-xs">{explanation.hint}</p>}
    </div>
  );
}

/**
 * 履歴の run から新しいフローを作るダイアログ。
 * 入力のたびに dryRun でプレビュー(YAML と確認項目)を取り直し、「保存」で新規ファイルとして書き込む。
 * 既存のフローは編集・上書きしない(同じ場所にファイルがあれば保存は拒否される)。
 * ネイティブの <dialog>(showModal)を使い、フォーカストラップ・Esc で閉じる動作をブラウザに任せる。
 */
export function PromoteDialog({ groups, onClose }: PromoteDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const ids = useId();
  const runIds = useMemo(() => orderedRunIds(groups), [groups]);
  const flowNames = useMemo(() => distinctFlowNames(groups), [groups]);
  const flowRequired = flowNames.length > 1;

  const [form, setForm] = useState<PromoteForm>({
    ...DEFAULT_PROMOTE_FORM,
    flow: flowNames.length === 1 ? (flowNames[0] as string) : "",
  });
  const debouncedForm = useDebouncedValue(form, PREVIEW_DEBOUNCE_MS);
  const update = (patch: Partial<PromoteForm>) => setForm((current) => ({ ...current, ...patch }));

  const baseUrlVarError = validateBaseUrlVar(form.baseUrlVar);
  const debouncedInvalid = validateBaseUrlVar(debouncedForm.baseUrlVar) !== null;
  const previewBody =
    runIds.length === 0 || (flowRequired && debouncedForm.flow === "") || debouncedInvalid
      ? null
      : buildPromoteBody(runIds, debouncedForm, true);
  const preview = usePromotePreview(previewBody);
  const saver = usePromoteSave();

  // 入力が変わったら、前回の保存失敗の表示は消す(直した入力で再度保存できるように)
  // biome-ignore lint/correctness/useExhaustiveDependencies: form が変わったときだけ失敗表示を消す
  useEffect(() => {
    saver.reset();
  }, [form]);

  // マウント時にモーダルとして開く(Esc・閉じるボタンで close → onClose)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  // 入力の変更がまだプレビューに反映されていない間は保存させない(プレビューと保存内容のずれを防ぐ)
  const inSync =
    JSON.stringify(buildPromoteBody(runIds, form, true)) === JSON.stringify(previewBody);
  const saved = saver.saved;
  const previewData = preview.preview;
  const previewFailure = preview.failure;
  const previewExplanation = previewFailure
    ? explainPromoteError(previewFailure.status, previewFailure.message, previewFailure.code)
    : null;
  const saveExplanation = saver.failure
    ? explainPromoteError(saver.failure.status, saver.failure.message, saver.failure.code)
    : null;
  const outFieldError = [previewExplanation, saveExplanation].find(
    (explanation) => explanation?.field === "out",
  );
  // 保存先の欄に結び付かない失敗(保存の失敗を優先して 1 つ表示する)
  const generalFailure =
    saver.failure && saveExplanation?.field !== "out"
      ? saver.failure
      : previewFailure && previewExplanation?.field !== "out"
        ? previewFailure
        : undefined;

  const canSave =
    !saved &&
    !saver.saving &&
    inSync &&
    !preview.loading &&
    previewData !== undefined &&
    previewData.exists !== true &&
    previewFailure === null &&
    baseUrlVarError === null;

  const handleSave = async () => {
    if (!canSave) return;
    await saver.save(buildPromoteBody(runIds, form, false));
  };

  const inputsDisabled = saved !== null || saver.saving;

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto max-h-[calc(100vh-2rem)] w-[min(56rem,calc(100vw-2rem))] overflow-hidden rounded-md border border-border bg-popover p-0 text-foreground backdrop:bg-black/60"
    >
      <div className="flex max-h-[calc(100vh-2rem)] flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2 id={titleId} className="text-sm font-semibold">
            フローとして保存
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="ダイアログを閉じる"
            onClick={() => dialogRef.current?.close()}
          >
            <X aria-hidden="true" className="size-4" />
          </Button>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 py-4">
          <p className="text-xs text-muted-foreground">
            履歴の {runIds.length} 件の run
            から、新しいフローのファイルを作ります。既存のフローは変更せず、同じ場所にファイルがあれば上書きせずに拒否します。
          </p>

          <section aria-label="保存の元にする run">
            <ol className="flex flex-col gap-1 rounded-md border border-border bg-card p-3">
              {[...groups]
                .sort((x, y) => x.startedAt.localeCompare(y.startedAt))
                .map((group) => (
                  <li
                    key={`${group.runId}:${group.iteration ?? 0}`}
                    className="flex flex-wrap gap-x-3 text-xs"
                  >
                    <span className="font-mono">{group.flow}</span>
                    <span className="font-mono text-muted-foreground">
                      {formatDateTime(group.startedAt)}
                    </span>
                    <span className="font-mono text-muted-foreground">{group.runId}</span>
                  </li>
                ))}
            </ol>
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <fieldset className="flex flex-col gap-2 md:col-span-2" disabled={inputsDisabled}>
              <legend className="mb-1 text-xs font-semibold">アサーション</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {ASSERT_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={cn(
                      "flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-xs",
                      form.assert === option.value && "bg-secondary",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${ids}-assert`}
                      value={option.value}
                      checked={form.assert === option.value}
                      onChange={() => update({ assert: option.value })}
                      className="mt-0.5 accent-primary"
                    />
                    <span>
                      <span className="block font-mono font-semibold">{option.label}</span>
                      <span className="text-muted-foreground">{option.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {flowRequired && (
              <Field
                id={`${ids}-flow`}
                label="対象のフロー"
                hint="選んだ run が複数のフローを含むため、保存するフローを 1 つ選んでください"
              >
                <select
                  id={`${ids}-flow`}
                  value={form.flow}
                  disabled={inputsDisabled}
                  onChange={(event) => update({ flow: event.target.value })}
                  className="h-11 rounded-md border border-input bg-popover px-3 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <option value="">選択してください</option>
                  {flowNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field
              id={`${ids}-base`}
              label="ベース URL の変数名(任意)"
              hint="指定すると、URL の origin を {{変数名}} に置き換えます"
              error={baseUrlVarError ?? undefined}
            >
              <Input
                id={`${ids}-base`}
                value={form.baseUrlVar}
                disabled={inputsDisabled}
                placeholder="baseUrl"
                aria-invalid={baseUrlVarError !== null}
                onChange={(event) => update({ baseUrlVar: event.target.value })}
                className="font-mono"
              />
            </Field>

            <Field
              id={`${ids}-name`}
              label="フロー名(任意)"
              hint="空なら記録されたフロー名から決めます"
            >
              <Input
                id={`${ids}-name`}
                value={form.name}
                disabled={inputsDisabled}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>

            <Field
              id={`${ids}-out`}
              label="保存先(任意)"
              hint={
                previewData
                  ? `保存先: ${previewData.file}(空なら提案パスを使います)`
                  : "カレントディレクトリからの相対パス(.yaml / .yml)。空なら提案パスを使います"
              }
              error={
                outFieldError
                  ? `${outFieldError.title}: ${outFieldError.detail}${outFieldError.hint ? ` ${outFieldError.hint}` : ""}`
                  : undefined
              }
            >
              <Input
                id={`${ids}-out`}
                value={form.out}
                disabled={inputsDisabled}
                placeholder={previewData?.file ?? "flows/my-flow.yaml"}
                aria-invalid={outFieldError !== undefined}
                onChange={(event) => update({ out: event.target.value })}
                className="font-mono"
              />
            </Field>

            <label className="flex cursor-pointer items-start gap-2 text-xs md:col-span-2">
              <input
                type="checkbox"
                checked={form.chain}
                disabled={inputsDisabled}
                onChange={(event) => update({ chain: event.target.checked })}
                className="mt-0.5 accent-primary"
              />
              <span>
                <span className="font-semibold">ステップ間のつながりを推論する</span>
                <span className="block text-muted-foreground">
                  先行ステップのレスポンスの値が後続のリクエストに現れたら、キャプチャで受け渡します
                </span>
              </span>
            </label>
          </div>

          {flowRequired && form.flow === "" && (
            <p className="text-xs text-muted-foreground">
              対象のフローを選ぶと、生成結果のプレビューを表示します
            </p>
          )}

          {generalFailure && <FailureNotice failure={generalFailure} />}

          {(preview.loading || !inSync) && previewBody !== null && !previewFailure && (
            <div
              role="status"
              aria-label="プレビューを更新中"
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Spinner label="プレビューを更新中" />
              プレビューを更新中…
            </div>
          )}

          {preview.loading && !previewData && !previewFailure && (
            <Skeleton className="h-40 w-full" />
          )}

          {previewData && (
            <div
              className={cn("flex flex-col gap-4", !inSync && "opacity-60")}
              aria-busy={preview.loading || !inSync}
            >
              {previewData.exists && !saved && (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-fail/40 bg-fail/10 p-3 text-xs"
                >
                  <XCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fail" />
                  <span>
                    <code className="font-mono">{previewData.file}</code>{" "}
                    には既にファイルがあります。既存のフローは上書きしないため、保存先かフロー名を変えてください。
                  </span>
                </p>
              )}

              <section className="flex flex-col gap-1.5">
                <h3 className="text-xs font-semibold">
                  生成されるフロー YAML(
                  <span className="font-mono">{previewData.file}</span>)
                </h3>
                <textarea
                  readOnly
                  wrap="off"
                  rows={14}
                  aria-label="生成されるフロー YAML"
                  value={previewData.yaml}
                  className="max-h-80 overflow-auto rounded-sm border border-border bg-background p-3 font-mono text-xs leading-relaxed whitespace-pre resize-y"
                />
              </section>

              <PreviewReview preview={previewData} />
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-3">
          {saved ? (
            <p role="status" className="flex items-center gap-2 text-sm">
              <CheckCircle2 aria-hidden="true" className="size-4 text-pass" />
              <span>
                <code className="font-mono">{saved.file}</code>{" "}
                に保存しました。サイドバーのフロー一覧に追加されます。
              </span>
            </p>
          ) : (
            <Button type="button" onClick={handleSave} disabled={!canSave}>
              {saver.saving ? "保存中…" : "保存"}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={() => dialogRef.current?.close()}>
            {saved ? "閉じる" : "キャンセル"}
          </Button>
          {saveExplanation && saveExplanation.field !== "out" && !saved && (
            <span className="text-xs text-fail">
              保存できませんでした(詳細は上の説明を確認してください)
            </span>
          )}
        </div>
      </div>
    </dialog>
  );
}
