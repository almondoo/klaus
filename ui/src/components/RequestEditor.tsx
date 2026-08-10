import { Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { SingleRequestRequestBody } from "@/api/client";
import { LabeledSelect } from "@/components/LabeledSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectItem } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useRowId } from "@/hooks/useRowId";
import type { KeyValueRow } from "@/utils/request";
import { parseRequestBody, rowsToRecord } from "@/utils/request";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export interface RequestEditorProps {
  onExecute: (request: SingleRequestRequestBody["request"]) => void;
  executing: boolean;
}

/**
 * 単発リクエスト実行の入力フォーム。method/url/headers/query/body を編集し、実行ボタンで
 * onExecute に SingleRequestRequestBody["request"] を渡す。
 *
 * NOTE: 入力中の値はこのコンポーネント内のローカル state のみで保持する。App.tsx 側で
 * タブを切り替えるとこのコンポーネントはアンマウントされ、下書きはリセットされる
 * (実行結果自体は useSingleRequest が App.tsx で保持するため、タブを行き来しても消えない)。
 */
export function RequestEditor({ onExecute, executing }: RequestEditorProps) {
  const makeRowId = useRowId();

  const [method, setMethod] = useState("GET");
  const [url, setUrl] = useState("");
  // 初期行の id もリテラルではなく makeRowId から採番する
  // (リテラル "h-0" とカウンタ 0 始まりの組み合わせだと最初の行追加で id が衝突するため)
  const [headerRows, setHeaderRows] = useState<KeyValueRow[]>(() => [
    { id: makeRowId("h"), key: "", value: "" },
  ]);
  const [queryRows, setQueryRows] = useState<KeyValueRow[]>(() => [
    { id: makeRowId("q"), key: "", value: "" },
  ]);
  const [bodyText, setBodyText] = useState("");

  const canExecute = url.trim() !== "" && !executing;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canExecute) return;

    const headers = rowsToRecord(headerRows);
    const query = rowsToRecord(queryRows);
    const body = parseRequestBody(bodyText);

    onExecute({
      method,
      url,
      ...(headers ? { headers } : {}),
      ...(query ? { query } : {}),
      ...(body !== undefined ? { body } : {}),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex gap-2">
        <LabeledSelect
          labelId="request-editor-method-label"
          label="メソッド"
          srOnlyLabel
          triggerClassName="w-28 font-mono"
          value={method}
          onValueChange={setMethod}
        >
          {METHODS.map((m) => (
            <SelectItem key={m} value={m}>
              {m}
            </SelectItem>
          ))}
        </LabeledSelect>

        <div className="flex-1">
          <label htmlFor="request-editor-url" className="sr-only">
            URL
          </label>
          <Input
            id="request-editor-url"
            className="font-mono"
            placeholder="https://example.com/path または {{baseUrl}}/path"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
      </div>

      <KeyValueEditor
        legend="ヘッダー"
        rows={headerRows}
        keyLabel="ヘッダー名"
        valueLabel="ヘッダー値"
        keyPlaceholder="Content-Type"
        valuePlaceholder="application/json"
        onAdd={() => setHeaderRows((rows) => [...rows, { id: makeRowId("h"), key: "", value: "" }])}
        onRemove={(id) => setHeaderRows((rows) => rows.filter((row) => row.id !== id))}
        onChangeKey={(id, key) =>
          setHeaderRows((rows) => rows.map((row) => (row.id === id ? { ...row, key } : row)))
        }
        onChangeValue={(id, value) =>
          setHeaderRows((rows) => rows.map((row) => (row.id === id ? { ...row, value } : row)))
        }
      />

      <KeyValueEditor
        legend="クエリパラメータ"
        rows={queryRows}
        keyLabel="クエリパラメータ名"
        valueLabel="クエリパラメータ値"
        keyPlaceholder="page"
        valuePlaceholder="1"
        onAdd={() => setQueryRows((rows) => [...rows, { id: makeRowId("q"), key: "", value: "" }])}
        onRemove={(id) => setQueryRows((rows) => rows.filter((row) => row.id !== id))}
        onChangeKey={(id, key) =>
          setQueryRows((rows) => rows.map((row) => (row.id === id ? { ...row, key } : row)))
        }
        onChangeValue={(id, value) =>
          setQueryRows((rows) => rows.map((row) => (row.id === id ? { ...row, value } : row)))
        }
      />

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="request-editor-body"
          className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          ボディ(JSON または文字列。任意)
        </label>
        <Textarea
          id="request-editor-body"
          className="min-h-32 font-mono"
          placeholder='{"key": "value"}'
          value={bodyText}
          onChange={(event) => setBodyText(event.target.value)}
        />
      </div>

      <Button type="submit" disabled={!canExecute} className="self-start">
        <Play className="size-4" />
        <span>{executing ? "実行中…" : "実行"}</span>
      </Button>
    </form>
  );
}

interface KeyValueEditorProps {
  legend: string;
  rows: KeyValueRow[];
  keyLabel: string;
  valueLabel: string;
  keyPlaceholder: string;
  valuePlaceholder: string;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onChangeKey: (id: string, key: string) => void;
  onChangeValue: (id: string, value: string) => void;
}

/** headers/query 共用の行エディタ(行追加・削除)。key が空の行は送信時に自動的に除外される */
function KeyValueEditor({
  legend,
  rows,
  keyLabel,
  valueLabel,
  keyPlaceholder,
  valuePlaceholder,
  onAdd,
  onRemove,
  onChangeKey,
  onChangeValue,
}: KeyValueEditorProps) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {legend}
      </legend>

      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-2">
          <label htmlFor={`${row.id}-key`} className="sr-only">
            {keyLabel}
          </label>
          <Input
            id={`${row.id}-key`}
            className="flex-1 font-mono"
            placeholder={keyPlaceholder}
            value={row.key}
            onChange={(event) => onChangeKey(row.id, event.target.value)}
          />
          <label htmlFor={`${row.id}-value`} className="sr-only">
            {valueLabel}
          </label>
          <Input
            id={`${row.id}-value`}
            className="flex-1 font-mono"
            placeholder={valuePlaceholder}
            value={row.value}
            onChange={(event) => onChangeValue(row.id, event.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`${legend}の行を削除`}
            onClick={() => onRemove(row.id)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}

      <Button type="button" variant="outline" size="sm" onClick={onAdd} className="self-start">
        <Plus className="size-4" />
        <span>行を追加</span>
      </Button>
    </fieldset>
  );
}
