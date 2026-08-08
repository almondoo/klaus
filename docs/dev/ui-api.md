# klaus ui — HTTP API と内部構成

利用者向けの使い方は [../guide/ui.md](../guide/ui.md) を参照。

## HTTP API リファレンス

UI が使う API。すべて `X-Klaus-Token` ヘッダーが必要。

| メソッド / パス | パラメータ | 説明 |
|---|---|---|
| `GET /api/flows` | — | cwd 以下を再帰走査(node_modules / .git / dist / .klaus / ui / environments / tmp を除外)し、最上位に `steps` キーを持つ YAML を列挙。パース成功はフロー情報、失敗はエラー理由付き |
| `GET /api/flows/detail` | `path` | 1フローのパース済み定義(ステップ概要含む) |
| `GET /api/environments` | — | `environments/*.yaml` の環境名一覧(ディレクトリ無しは空配列) |
| `POST /api/runs` | body: `{ path, env? }` | フロー実行。レスポンスは SSE ストリーム(下記) |
| `GET /api/history` | `flow` / `limit`(デフォルト 50)/ `before`(ISO 日時カーソル) | 履歴を新しい順にページングして返す。未知の `v` の行はスキップ |

### POST /api/runs の SSE イベント

| イベント | ペイロード | タイミング |
|---|---|---|
| `step-start` | `{ flow, file, step }` | ステップ開始時 |
| `step-result` | `{ flow, file, result: StepResult }` | ステップ完了時(skipped 含む) |
| `run-result` | `{ flow: FlowResult }` | フロー完了時(最後に1回) |

**クライアント切断時の挙動**: ブラウザを閉じる・リロードしても実行中のフローは**最後まで完走し、履歴も全ステップ分書き込まれる**。切断されるのは SSE 配信だけで、サーバーは後続リクエストに正常に応答し続ける。

## アーキテクチャ上の位置づけ

サーバー(Hono)は `src/core` の `runFlow` を呼び、`onStepStart` / `onStepComplete` コールバックを SSE にブリッジしているだけの薄い層。詳細は [アーキテクチャ](architecture.md)、設計意図は [ui-design.md](ui-design.md) / [ui-ux-design.md](ui-ux-design.md) を参照。
