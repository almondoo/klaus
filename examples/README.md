# examples

klaus の使い方を示すサンプル。**このディレクトリを作業ディレクトリにして実行する**（環境ファイルは実行時のカレントディレクトリ基準で `environments/<name>.yaml` を解決するため）。

```
examples/
├── api/
│   └── login-check.yaml       # 単発チェック: /login だけを1ステップで検証
├── flows/
│   └── auth-flow.yaml        # シナリオフロー: login → token キャプチャ → 認証付きリクエスト
├── environments/
│   ├── local.yaml            # testEmail: test@example.com
│   └── development.yaml       # testEmail: dev@example.com
└── mock-server.mjs           # 動作確認用のダミー API(:3000)
```

klaus に構文上の区別はなく、トップレベルに `steps` を持つ YAML はすべて「フロー定義」として探索・実行される(`src/core/discovery.ts`)。`api/` と `flows/` はディレクトリ名で用途を示しているだけの慣習で、klaus 自身はディレクトリ名を見ない。

- `api/` … 単発 API チェック。1 ステップだけで1つのエンドポイントの動作を素早く確認する書き方。`klaus init` が生成するサンプル(`api/example.yaml`)もこの規約に合わせている。
- `flows/` … シナリオフロー。複数ステップで前段の結果(capture)を後段に引き継ぎながら検証する書き方。ステップに `use: ../api/xxx.yaml` と書くと、`api/` の1ステップフローの request/assert をそのまま再利用できる(`flows/auth-flow.yaml` を参照)。詳細は [フロー定義リファレンス](../docs/guide/flow-definition.md#use-ステップ参照)。

## 実行

```bash
cd examples

klaus run flows/auth-flow.yaml                 # フローの env: local を使う
klaus run flows/auth-flow.yaml --env development   # development に切り替え
klaus run api/login-check.yaml                  # 単発チェックも同じ run コマンドで実行できる
```

`--env` はフロー定義の `env:` を上書きする。環境ファイルを増やせば（`staging.yaml` など）そのまま `--env staging` で切り替えられる。

## 埋め込みの3系統

`{{...}}` は request の url / headers / body、および assert の期待値に埋め込める。

| 記法 | 埋め込まれる値 | 用途 |
|---|---|---|
| `{{baseUrl}}` | 環境ファイルの値 / 前ステップの `capture` 値 | 環境ごとに変わる URL・定数 |
| `{{env.TEST_PASSWORD}}` | OS 環境変数 | シークレット（ファイルに直書きしない） |
| `{{newUuid}}` / `{{newDate}}` / `{{newTimestamp}}` | 生成値 | リクエストごとに一意な値 |

シークレットを渡す例:

```bash
TEST_PASSWORD=... klaus run flows/auth-flow.yaml
```

## 対向 API（動作確認）

同梱の `mock-server.mjs` を起動すれば、そのまま `auth-flow.yaml` を実行できる。

```bash
# ターミナル1: ダミー API を起動
node examples/mock-server.mjs        # → mock API on http://127.0.0.1:3000

# ターミナル2: examples に入って実行
cd examples
node ../dist/cli.js run flows/auth-flow.yaml               # local: $.email == test@example.com
node ../dist/cli.js run flows/auth-flow.yaml --env development   # development: dev@example.com
node ../dist/cli.js run api/login-check.yaml                # 単発チェック: $.token の存在確認
```

mock は login した email をそのまま `/me` で返すので、env を切り替えると `testEmail` の値が変わり、リクエスト内容とアサーション結果も連動して変わる（`--json` や `.klaus/history/*.jsonl` で確認できる）。実運用では `environments/*.yaml` の `baseUrl` を自分の API に向ける。
