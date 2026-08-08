# klaus UI デザインシステム

> [!summary] この文書の役割
> `ui/`(React SPA)が実際に採用している技術構成・デザイントークンを実装から抽出した資料。プロダクト全体の UX 方針は [docs/ui-ux-design.md](../../docs/ui-ux-design.md)、アーキテクチャ・API 契約は [docs/ui-design.md](../../docs/ui-design.md)を参照。**トークンの原本は常に `ui/src/styles/globals.css`** — 本書の値と食い違ったら globals.css を正とする。

## 技術構成

| 項目 | 採用 | 備考 |
|---|---|---|
| CSS フレームワーク | Tailwind CSS v4(CSS-first) | `@tailwindcss/vite` プラグイン。`tailwind.config.js` を持たない(後述) |
| コンポーネント | shadcn/ui(`style: "new-york"`) | `ui/components.json`: `rsc: false` / `tsx: true` / `baseColor: "slate"` / `cssVariables: true` / `prefix: ""` |
| プリミティブ | Radix UI | `@radix-ui/react-{collapsible,progress,scroll-area,select,separator,slot,tooltip}`(`ui/package.json`) |
| アイコン | lucide-react | `components.json` の `iconLibrary: "lucide"`。全コンポーネントが `lucide-react` から import |
| クラス結合 | `cn()`(`ui/src/lib/utils.ts`) | `clsx` + `tailwind-merge` の shadcn 標準パターン。後勝ちで Tailwind クラスをマージ |
| バリアント定義 | `class-variance-authority`(cva) | `Button` / `Badge` で使用 |
| エイリアス | `@/*` → `src/*` | `tsconfig.json` の `paths` と `vite.config.ts` の `resolve.alias` で二重に定義(型解決とビルド解決を両立) |

### tailwind.config.js を持たない理由

Tailwind v4 は CSS ファイル内の `@import "tailwindcss"` + `@theme` ブロックでテーマを定義する「CSS-first」設定に変わった。`globals.css` の `@theme inline { ... }` がその実体で、`--color-*` / `--font-*` / `--radius-*` / `--spacing-*` という Tailwind ユーティリティ生成用のトークンをここで宣言している。JS 側の設定ファイルは不要になったため存在せず、`components.json` の `tailwind.config` も空文字列になっている。

## カラートークン

`globals.css` の `:root` / `.dark` で定義(現状は同値。理由は次節)。`@theme inline` で `hsl(var(--x))` として Tailwind ユーティリティ(`bg-background` 等)にマッピングされる。

### shadcn 標準トークン

| 変数 | HSL | 元 Hex | 用途 |
|---|---|---|---|
| `--background` | `229 84% 5%` | `#020617` | アプリ背景 |
| `--foreground` | `210 40% 98%` | `#F8FAFC` | 基本テキスト |
| `--card` / `--card-foreground` | `217 33% 17%` / `210 40% 98%` | `#1E293B` / `#F8FAFC` | カード・パネル面 |
| `--popover` / `--popover-foreground` | `222 47% 11%` / `210 40% 98%` | `#0F172A` / `#F8FAFC` | ヘッダー・サイドバー面 |
| `--primary` / `--primary-foreground` | `142 71% 45%` / `139 70% 5%` | `#22C55E` / `#04170A` | 実行ボタン・PASS(Accent/CTA) |
| `--secondary` / `--secondary-foreground` | `217 33% 17%` / `210 40% 98%` | `#1E293B` / `#F8FAFC` | 二次背景(`--card` と同値) |
| `--muted` / `--muted-foreground` | `229 29% 14%` / `215 20% 65%` | `#1A1E2F` / `#94A3B8` | 行の縞・非活性領域 |
| `--accent` / `--accent-foreground` | `217 33% 17%` / `210 40% 98%` | `#1E293B` / `#F8FAFC` | ホバー背景(`--secondary` と同値) |
| `--destructive` / `--destructive-foreground` | `0 84% 60%` / `0 0% 100%` | `#EF4444` / `#FFFFFF` | FAIL・エラー |
| `--border` / `--input` | `215 25% 27%` | `#334155` | 罫線・入力枠 |
| `--ring` | `198 93% 60%` | `#38BDF8` | フォーカスリング |

