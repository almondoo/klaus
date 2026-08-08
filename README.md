# klaus

ローカル HTTP API を CLI から検証するツール。リクエスト定義を素の YAML で git 管理し、実行・アサーション・履歴管理を行う。人間と AI エージェント(Claude Code 等)の両方が使うことを前提に設計している。

- **1ファイル = 1フロー**: 複数ステップの順次実行、レスポンスからの変数キャプチャと後続ステップへのチェーン
- **アサーション内包**: status / header / body(JSONPath)/ 所要時間を定義ファイルに記述
- **エージェント向け出力**: exit code だけで故障箇所を判別可能。非 TTY では JSON 出力がデフォルト
- **ローカルファースト**: 実行履歴は `.klaus/history/*.jsonl` に追記。クラウド同期・アカウント機構はない
- **SSE 検証**: `text/event-stream` を時間 / イベント数上限付きで受信し、イベントにアサーション

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

## CLI

```
klaus run <files...> [options]

  --env <name>          フローの env 指定を上書き
  --json                TTY でも JSON 出力を強制
  --report junit        JUnit XML レポートを生成
  --report-file <path>  レポート出力先(デフォルト: klaus-report.xml)
  --no-history          履歴 JSONL への書き込みを無効化

klaus ui [options]      # localhost Web UI(ランナー + 履歴ビューア)を起動

  -p, --port <n>        ポート指定(デフォルト: 空きポート自動選択)
  --no-open             ブラウザの自動起動を抑止
```

`klaus ui` は 127.0.0.1 限定でサーバーを起動し、起動時トークン付き URL をブラウザで開く(トークン認証 + Host 検証 + CSRF 対策付き。外部からはアクセス不可)。

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

## テンプレート

- `{{var}}` — キャプチャ変数・環境ファイル値の参照(キャプチャ優先)
- `{{env.X}}` — OS 環境変数の参照。シークレットは定義ファイルに直書きせずこれを使う
- `{{newUuid}}` / `{{newDate}}` / `{{newTimestamp}}` — テンプレート関数(UUID / ISO 8601 / epoch ms)

## アサーション

- `status: 200`
- `headers: [{ name, equals | contains | regex | exists }]`
- `body: [{ path, exists | equals | contains | regex }]` — JSONPath ベース
- `bodyText: { equals | contains | regex }` — 生テキスト
- `duration: { maxMs }`
- SSE 用: `eventCount: { min | max | equals }` / `events: [{ index?, path?, ...マッチャー }]`
- WebSocket 用: `messageCount: { min | max | equals }` / `messages: [{ index?, path?, ...マッチャー }]`(events と同セマンティクス)

## SSE 検証

`Accept: text/event-stream` のリクエスト(または `sse:` ブロックの指定)は、`maxEvents` / `maxDurationMs` の上限に達した時点で受信を打ち切り、受信イベント列にアサーションを実行する。

```yaml
  - name: stream
    request:
      method: GET
      url: "{{baseUrl}}/events"
      headers:
        Accept: text/event-stream
    sse:
      maxEvents: 5
      maxDurationMs: 3000
    assert:
      eventCount: { min: 1 }
      events:
        - path: "$.type"
          equals: "message"
```

## GraphQL

`request.graphql` を指定すると、method 未指定なら POST、`Content-Type: application/json` で `{ query, variables }` を送信する(`body` とは排他)。アサーション・キャプチャは通常の JSONPath がそのまま使える。

```yaml
  - name: get-user
    request:
      url: "{{baseUrl}}/graphql"
      graphql:
        query: 'query { user(id: "{{userId}}") { id name } }'
    assert:
      status: 200
      body:
        - path: "$.data.user.id"
          exists: true
```

## WebSocket

ステップに `request` の代わりに `ws:` を指定する。`send` の各メッセージを順次送信し、`maxMessages` / `maxDurationMs` の上限で受信を打ち切って正常終了、受信メッセージ列にアサーションを実行する。

```yaml
  - name: ws-echo
    ws:
      url: "{{wsBaseUrl}}/socket"
      send:
        - "ping"
        - { type: subscribe, channel: orders }
      maxMessages: 50        # デフォルト 100
      maxDurationMs: 5000    # デフォルト 10000
    assert:
      messageCount: { min: 1 }
      messages:
        - index: 0
          equals: "pong"
        - path: "$.type"
          contains: "order"
```

## 実行履歴

全リクエスト / レスポンス / 所要時間が `.klaus/history/<日付>.jsonl` に1ステップ1行で追記される(スキーマは `v` フィールドで versioned)。git 管理するかどうかはプロジェクト側の判断(シークレットを含むレスポンスを扱う場合は `.gitignore` 推奨)。

## 開発

```bash
pnpm install
pnpm build      # tsup(core / cli / server)。dist/ui は保持される
pnpm build:ui   # Vite(ui/ → dist/ui)
pnpm build:all  # clean + build + build:ui(リリース用のフルビルド)
pnpm test       # vitest
pnpm typecheck  # tsc --noEmit
pnpm lint       # biome
```

構成: `src/core`(CLI 非依存の実行エンジン)+ `src/cli`(薄い CLI 層)+ `src/server`(`klaus ui` の API サーバー)+ `ui/`(Vite + React の Web UI、ワークスペース)。利用者向けガイドは `docs/guide/`、開発者向け資料は `docs/dev/` を参照(目次: `docs/index.md`)。

## ロードマップ

npm 公開(GitHub Actions + Trusted Publishing)は v0.1.1 で完了。今後の予定は [GitHub Issues](https://github.com/almondoo/klaus/issues) を参照。

## License

[Elastic License 2.0](LICENSE) — 利用・改変・再配布は自由ですが、本ソフトウェアをホスティング/マネージドサービスとして第三者に提供することはできません。
