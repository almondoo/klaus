---
tags:
  - dev-tools/api-testing
  - documentation
created: 2026-08-07
source:
---

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

## 設計資料(実装の背景)

- [実装要件](requirements.md) — プロジェクトの決定事項(スコープ・技術スタック・マイルストーン)
- [UI アーキテクチャ設計](ui-design.md) — localhost UI のサーバー構成・API 契約・セキュリティ設計
- [UI ビジュアル / UX 設計](ui-ux-design.md) — デザイン方針・カラートークン・UX ルール
- [デザインシステム](design-system/klaus/MASTER.md) — 生成されたデザイントークンの原本
