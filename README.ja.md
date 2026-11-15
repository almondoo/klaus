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
- **送信先ホストの許可リスト**: `klaus.config.yaml` の `guard.allowedHosts` でリクエストの送信先を制限(上書きする CLI フラグはない)
- **読み取り専用の保護環境**: `$protected: readonly` で、`--allow-protected` なしでも GET / HEAD / OPTIONS のみ実行可能
- **ドライラン**: `klaus run --dry-run` は、何も送信せずに各ステップの展開後リクエストと、安全柵が拒否するかどうかを出力する
- **単発リクエスト**: `klaus req` は `klaus run` と同じ安全柵・シークレットマスクのもとで1件のリクエストを送り、履歴に記録する。エージェントは `curl` の代わりに使える
- **記録・比較・フロー化・モック**: `klaus diff` は記録済みの2つの run を比較し、`klaus promote` は記録済みの run からアサーションを推論した再実行可能なフローを生成し、`klaus mock` は記録済みカセットをローカルのモックサーバーとして提供する
- **スナップショット**: `assert.snapshot` はレスポンスを基準ファイルと比較する(秘密値はマスク、揮発する項目は除外できる)。変わったレスポンスは構造的な差分つきで失敗し、受け入れは明示的な操作(`klaus run -u`、`klaus snapshot accept`)。CI では基準が無いと記録せずに失敗する
- **OpenAPI の検証**: `klaus run --openapi spec.yaml` は、すべてのレスポンスを OpenAPI 3.0/3.1 の文書(ステータス・content-type・必須ヘッダー・本文のスキーマ)に照らして検証し、実行がどのオペレーションをカバーしたかを報告する。`--openapi-coverage-min` でカバレッジ不足を失敗にできる
- **HTTP クライアントとリクエストボディ**: リダイレクト、メモリ上の cookie jar、`basic` / `bearer` / `oauth2` の認証ヘルパー、`form` / `multipart` / `bodyFile` のボディ、設定ファイル専用の proxy / TLS(`klaus.config.yaml` の `http`。リダイレクトの各ホップも安全柵で再判定する)。`--jobs` で並列実行、`--data` でデータ駆動にできる
- **UI でのレビュー**: 履歴ビューアで2つの run を比較し、記録済みの run を新しいフローとして保存し(新規ファイルのみ)、スナップショットと OpenAPI の判定を表示し、スナップショットの変更を承認できる
- **MCP サーバー**: `klaus mcp` は klaus を stdio の MCP クライアントへツールとして提供する。送信はすべて CLI と同じ送信先の許可リスト・環境の保護・シークレットのマスク・履歴を通り、MCP にそのどれも無効にするオプションはない(`guard.allowedHosts` を設定すること。エージェントの送信先を限るのはこれ)
- **レポート**: `--report` で `junit`・`tap`・`html`(自己完結の単一ファイル)・`github`(GitHub Actions 向けのジョブサマリーとアノテーション)を出力
- **ローカルファースト**: 実行履歴は `.klaus/history/*.jsonl` に追記。クラウド同期・アカウント機構はない

## インストール

```bash
npm install -g @almondoo/klaus
# 要 Node.js >= 22.19.0
```

リポジトリには、自分で klaus イメージをビルドするための `Dockerfile` と、composite GitHub Action(`action.yml`)も含まれている。どちらもレジストリや Marketplace には公開していない。

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
| `klaus req <method> <url>` | 単発リクエストを1件送信(安全柵つき・シークレットマスク・履歴記録) |
| `klaus ui` | localhost Web UI(ランナー + 履歴ビューア)を起動 |
| `klaus validate [files...]` | フロー YAML をスキーマ検証のみ行う(実行しない) |
| `klaus schema` | フロー YAML / `run --json` 出力 / `klaus.config.yaml` の JSON Schema を出力 |
| `klaus generate <spec>` | OpenAPI スペックから操作ごとのフロー YAML 雛形を生成 |
| `klaus init` | flows/environments の最小構成をカレントディレクトリに生成 |
| `klaus history [show <runId>]` | 実行履歴を一覧表示、または1件を JSON で出力 |
| `klaus diff [runA] [runB]` | 履歴の記録済み2 run を比較(差分があれば exit 4) |
| `klaus promote <runId...>` | 記録済みの run からアサーションを推論した再実行可能なフロー YAML を生成 |
| `klaus mock <dir>` | 記録済みカセットをローカルのモックサーバーとして提供 |
| `klaus snapshot list\|accept` | 記録済みの run のスナップショットの不一致を一覧し、新しい基準として受け入れる |
| `klaus mcp [--read-only]` | klaus を AI エージェント向けのツールとして公開する stdio の MCP サーバーを起動する(安全柵とマスクは常に適用され、無効にするオプションはない) |

各サブコマンドの全オプションは [CLI リファレンス](https://almondoo.github.io/klaus/ja/guide/cli) を参照。

- stdout が TTY なら人間向けテキスト、非 TTY(パイプ / エージェント実行)なら JSON が自動選択される
- テキスト出力は成功時1行要約のみ。失敗時だけ詳細(expected / actual)を出す。フル詳細は履歴 JSONL に残る

### exit code

| code | 意味 |
|---|---|
| 0 | 全件成功 |
| 1 | 一般エラー(予期しない failure) |
| 2 | 定義ファイルのパースエラー |
| 3 | 実行時エラー(接続不能・タイムアウト・安全柵による拒否等) |
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
- [AI エージェント向けの MCP サーバー](https://almondoo.github.io/klaus/ja/guide/mcp) — `klaus mcp`: MCP クライアントへの登録方法・ツール・安全柵
- [他ツールとの比較](https://almondoo.github.io/klaus/ja/guide/comparison) — klaus と類似の API テストツールとの違い
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