### klaus 独自ステータス変数

shadcn 標準トークンには無いため独自追加(`Badge` の `pass`/`fail`/`running`/`skipped`/`pending` バリアントが参照する)。

| 変数 | HSL | 元 Hex | 用途 |
|---|---|---|---|
| `--pass` | `142 71% 45%` | `#22C55E` | 成功(`--primary` と同値) |
| `--fail` | `0 84% 60%` | `#EF4444` | 失敗(`--destructive` と同値) |
| `--running` | `198 93% 60%` | `#38BDF8` | 実行中(スピナー。`--ring` と同値) |
| `--skipped` | `38 92% 50%` | `#F59E0B` | スキップ |
| `--pending` | `215 20% 65%` | `#94A3B8` | 待機中(`--muted-foreground` と同値) |

いずれも `bg-{status}/12 text-{status}`(背景 12% 不透明度 + 同色テキスト)の形で使う(`ui/src/components/ui/badge.tsx`)。`StatusBadge`(`ui/src/components/StatusBadge.tsx`)がこれをアイコン + テキストラベルと組み合わせ、色 + アイコン + テキストの3重表現を実現する。

### ドキュメントとの差分

`docs/design-system/klaus/MASTER.md` はトークンの生成元だが、shadcn の変数意味論に合わせて実装時に再マッピングされている。

| MASTER.md 上の役割 | MASTER.md の値 | 実装でのマッピング先 | 理由 |
|---|---|---|---|
| Primary(`#0F172A`) | 面色として定義 | `--popover`(ヘッダー・サイドバー面) | shadcn の `--primary` は「主要アクション色」の意味論であり、面色ではないため |
| Accent/CTA(`#22C55E`) | アクセント色 | `--primary`(実行ボタン・PASS) | 上記の意味論に合わせ、実際のボタン主色として採用 |
| Ring(`#0F172A`, Primary と同色) | フォーカスリング色 | `--ring`(`#38BDF8`, sky) | 背景 `#020617` に対し `#0F172A` はほぼ不可視でフォーカスリングとして機能しないため、視認性の高い sky に変更 |

`docs/ui-ux-design.md` の「アイコン」節は **Phosphor Icons(@phosphor-icons/react)、Outline スタイル**を指定しているが、実装(`components.json` / `package.json` / 全コンポーネントの import)は **lucide-react** を採用している。既知の乖離であり、lucide-react が現行の事実。

## ダークモード方針

- `index.html` の `<html>` 要素に固定で `class="dark"` を付与し、`.dark` セレクタを常時適用する(テーマ切り替え UI は無い)
- `:root` と `.dark` は現状**完全に同値**(globals.css 16–89 行目)。`:root` にもダーク値をあらかじめ用意しておくのは、将来ライトモードを追加する際に `:root` 側だけを差し替えれば済むようにするための設計
- `color-scheme: dark` を `:root` / `.dark` 双方に設定し、スクロールバー等のブラウザ標準 UI もダーク化する
- `@custom-variant dark (&:is(.dark *));` で `dark:` バリアントの判定基準を `prefers-color-scheme` ではなく `.dark` クラスに固定している(Tailwind v4 の既定は `prefers-color-scheme` ベースのため、明示的な切り替えにはこのカスタムバリアント登録が必須)

### 将来ライトモードを追加する手順

1. `:root` のトークンをライト値に差し替える(`.dark` は現行のダーク値のまま残す)
2. テーマ切り替え UI(トグル等)を追加し、`<html>` の `dark` クラスの有無を制御する
3. `@custom-variant dark` の定義はそのままで機能する(`.dark` の有無で切り替わる設計のため)

## タイポグラフィ

| 用途 | フォント | CSS 変数 |
|---|---|---|
| 見出し・データ(URL・パス・ステータスコード・所要時間・JSON) | Fira Code(monospace) | `--font-mono` |
| 本文・ラベル | Fira Sans | `--font-sans` |

