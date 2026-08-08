# klaus Documents

API 検証 CLI「klaus」のドキュメント目次。

## 利用者向けガイド

- [Getting Started](guide/getting-started.md) — インストールから最初のフロー実行まで
- [CLI リファレンス](guide/cli.md) — `klaus run` / `klaus ui` の全オプション、exit code 体系、出力モード
- [フロー定義リファレンス](guide/flow-definition.md) — YAML の完全リファレンス(request / GraphQL / WebSocket / SSE / テンプレート / capture / assert)
- [実行履歴](guide/history.md) — `.klaus/history/*.jsonl` のスキーマとバージョニング契約
- [localhost UI](guide/ui.md) — `klaus ui` の使い方、セキュリティモデル

## 開発者向けガイド

### 現状の資料(実装を反映)

- [アーキテクチャ](dev/architecture.md) — core / cli / server / ui の構成と責務、公開 API、ビルド・テスト構成
- [変更履歴](dev/changelog.md) — 各リリースの変更点と、その背景にある判断・踏んだ落とし穴
- [改善提案](dev/improvement-proposals.md) — 実装・検証を通じて見えた改善点と優先順位
- [klaus ui — HTTP API と内部構成](dev/ui-api.md) — UI が使う HTTP API リファレンスとアーキテクチャ上の位置づけ
- [UI デザインシステム](https://github.com/almondoo/klaus/blob/main/ui/docs/design-system.md) — shadcn/ui + Tailwind v4 のトークン実装(実値の正)
- [UI コンポーネント設計](https://github.com/almondoo/klaus/blob/main/ui/docs/components.md) — プリミティブ構成・状態管理・a11y ルール

### 設計時の記録(実装と乖離あり)

先行設計時点のスナップショットであり、現在の実装と食い違う箇所がある。実装との差分は上記「現状の資料」および各 `ui/docs/` 側に記載。

- [実装要件](dev/requirements.md) — プロジェクトの決定事項(スコープ・技術スタック・マイルストーン)
- [UI アーキテクチャ設計](dev/ui-design.md) — localhost UI のサーバー構成・API 契約・セキュリティ設計
- [UI ビジュアル / UX 設計](dev/ui-ux-design.md) — デザイン方針・カラートークン・UX ルール
- [デザインシステム](dev/design-system/klaus/MASTER.md) — 生成されたデザイントークンの原本
