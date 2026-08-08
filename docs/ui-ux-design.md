---
tags:
  - dev-tools/api-testing
  - design
  - ui-ux
created: 2026-08-07
source: ui-ux-pro-max skill (design-system + product/ux/icons/react 検索)
---

# klaus UI ビジュアル / UX 設計(M4)

> [!summary] この文書の役割
> [[ui-design]](docs/ui-design.md)がアーキテクチャ(server / API / セキュリティ)を定めるのに対し、本書はビジュアルデザインと UX ルールを定める。デザイントークンの原本は `docs/design-system/klaus/MASTER.md`(ui-ux-pro-max により生成)。本書は klaus の実態(データ密度の高いランナー + ビューア)に合わせた適用ルールを記す。

## デザイン方針

ui-ux-pro-max の product 検索で「Developer Tool / IDE」にマッチ: **Dark Mode (OLED) + Minimalism**、ダッシュボードスタイルは **Real-Time Monitor + Terminal**。生成された MASTER.md のうちランディングページ向け要素(Minimal Single Column パターン、`clamp(3rem 10vw 12rem)` の特大見出し)は**アプリ UI には適用しない**(マーケティングページ用の推奨であり、ランナー UI には不適合)。採用するのは配色・タイポグラフィ・密度・モーションのトークン。

- **ダークモードをデフォルト**にする(DB の anti-pattern: "Light mode default")。ライトモードは将来対応とし、初期実装では作らない
- ターミナル的な情報密度: density 8/10(spacing scale 8–32px)。余白で飾らず、実行結果を一覧性高く見せる
- モーションは subtle(2/10)。GSAP は導入せず CSS transition(150–300ms)で足りる範囲に留める(グローバル CLI の依存を増やさない。MASTER.md の GSAP スニペットは不使用)。`prefers-reduced-motion` を尊重する

## カラートークン(MASTER.md より)

| Role | Hex | 用途 |
|------|-----|------|
| Background | `#020617` | アプリ背景 |
| Foreground | `#F8FAFC` | 基本テキスト |
| Primary | `#0F172A` | ヘッダー・サイドバー面 |
| Secondary | `#1E293B` | カード・パネル面 |
| Muted | `#1A1E2F` | 行の縞・非活性領域 |
| Border | `#334155` | 罫線 |
| Accent | `#22C55E` | 実行ボタン・PASS |
| Destructive | `#EF4444` | FAIL・エラー |

ステータス色の拡張(DB に該当が無いため独自定義。既存トークンとの整合で選定):

| 状態 | Hex | 備考 |
|------|-----|------|
| pass | `#22C55E` | Accent と共通 |
| fail | `#EF4444` | Destructive と共通 |
| running | `#38BDF8` | sky。スピナー・進行中ステップ |
| skipped | `#F59E0B` | amber。フロー中断後のスキップステップ |

**色だけに意味を担わせない**(アクセシビリティ必須ルール): pass/fail/skipped は必ずアイコン + テキストラベルを併記する。コントラストは 4.5:1 以上を維持。

## タイポグラフィ

- **Heading / データ(URL・パス・ステータスコード・所要時間・JSONPath): Fira Code**(monospace。ターミナル的世界観の中核)
- **Body(説明文・ラベル): Fira Sans**
- ベース 16px、line-height 1.5。テーブル内データは 14px まで許容(12px 未満禁止)
- フォントは Google Fonts CDN ではなく **npm パッケージ(@fontsource/fira-code, @fontsource/fira-sans)でバンドル**する(localhost UI はオフラインでも動くべき。外部 CDN 依存は同一オリジン方針とも不整合)

## 画面別の適用([[ui-design]] の3画面に対応)

### 1. フロー一覧(サイドバー)
- 左サイドバー固定(240–280px)+ メイン領域の2ペイン。モバイル対応は優先度低(開発者のローカルツール)だが 768px でサイドバーをドロワー化
- フロー名は Fira Sans、ファイルパスは Fira Code の muted 表示
- パースエラーのあるフローはリスト上で Destructive のアイコン + ツールチップで理由表示
- 環境セレクタと実行ボタンはメイン領域上部に固定

### 2. 実行ビュー(Real-Time Monitor)
- ステップを縦のリストで表示し、SSE 進捗で行が `running → pass/fail` に遷移。**300ms を超える待ちには必ずインジケータ**(running スピナー)を出す(UX DB: Loading Indicators / High)
- 全体進捗は「Step 2 / 5」形式のステップインジケータ(UX DB: Progress Indicators)
- 失敗ステップは行を展開してリクエスト/レスポンス詳細(Fira Code、JSON はシンタックスハイライト)。成功ステップはデフォルト折り畳み — CLI の「成功時は1行要約」思想を UI でも踏襲
- 実行ボタンは押下後すぐ loading 状態にし、完了時に成功/失敗のサマリーを表示(UX DB: Submit Feedback / High)

### 3. 履歴ブラウザ
- 新しい順のテーブル(密度 8/10: 行高 32–36px、縞背景 Muted)。ページングは `before` カーソルで遅延読み込み(UX DB: Lazy Loading — 全件先読みしない)
- run 単位でグルーピングし、ドリルダウンでステップ詳細へ

## アイコン

- **Phosphor Icons(@phosphor-icons/react)、Outline スタイルで統一**。絵文字をアイコンとして使わない(必須ルール)
- 主要マッピング: 実行 = Play、pass = CheckCircle、fail = XCircle、skipped = MinusCircle、running = CircleNotch(回転)、履歴 = ClockCounterClockwise、環境 = Gear、戻る = ArrowLeft
- アイコンのみのボタンには必ず `aria-label` を付与。サイズ 20px、クリック領域は 44×44px 以上を確保

## React 実装ルール(stack 検索より)

- リストの key は安定 ID(`runId`、フロー内 step name)を使う。index キー禁止(Severity: High)
- 派生値(pass 数・合計時間など)は state に持たず render で計算する(Severity: High)
- 履歴 JSONL のパースなど高コストな初期値は `useState(() => ...)` の lazy 初期化
- 状態管理は React 標準で開始([[ui-design]] の方針どおり)

## アクセシビリティ / 品質チェックリスト(実装完了条件)

- [ ] テキストコントラスト 4.5:1 以上(ダーク背景 `#020617` に対し muted テキストも確認)
- [ ] キーボード操作可能(フロー選択 → 実行 → 結果展開まで)、フォーカスリング非除去
- [ ] pass/fail が色 + アイコン + テキストの3重で判別可能
- [ ] クリック可能要素に cursor-pointer と 150–300ms の hover トランジション
- [ ] `prefers-reduced-motion` でスピナー以外のアニメーション停止
- [ ] 375px / 768px / 1024px / 1440px で横スクロールなし(JSON 詳細ブロックのみ内部スクロール可)
