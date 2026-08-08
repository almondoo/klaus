# ui/docs

klaus localhost UI(`ui/` — Vite + React SPA、shadcn/ui 移行後)の設計書。実装(`ui/src/**`)から裏取りした事実のみを記載する。

- [デザインシステム](./design-system.md) — Tailwind v4 (CSS-first) / shadcn/ui の技術構成、カラートークン、ダークモード方針、タイポグラフィ、角丸・余白、モーション方針
- [コンポーネント設計](./components.md) — 導入済み shadcn プリミティブと使用箇所、機能コンポーネントの責務、状態管理方針(env セレクタ初期化ルールを含む)、コンポーネント追加手順、アクセシビリティルール

## 上位ドキュメント

- アーキテクチャ・API 契約: [docs/dev/ui-design.md](../../docs/dev/ui-design.md)
- プロダクト全体の UX 方針: [docs/dev/ui-ux-design.md](../../docs/dev/ui-ux-design.md)
- デザイントークンの原本(生成資料): [docs/dev/design-system/klaus/MASTER.md](../../docs/dev/design-system/klaus/MASTER.md)

本書内で上記と実装の食い違いを見つけた箇所は、各ファイル内に「ドキュメントとの差分」として明記している。実装側の事実を優先する。
