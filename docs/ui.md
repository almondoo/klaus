# localhost UI

`klaus ui` で起動する Web UI。フローの実行(ライブ進捗付き)と履歴の閲覧ができる**ランナー + ビューア**であり、フロー定義の編集はエディタで行う(git-native 思想)。実行・アサーション・履歴のロジックはすべて CLI と同じ `src/core` を使う。

## 起動

```bash
klaus ui [--port <n>] [--no-open]
```

- 起動するとトークン付き URL(`http://127.0.0.1:<port>/?token=…`)が表示され、ブラウザが自動で開く
- UI アセット(`dist/ui`)が未ビルドの場合は 503 で案内が出る。開発リポジトリでは `pnpm build:all` を先に実行すること(npm インストール版にはビルド済みで同梱される)
- フロー一覧・履歴は**サーバーを起動した cwd** を基準に読まれる。検証したいプロジェクトのルートで起動すること

## 画面

1. **フロー一覧(サイドバー)**: cwd 配下のフロー YAML を一覧表示。パースエラーのあるファイルはエラーアイコン + 理由付きで表示され実行不可。上部の環境セレクタで `--env` 相当の切替、実行ボタンで実行開始
2. **実行ビュー**: ステップが running → pass/fail にライブで遷移(SSE 配信)。「Step n / m」の全体進捗、失敗ステップは自動展開してリクエスト / レスポンス詳細(JSON)を表示、成功ステップはデフォルト折り畳み。完了時にサマリー表示
3. **履歴ブラウザ**: `.klaus/history/*.jsonl` を新しい順に表示。run 単位でグルーピングされ、行クリックでステップ詳細にドリルダウン。フローでのフィルタと「さらに読み込む」ページング

## セキュリティモデル

ローカル専用の設計であり、**リバースプロキシ等で外部公開してはならない**。

| 対策 | 内容 |
|---|---|
| バインド | 127.0.0.1 固定(設定でも変更不可) |
| 認証トークン | 起動時に `crypto.randomBytes(32)` で生成。比較はタイミングセーフ |
| 初回アクセス | `GET /?token=…` の検証成功で `klaus_token` Cookie(SameSite=Strict / HttpOnly)を発行 |
| API 認証 | 全 `/api/*` で `X-Klaus-Token` ヘッダー必須(不一致 401) |
| CSRF | POST はさらに Cookie 一致 + `Origin` ヘッダーが存在する場合は同一オリジンのみ許可 |
| DNS rebinding | 全リクエストで `Host` が `127.0.0.1:<port>` / `localhost:<port>` 以外なら 403 |
| CORS | ヘッダーを一切付けない(同一オリジン配信のみ) |
| path traversal | ファイルパスを受ける API・静的配信で cwd / dist/ui 外への解決を 403 で拒否 |

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
