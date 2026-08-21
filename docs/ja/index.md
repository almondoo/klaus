# klaus Documents

API 検証 CLI「klaus」のドキュメント目次。

## はじめる

- [Getting Started](guide/getting-started.md) — インストールから最初のフロー実行まで

## ガイド

- [OpenAPI からのフロー生成](guide/generate.md) — OpenAPI 3.x 定義からフロー定義 YAML の雛形を作る
- [record / replay モード](guide/record-replay.md) — 実ネットワークの代わりに記録済みカセットでフローを検証する
- [localhost UI](guide/ui.md) — `klaus ui` の使い方、セキュリティモデル
- [Agent Skill(Claude Code / Codex)](guide/agent-skill.md) — 同梱の Agent Skill で AI コーディングエージェントに klaus の使い方を教える
- [トラブルシューティング](guide/troubleshooting.md) — klaus が実際に出力するエラーメッセージと、その原因・対処

## リファレンス

- [CLI リファレンス](guide/cli.md) — `klaus run` / `klaus ui` の全オプション、exit code 体系、出力モード
- [フロー定義リファレンス](guide/flow-definition.md) — YAML の完全リファレンス(request / GraphQL / WebSocket / SSE / テンプレート / capture / assert)
- [CLI オプションの既定値(klaus.config.yaml)](guide/config.md) — CLI オプションのプロジェクト共通デフォルトを設定する
- [実行履歴](guide/history.md) — `.klaus/history/*.jsonl` のスキーマとバージョニング契約
