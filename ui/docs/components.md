---
tags:
  - dev-tools/api-testing
  - design
  - frontend
  - ui-ux
created: 2026-08-08
source:
---

# klaus UI コンポーネント設計

> [!summary] この文書の役割
> `ui/src/components/**` の実装から抽出した、プリミティブ構成・機能コンポーネントの責務・状態管理方針。デザイントークンは [design-system.md](./design-system.md) を参照。

## 導入済み shadcn プリミティブ

`ui/src/components/ui/` に実装済みのもの。すべて `data-slot` 属性を持つ shadcn 標準パターン。

| プリミティブ | ファイル | klaus での使用箇所 |
|---|---|---|
| `Badge` | `badge.tsx` | `StatusBadge` の基盤。variant: `default` / `secondary` / `destructive` / `outline` / `pass` / `fail` / `running` / `skipped` / `pending` |
| `Button` | `button.tsx` | `TopBar`(実行・履歴・サイドバー開閉)、`Sidebar`(閉じる)、`HistoryBrowser`(さらに読み込む)、`RunView` 系全般 |
| `Card` / `CardHeader` / `CardTitle` / `CardContent` | `card.tsx` | `AuthGuard` の接続不可案内カードのみ |
| `Collapsible` / `CollapsibleTrigger` / `CollapsibleContent` | `collapsible.tsx` | `StepRow` の展開・折り畳み |
| `Progress` | `progress.tsx` | `RunView` の全体進捗バー(`Step n / m`) |
| `ScrollArea` / `ScrollBar` | `scroll-area.tsx` | `Sidebar` のフロー一覧スクロール |
| `Select` / `SelectContent` / `SelectItem` / `SelectTrigger` / `SelectValue` | `select.tsx` | `TopBar` の環境セレクタ、`HistoryBrowser` のフローフィルタ |
| `Separator` | `separator.tsx` | 導入済みだが**現状どの機能コンポーネントからも未使用**(将来のセクション区切り用に予約) |
| `Skeleton` | `skeleton.tsx` | `Sidebar` / `HistoryBrowser` の読み込み中プレースホルダー |
| `Table` / `TableHeader` / `TableBody` / `TableRow` / `TableHead` / `TableCell` | `table.tsx` | `HistoryBrowser` の履歴テーブル |
| `Tooltip` / `TooltipTrigger` / `TooltipContent` | `tooltip.tsx` | `Sidebar` のパースエラー理由表示 |

## 機能コンポーネントの責務

`ui/src/components/*.tsx`。

| コンポーネント | 表示内容 | 使用する hook / API |
|---|---|---|
| `App`(`src/App.tsx`) | 画面全体のレイアウト、`runner`/`history` タブ切り替え、env セレクタの初期化ロジックを保持するルート | `useFlows` / `useEnvironments` / `useFlowDetail` / `useRun`、`api/client` の `getToken` / `onUnauthorized` |
| `AuthGuard` | token が無い/401 時の「接続できません」案内画面 | props なし(`App` が表示可否を制御) |
| `Sidebar` | フロー一覧(固定 260px、768px 未満はドロワー化)。パースエラーのあるフローはアイコン + ツールチップで表示 | props 経由(`App` から `flows`/`loading`/`error` を受け取る) |
| `TopBar` | メイン領域上部の固定バー。環境セレクタ・実行ボタン・履歴切り替え | props 経由(`App` から `environments`/`selectedEnv`/`running` 等を受け取る) |
| `RunView` | 実行ビュー: ステップ縦リスト + 全体進捗(`Progress`)+ 完了サマリー | `UseRunResult`(`useRun` の戻り値)を props で受け取る |
| `StepRow` | 実行ビューの1ステップ行。失敗/エラー時は初回のみ自動展開、成功時はデフォルト折り畳み | `RunStepView`(`useRun` の型)を props で受け取り、`JsonBlock` / `StatusBadge` を組み合わせる |
| `HistoryBrowser` | 履歴テーブル(run 単位グルーピング → ステップ詳細ドリルダウン)、フローフィルタ、`before` カーソルページング | `useHistory`、`utils/history` の `groupHistoryByRun` |
| `StatusBadge` | ステータスを色 + アイコン + テキストの3重表現で示すバッジ | `RunStepStatus` 型(`useRun` 由来)を props で受け取るのみ |
| `JsonBlock` | リクエスト/レスポンス JSON のシンタックスハイライト表示(自前トークナイザ、依存追加なし) | `value` prop のみ。API・hook への依存なし |
| `Spinner` | 300ms を超える待ちに必ず出す実行中インジケータ(`prefers-reduced-motion` でも回転を維持) | props なし(`label` のみ) |

## 状態管理の方針

React 標準(`useState` / `useReducer` + カスタム hooks)のみで実装している。Redux / Zustand / TanStack Query 等の外部状態管理ライブラリは `package.json` の dependencies に存在せず、未導入。`docs/ui-design.md` の「状態管理はまず React 標準で開始し、複雑化した時点で外部ライブラリを検討する」という方針どおり、現時点でも標準のままで足りている。

