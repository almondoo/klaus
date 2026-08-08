---
tags:
  - dev-tools/api-testing
  - claude-code
  - cli
  - requirements
created: 2026-08-07
source:
---

# API 検証 CLI「klaus」実装要件

> [!summary] この文書の役割
> 実装セッションへの引き継ぎ用。**決定事項のみ**を記載する。新リポジトリに `docs/requirements.md` としてコピーして使う。
> 検討経緯（ツール比較・deep-research の検証結果）はリサーチ vault の [[Claude CodeでのAPI検証環境の選定]] にある。**実装リポジトリからはこのリンクは解決できない**が、実装には本文書だけで足りる。

## 目的

Go / Node で実装したローカル HTTP API を、Claude Code（AI エージェント）と人間の両方が CLI から検証するツール。リクエスト定義を git 管理し、実行履歴をローカルに残す。npm -g でグローバルインストールして使う。

> [!info] 名前（2026-08-07 決定）
> ツール名・コマンド名は **klaus**。npm の無印 `klaus` は取得済み（2017年〜の別パッケージ）のため、パッケージ名はスコープ付き `@<ユーザー名>/klaus` とし、`package.json` の `bin` でコマンド名を `klaus` にする。

## スコープ外（実装してはならないもの）

1. **GUI アプリ・VS Code 拡張は作らない**。将来の UI は「CLI が serve する localhost Web UI」のみ（本フェーズでは対象外、ただし core 分離でその余地を残す）
2. **HTTP レイヤーを再実装しない**。リトライ・TLS・リダイレクトは undici に任せる
3. **独自 DSL を作らない**。リクエスト定義は素の YAML
4. クラウド同期・アカウント機構は永久に作らない（ローカルファースト）

## 技術スタック（確定）

| レイヤー | 選定 |
|---|---|
| 言語 / ランタイム | TypeScript + Node.js ≥22.19、npm -g 配布 |
| HTTP エンジン | undici |
| 定義フォーマット | YAML（zod でスキーマ検証） |
| アサーション | jsonpath-plus + 自前マッチャー |
| CLI フレームワーク | commander |
| ビルド / テスト / lint | tsup / vitest / biome |
| パッケージ構成 | 単一パッケージ。`src/core`（CLI 非依存ライブラリ）と `src/cli`（薄い皮）を分離。将来 `src/server` + `ui/`（Vite + React）を追加 |

## リクエスト定義フォーマット（サンプル・出発点）

以下を M1 の出発点とする。フィールド名の細部は実装時に調整してよいが、**「1ファイル=1フロー（複数ステップ）」「キャプチャとアサーションを定義に内包」の構造は維持する**こと。

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
      token: "$.token"                      # jsonpath でキャプチャ
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

## 機能要件

### 必須

- **YAML リクエスト定義**: メソッド・URL・ヘッダー・ボディ・アサーションを1ファイルに記述。複数リクエストの順次実行（コレクション）に対応
- **変数キャプチャとチェーン**: レスポンスから jsonpath 等で値を取り `{{var}}` で後続リクエストに参照（ログイン → トークン → Authorization ヘッダーが代表ケース）。`newUuid` / `newDate` 等のテンプレート関数
- **環境変数**: 環境別ファイル（local / staging 等）+ OS 環境変数の参照。シークレットは定義ファイルに直書きさせない
- **アサーション**: status / header / body 文字列 / JSONPath を最低限。regex / duration は拡張候補
- **exit code 体系**: 0=全件成功 / 1=一般エラー / 2=定義パースエラー / 3=実行時エラー（接続不能等）/ 4=アサーション失敗。エージェントが exit code だけで故障箇所を判別できること
- **機械可読レポート**: JSON 出力（`--json`）。JUnit / TAP は拡張候補
- **実行履歴**: 全リクエスト / レスポンス / 所要時間を `.klaus/history/*.jsonl` に追記。git 管理可能なテキスト

### 必須（エージェント向け出力設計）

- **TTY 自動判定**: stdout が TTY なら人間向け text、非 TTY（パイプ / Claude Code の Bash）なら JSON をデフォルトに
- **成功時は1行要約のみ**（例: `PASS login (200, 45ms)`）。失敗時だけレスポンス詳細を出す。フル詳細は履歴 JSONL に逃がす

### 推奨

- **SSE 検証**: `Accept: text/event-stream` のリクエストは時間 / イベント数上限付きで受信して打ち切り、受信イベントに対するアサーションを実行（既製ツールに無い差別化機能）
- WebSocket / GraphQL 対応

### 任意（当面実装しない）

- gRPC、モックサーバー、負荷試験

## 将来の localhost UI に向けた制約（今フェーズで守ること）

- 実行・アサーション・履歴の全ロジックは `src/core` に置き、CLI から import するだけにする（UI 追加時に core を再利用するため）
- 履歴 JSONL のスキーマは versioned にする（UI が読む契約になる）
- UI 実装時: バインドは 127.0.0.1 限定、起動時トークンで CSRF / DNS rebinding 対策、UI はサーバーと同一オリジンで serve

## マイルストーン案

1. **M1**: YAML 定義 → 実行 → アサーション → text / JSON 出力 + exit code（最小で動く）
2. **M2**: 変数キャプチャ・チェーン・環境変数・履歴 JSONL
3. **M3**: SSE 検証・テンプレート関数・レポート拡張・**npm 公開**（スコープ付き `@<ユーザー名>/klaus` を `npm publish --access public`。GitHub Actions でタグ push → ビルド+テスト+publish を自動化し、認証は npm Trusted Publishing（OIDC）を使いトークンを Secrets に置かない。公開前に `npm pack --dry-run` で同梱物を確認）
4. **M4**: localhost UI（`klaus ui` でサーバー起動 + ブラウザ表示）

## 参考にする既製ツール

- 定義 + アサーション一体・exit code 体系: Hurl（hurl.dev）
- ローカルファースト・git-native・CLI と GUI の core 共有: Bruno
- エージェント向け CLI 設計: Arcjet「Designing a CLI for AI agents」