- `main.tsx` で `@fontsource/fira-code` / `@fontsource/fira-sans` の 400/500/600 ウェイト、`latin` + `latin-ext` サブセットのみをバンドル
- **CDN を使わない理由**: localhost UI はオフラインでも動作すべきという方針、および同一オリジン配信(外部ドメインへの依存を持たない)方針との整合。`docs/ui-ux-design.md` にも同旨の記載がある。MASTER.md は Google Fonts CDN の `@import url(...)` を提案しているが不採用
- 日本語 UI ラベルは Fira Code / Fira Sans が CJK グリフを持たないため、ブラウザのフォールバックフォント(`ui-sans-serif` / `ui-monospace` 経由のシステムフォント)で表示される。意図的な設計で、klaus の UI テキストは日本語ラベル以外は ASCII のデータ・コードが中心
- ベース `font-size: 16px`、`line-height: 1.5`(`body`)。`code` / `pre` 要素は `font-mono` を強制適用

## 角丸スケール

`--radius: 0.625rem`(10px)を基準に `@theme inline` で相対計算する:

| トークン | 計算式 | 実測値 |
|---|---|---|
| `--radius-sm` | `calc(var(--radius) - 4px)` | 6px |
| `--radius-md` | `calc(var(--radius) - 2px)` | 8px |
| `--radius-lg` | `var(--radius)` | 10px |
| `--radius-xl` | `calc(var(--radius) + 4px)` | 14px |

`Card` は `rounded-lg`(10px)、`Button` / `Badge` / `Select` 等は `rounded-md`(8px)を使用。MASTER.md の Component Specs(カード 12px・ボタン 8px の生 CSS 固定値)はプレースホルダーであり、実装はこの calc ベースの相対スケールを採用している。

## 余白・密度

- タッチターゲットは既定 `h-11`(44px。`Button` / `Select` の `default` サイズ)。密度が要求される一覧系(テーブル行・小型セレクタ)は `h-9`(36px。`sm` サイズ)まで圧縮を許容する — `docs/ui-ux-design.md` の density 8/10(dense / dashboard)方針の具体化
- `--sidebar-width: 16.25rem`(260px)。`docs/ui-ux-design.md` が指定する 240–280px の範囲内
- MASTER.md は `--space-xs`〜`--space-3xl`(2px〜32px)という名前付きスペーシングトークンを定義しているが、**`globals.css` はこれらを CSS 変数として実装していない**。実際は各コンポーネントで Tailwind の既定スペーシングスケール(`p-6` / `gap-3` / `px-3` 等)を直接指定しており、結果的に MASTER.md が意図する密度感には収まっている

## モーション方針

- **CSS transition と Radix の `animate-in` / `animate-out`(`tw-animate-css`)のみ**。GSAP 等のアニメーションライブラリは `package.json` に存在せず未導入
- 導入しない理由: グローバルインストールされる CLI ツールの依存を増やしたくないため(`docs/ui-ux-design.md` に明記)。MASTER.md の GSAP スクロールリビール スニペットは不採用
- 遷移時間はおおむね 150–300ms の範囲(例: `Button` / `TableRow` / `ScrollBar` = `duration-150`、`Progress` インジケータ = `duration-300`、`Sidebar` ドロワー = `duration-[250ms]`)
- `Select` / `Tooltip` のポップアップは `tw-animate-css` の `data-[state=open]:animate-in` / `data-[state=closed]:animate-out` + `fade-in-0` / `zoom-in-95` 系ユーティリティで開閉する

### `prefers-reduced-motion` の実装

`globals.css` 179–201 行目、`@layer base` の**外**(unlayered)に配置:

```css
@media (prefers-reduced-motion: reduce) {
  *:not([data-spinner]) {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
  }
  *, *::before, *::after {
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

- `@layer` の外に置くことで、CSS カスケードレイヤーの優先順位に関わらず、Tailwind のユーティリティ層(各コンポーネントの `transition-*` / `animate-*` クラス)より必ず優先されるようにしている(unlayered なスタイルは全レイヤーより優先されるという性質を利用)
- `[data-spinner]` 属性を持つ要素(`Spinner.tsx` の `<output>`、`StatusBadge` の実行中アイコン)だけは `*:not([data-spinner])` セレクタで対象から除外し、回転だけは維持する。実行中インジケータが完全に静止すると「動いているのか固まっているのか判別できない」状態になるため
- `!important` は WCAG 2.3.3 対応の意図的な例外として、`biome-ignore lint/complexity/noImportantStyles` コメント付きで許容している
