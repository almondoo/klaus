# klaus

[![CI](https://github.com/almondoo/klaus/actions/workflows/ci.yml/badge.svg)](https://github.com/almondoo/klaus/actions/workflows/ci.yml)
![coverage](https://img.shields.io/badge/coverage-%E2%89%A590%25_lines-brightgreen)

ローカル HTTP API を CLI から検証するツール。リクエスト定義を素の YAML で git 管理し、実行・アサーション・履歴管理を行う。人間と AI エージェント(Claude Code 等)の両方が使うことを前提に設計している。

ドキュメントサイト: https://almondoo.github.io/klaus/ja/

[English](./README.md)

- **1ファイル = 1フロー**: 複数ステップの順次実行、レスポンスからの変数キャプチャと後続ステップへのチェーン
- **アサーション内包**: status / header / body(JSONPath)/ 所要時間を定義ファイルに記述
- **プロトコル対応**: SSE / GraphQL / WebSocket も通常の HTTP リクエストと同じマッチャーでアサーション可能(適用先は `events` / `messages` などプロトコル固有フィールド)
- **Web UI**: `klaus ui` で CLI と並行してローカルのランナー + 履歴ビューアを起動
- **record/replay・OpenAPI 生成**: `--record`/`--replay` でカセットベースの検証、`klaus generate` で OpenAPI スペックからフロー雛形を生成
- **エージェント向け出力**: exit code だけで故障箇所を判別可能。非 TTY では JSON 出力がデフォルト
- **ローカルファースト**: 実行履歴は `.klaus/history/*.jsonl` に追記。クラウド同期・アカウント機構はない

## インストール

```bash
npm install -g @almondoo/klaus
# 要 Node.js >= 22.19.0
```

## クイックスタート

```yaml
# api/auth-flow.yaml
name: 認証フロー
env: local          # environments/local.yaml を参照
steps:
  - name: login
    request:
      method: POST
      url: "{{baseUrl}}/login"
      headers:
        Content-Type: application/json
      body:
        email: "{{testEmail}}"
        password: "{{env.TEST_PASSWORD}}"   # OS 環境変数の参照
    capture:
      token: "$.token"                      # JSONPath でキャプチャ
    assert:
      status: 200
      body:
        - path: "$.token"
          exists: true

  - name: get-me
    request:
      method: GET
      url: "{{baseUrl}}/me"
      headers:
        Authorization: "Bearer {{token}}"   # 前ステップのキャプチャを参照
    assert:
      status: 200
      body:
        - path: "$.email"
          equals: "{{testEmail}}"
```

```yaml
# environments/local.yaml
baseUrl: http://localhost:3000
testEmail: test@example.com
```

```bash
klaus run api/auth-flow.yaml
# PASS login (200, 45ms)
# PASS get-me (200, 12ms)
```

テンプレート・アサーション・SSE / GraphQL / WebSocket の全構文は [フロー定義リファレンス](https://almondoo.github.io/klaus/ja/guide/flow-definition) を参照。

## CLI

| コマンド | 説明 |
|---|---|
| `klaus run <files...>` | フロー YAML を実行 |
| `klaus ui` | localhost Web UI(ランナー + 履歴ビューア)を起動 |
| `klaus validate [files...]` | フロー YAML をスキーマ検証のみ行う(実行しない) |
| `klaus schema` | フロー YAML / `run --json` 出力 / `klaus.config.yaml` の JSON Schema を出力 |
| `klaus generate <spec>` | OpenAPI スペックから操作ごとのフロー YAML 雛形を生成 |
| `klaus init` | flows/environments の最小構成をカレントディレクトリに生成 |
| `klaus history [show <runId>]` | 実行履歴を一覧表示、または1件を JSON で出力 |

各サブコマンドの全オプションは [CLI リファレンス](https://almondoo.github.io/klaus/ja/guide/cli) を参照。

- stdout が TTY なら人間向けテキスト、非 TTY(パイプ / エージェント実行)なら JSON が自動選択される
- テキスト出力は成功時1行要約のみ。失敗時だけ詳細(expected / actual)を出す。フル詳細は履歴 JSONL に残る

### exit code

| code | 意味 |
|---|---|
| 0 | 全件成功 |
| 1 | 一般エラー(予期しない failure) |
| 2 | 定義ファイルのパースエラー |
| 3 | 実行時エラー(接続不能・タイムアウト等) |
| 4 | アサーション失敗 |

## Documentation

- [Getting Started](https://almondoo.github.io/klaus/ja/guide/getting-started) — インストールから最初のフロー実行まで
- [フロー定義リファレンス](https://almondoo.github.io/klaus/ja/guide/flow-definition) — YAML スキーマ全体:ステップ・テンプレート・キャプチャ・アサーション・SSE/GraphQL/WebSocket 構文
- [CLI リファレンス](https://almondoo.github.io/klaus/ja/guide/cli) — 各サブコマンドの全オプション
- [Configuration(klaus.config.yaml)](https://almondoo.github.io/klaus/ja/guide/config) — よく使う CLI オプションのデフォルト値
- [OpenAPI からのフロー生成](https://almondoo.github.io/klaus/ja/guide/generate) — `klaus generate` の使い方と operation ごとに生成される雛形
- [record / replay モード](https://almondoo.github.io/klaus/ja/guide/record-replay) — ネットワーク隔離環境や破壊的 API 向けのカセットベース検証
- [Web UI](https://almondoo.github.io/klaus/ja/guide/ui) — `klaus ui` のランナー + 履歴ビューアと、トークン / CSRF / Host 検証のセキュリティモデル
- [実行履歴](https://almondoo.github.io/klaus/ja/guide/history) — `.klaus/history/*.jsonl` のスキーマとファイル規約
- [トラブルシューティング](https://almondoo.github.io/klaus/ja/guide/troubleshooting) — klaus が実際に出すエラーメッセージと原因・対処
- [Agent Skill(Claude Code / Codex)](https://almondoo.github.io/klaus/ja/guide/agent-skill) — 配置場所と、同梱の SKILL.md がエージェントに教える内容

## Agent Skill(Claude Code / Codex)

`skills/klaus/SKILL.md` として Agent Skill 形式のドキュメントを同梱している。`~/.claude/skills/klaus/`(Claude Code)や `~/.agents/skills/klaus/`(Codex)にコピーすると、フロー YAML の書き方や exit code の意味をエージェントがソースコードを読まずに把握できる。配置手順は [Agent Skill(Claude Code / Codex)](https://almondoo.github.io/klaus/ja/guide/agent-skill) を参照。

## 開発

```bash
pnpm install
pnpm build      # tsup(core / cli / server)。dist/ui は保持される
pnpm build:ui   # Vite(ui/ → dist/ui)
pnpm build:all  # clean + build + build:ui(リリース用のフルビルド)
pnpm test           # vitest
pnpm test:coverage  # vitest + カバレッジ(閾値: lines 90% を CI で強制。対象は src/、ui/ は対象外)
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome
```

構成: `src/core`(CLI 非依存の実行エンジン)+ `src/cli`(薄い CLI 層)+ `src/server`(`klaus ui` の API サーバー)+ `ui/`(Vite + React の Web UI、ワークスペース)。利用者向けガイドは `docs/ja/guide/`、開発者向け資料は `docs/dev/` を参照(目次: `docs/ja/index.md`)。

## ロードマップ

npm 公開(GitHub Actions + Trusted Publishing)は v0.1.1 で完了。今後の予定は [GitHub Issues](https://github.com/almondoo/klaus/issues) を参照。

## License

[Elastic License 2.0](LICENSE) — 利用・改変・再配布は自由ですが、本ソフトウェアをホスティング/マネージドサービスとして第三者に提供することはできません。
