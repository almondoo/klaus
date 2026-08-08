# klaus Documents

API 検証 CLI「klaus」のドキュメント目次。

## ユーザーガイド

- [Getting Started](getting-started.md) — インストールから最初のフロー実行まで
- [CLI リファレンス](cli.md) — `klaus run` / `klaus ui` の全オプション、exit code 体系、出力モード
- [フロー定義リファレンス](flow-definition.md) — YAML の完全リファレンス(request / GraphQL / WebSocket / SSE / テンプレート / capture / assert)
- [実行履歴](history.md) — `.klaus/history/*.jsonl` のスキーマとバージョニング契約
- [localhost UI](ui.md) — `klaus ui` の使い方、セキュリティモデル、HTTP API リファレンス

## 開発者向け

- [アーキテクチャ](architecture.md) — core / cli / server / ui の構成と責務、公開 API、ビルド・テスト構成
- [UI デザインシステム](../ui/docs/design-system.md) — shadcn/ui + Tailwind v4 のトークン実装(実値の正)
- [UI コンポーネント設計](../ui/docs/components.md) — プリミティブ構成・状態管理・a11y ルール
- [改善提案](improvement-proposals.md) — 実装・検証を通じて見えた改善点と優先順位
- [変更履歴](changelog.md) — 各リリースの変更点と、その背景にある判断・踏んだ落とし穴

## 設計資料(実装の背景)

- [実装要件](requirements.md) — プロジェクトの決定事項(スコープ・技術スタック・マイルストーン)
- [UI アーキテクチャ設計](ui-design.md) — localhost UI のサーバー構成・API 契約・セキュリティ設計
- [UI ビジュアル / UX 設計](ui-ux-design.md) — デザイン方針・カラートークン・UX ルール
- [デザインシステム](design-system/klaus/MASTER.md) — 生成されたデザイントークンの原本
