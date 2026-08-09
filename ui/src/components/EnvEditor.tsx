import { Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useEnvironmentDetail } from "@/hooks/useEnvironmentDetail";

export interface EnvEditorProps {
  envName: string;
  onClose: () => void;
}

interface EditableRow {
  /** key は編集可能なため React key には使えない。行ごとに採番した安定 id を使う */
  id: string;
  key: string;
  value: string;
}

let nextRowId = 0;
function makeRow(key = "", value = ""): EditableRow {
  nextRowId += 1;
  return { id: `row-${nextRowId}`, key, value };
}

/**
 * 選択中 env の key-value をテーブルで編集するパネル。
 * TopBar の編集ボタンから開閉し、メインエリア上部にシンプルなパネルとして表示する。
 */
export function EnvEditor({ envName, onClose }: EnvEditorProps) {
  const { detail, loading, error, saving, saveError, save } = useEnvironmentDetail(
    envName || undefined,
  );
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [dirty, setDirty] = useState(false);

  // detail の取得(初回・reload)完了時にローカル編集状態を作り直す。
  // 保存成功時も useEnvironmentDetail 側で detail が更新されるため、ここで dirty をリセットする。
  useEffect(() => {
    if (detail) {
      setRows(Object.entries(detail.values).map(([k, v]) => makeRow(k, v)));
      setDirty(false);
    }
  }, [detail]);

  const updateRow = (id: string, patch: Partial<Pick<EditableRow, "key" | "value">>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setDirty(true);
  };

  const removeRow = (id: string) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
    setDirty(true);
  };

  const addRow = () => {
    setRows((prev) => [...prev, makeRow()]);
    setDirty(true);
  };

  const handleSave = async () => {
    // 空キー行は保存対象外(削除ボタンで消す想定だが、消し忘れても無視する)
    const values: Record<string, string> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (!key) continue;
      values[key] = row.value;
    }
    const ok = await save(values);
    if (ok) setDirty(false);
  };

  return (
    <div className="border-b border-border bg-popover px-4 py-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-sans text-sm font-semibold">
          環境を編集: <span className="font-mono">{envName}</span>
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="環境の編集を閉じる"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      {loading && (
        <div role="status" aria-label="環境を読み込み中" className="flex flex-col gap-1.5">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}

      {error && <p className="text-sm text-fail">{error}</p>}

      {!loading && !error && (
        <div className="flex flex-col gap-3">
          <div className="overflow-hidden rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow className="bg-popover hover:bg-popover">
                  <TableHead>キー</TableHead>
                  <TableHead>値</TableHead>
                  <TableHead className="w-11">
                    <span className="sr-only">削除</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} className="bg-card hover:bg-muted">
                    <TableCell>
                      <Input
                        aria-label="キー"
                        value={row.key}
                        onChange={(e) => updateRow(row.id, { key: e.target.value })}
                        className="font-mono"
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        aria-label="値"
                        value={row.value}
                        onChange={(e) => updateRow(row.id, { value: e.target.value })}
                        className="font-mono"
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`${row.key || "この行"}を削除`}
                        onClick={() => removeRow(row.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="whitespace-normal text-muted-foreground">
                      key がありません。「行を追加」から追加してください
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" onClick={addRow}>
              <Plus className="size-4" />
              行を追加
            </Button>
            <Button type="button" onClick={handleSave} disabled={saving || !dirty}>
              {saving ? "保存中…" : "保存"}
            </Button>
            {saveError && <p className="text-sm text-fail">{saveError}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