`ui/src/hooks/` の一覧:

| hook | 役割 |
|---|---|
| `useFlows.ts` | `GET /api/flows` を読み込み、フロー一覧・loading・error・`reload()` を返す |
| `useFlowDetail.ts` | `GET /api/flows/detail` を読み込み、1フローのパース済み定義を返す。`path` が未確定の間は何もしない |
| `useEnvironments.ts` | `GET /api/environments` を読み込み、環境名一覧を返す |
| `useRun.ts` | `POST /api/runs` の SSE ストリームを購読し、ステップ単位の進捗状態(`pending → running → passed/failed/...`)・完了数・実行制御(`start`/`cancel`)を返す |
| `useHistory.ts` | `GET /api/history` を `before` カーソルでページング読み込みする |

## env セレクタの初期化ルール(重要な仕様)

フロー(`FlowDetail.env`)の既定環境は、**フロー切替時に一度だけ**適用し、以降のユーザーによる環境セレクタ操作を上書きしない。

実装は `App.tsx`(35–61 行目)の `initializedEnvForPathRef`(`useRef<string | null>`)で管理する:

```ts
// selectedPath ごとに初期 env をすでに適用したかどうかを記録する
const initializedEnvForPathRef = useRef<string | null>(null);

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
}, [selectedPath, flowDetail, environments]);
```

- 初期選択の優先順位: `flowDetail.env`(フロー YAML の `env:`)→ なければ環境一覧の先頭
- `selectedEnv` はこの effect の依存配列にも本体にも**含めない**。「同じ `selectedPath` に対しては1回しか初期化しない」ことを ref で明示的に管理する
- `environments` の読み込みがフロー選択より遅れた場合は、`environments` が更新されて effect が再実行されたタイミングで初めて初期化される(それまでは先頭の early return で待機)

### なぜこの設計か(過去の無限リバートのバグ)

以前は `selectedEnv` 自体をこの effect の依存配列に含めていた。そのため、ユーザーが `TopBar` の環境セレクタを変更するたびにこの effect が再実行され、`flowDetail.env` が存在する限り毎回そこへ `selectedEnv` を巻き戻していた——「フロー選択後に環境セレクタを変えても即座に元に戻る」という無限リバートのバグが発生していた。`selectedEnv` を依存から完全に外し、初期化済みかどうかを ref で管理する現在の設計により、ユーザーによる変更が以後尊重されるようになっている(`App.tsx` 41–47 行目のコメントに詳細な回帰防止コメントあり)。

## 新しいコンポーネントを足すときの手順

1. shadcn CLI で `ui/src/components/ui/` にプリミティブを追加する(`components.json` の設定に従い `style: "new-york"` / `iconLibrary: "lucide"` で生成される)
2. `cn()`(`@/lib/utils`)と `cva`(バリアントが必要な場合)のパターンで組む — `badgeVariants` / `buttonVariants` が参照実装
3. 独自の CSS クラスを新設せず、Tailwind ユーティリティクラスとトークン変数(`bg-background` / `text-pass` 等)のみを使う。hex/rgb を直書きしない
4. 機能コンポーネントは `ui/src/components/*.tsx` に作り、`ui/src/components/ui/*` のプリミティブを組み合わせて実装する。状態が必要ならカスタム hook を `ui/src/hooks/` に追加する(既存 hook と同様、`api/client` 経由でのみ通信する)

## アクセシビリティのルール

- **Radix の組み込み ARIA に任せ、role の上書きを禁止する**。ただし Radix が届かない箇所(`HistoryBrowser` の `<tr>` 行など、テーブル構造上 `<button>` にできない要素)に限り、`tabIndex` + `onKeyDown`(Enter/Space)+ `aria-expanded` を手動付与してキーボード操作性を担保する個別対応を行っている
- **アイコンのみボタンには必ず `aria-label` を付与する**(例: `Sidebar` の閉じるボタン「サイドバーを閉じる」、`TopBar` のハンバーガー「フロー一覧を開く」・履歴ボタン「履歴を表示」)
- **ステータスは色 + アイコン + テキストの3重表現**で示す(`StatusBadge`)。色だけに意味を持たせない
- **フォーカスリングの除去を禁止する**。`globals.css` の `:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }` が全要素に適用され、`Button` / `Select` 等の各プリミティブも `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring` を明示している
- 実行中・読み込み中の通知には `role="status"` 相当の仕組みを使う: `<output>` 要素(暗黙的に `role="status"`。`Spinner`、`RunView` の全体進捗、`RunView` の完了サマリー)、または明示的な `role="status"` + `aria-label`(`Sidebar` / `HistoryBrowser` のスケルトン読み込み中コンテナ)
- クリック可能要素には `cursor-pointer` を必須とし(`globals.css` の `button, [role="button"], a, select, summary { cursor: pointer; }`)、無効時は `cursor-not-allowed` + `opacity: 0.6`
