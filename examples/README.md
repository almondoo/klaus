# examples

klaus の使い方を示すサンプル。**このディレクトリを作業ディレクトリにして実行する**（環境ファイルは実行時のカレントディレクトリ基準で `environments/<name>.yaml` を解決するため）。

一通りをコピペで確認したい場合は [../verify/CHECKLIST.md](../verify/CHECKLIST.md) を参照(klaus
全体の動作確認手順もこちらに集約している)。`make verify` の Docker コンテナ内(`mock-api`
サービスが同梱)では、`klaus.config.yaml` がコンテナ専用の設定(`environments/docker.yaml` を使う
`run.env: docker`)に自動的に差し替わるため、`--env` を明示しなくてもこのページの表のコマンドが
そのまま動く。明示すればそちらが優先される(`--env docker` は compose ネットワーク越しの名前解決先
を指す)。詳細は [../verify/README.md](../verify/README.md) と verify/CHECKLIST.md の「make verify
のコンテナで実行する場合」を参照。

```
examples/
├── api/
│   ├── login-check.yaml        # 単発チェック: /login だけを1ステップで検証
│   ├── users-check.yaml        # 単発チェック: query / headers / body(JSONPath) / bodySchema の一通りの書き方
│   ├── graphql-check.yaml      # 単発チェック: request.graphql(GraphQL クエリ + variables)
│   ├── sse-events-check.yaml   # 単発チェック: sse:(Server-Sent Events の受信・eventCount/events)
│   └── ws-echo-check.yaml      # 単発チェック: ws:(WebSocket の送受信・messageCount/messages)
├── flows/
│   ├── auth-flow.yaml          # シナリオフロー: login → token キャプチャ → 認証付きリクエスト
│   └── users-crud-flow.yaml    # シナリオフロー: ユーザー作成 → 取得 → 削除(POST/GET/DELETE + capture)
├── environments/
│   ├── local.yaml              # testEmail: test@example.com / wsUrl: ws://127.0.0.1:3000
│   ├── development.yaml        # testEmail: dev@example.com / wsUrl: ws://127.0.0.1:3000
│   └── docker.yaml             # make verify のコンテナ用(baseUrl / wsUrl が mock-api:3000 を指す)
├── openapi/
│   └── users-api.yaml          # klaus generate の題材にする OpenAPI 3.0.3 定義(下記参照)
├── klaus.config.yaml           # klaus run / klaus ui の既定値サンプル(run.env: local。下記参照)
├── .gitignore                  # klaus generate の既定出力先 generated/ を無視
└── mock-server.mjs             # 動作確認用のダミー API(:3000。HTTP + GraphQL + SSE + WebSocket)
```

klaus に構文上の区別はなく、トップレベルに `steps` を持つ YAML はすべて「フロー定義」として探索・実行される(`src/core/discovery.ts`)。`api/` と `flows/` はディレクトリ名で用途を示しているだけの慣習で、klaus 自身はディレクトリ名を見ない。

- `api/` … 単発 API チェック。1 ステップだけで1つのエンドポイントの動作を素早く確認する書き方。`klaus init` が生成するサンプル(`api/example.yaml`)もこの規約に合わせている。
- `flows/` … シナリオフロー。複数ステップで前段の結果(capture)を後段に引き継ぎながら検証する書き方。ステップに `use: ../api/xxx.yaml` と書くと、`api/` の1ステップフローの request/assert をそのまま再利用できる(`flows/auth-flow.yaml` を参照)。詳細は [フロー定義リファレンス](../docs/guide/flow-definition.md#use-ステップ参照)。

## 実行

```bash
cd examples

klaus run flows/auth-flow.yaml                 # klaus.config.yaml の run.env: local が使われる
klaus run flows/auth-flow.yaml --env development   # development に切り替え
klaus run api/login-check.yaml                  # 単発チェックも同じ run コマンドで実行できる
```

環境の優先順位は CLI の `--env` > `klaus.config.yaml` の `run.env` > フロー定義の `env:`。環境ファイルを増やせば（`staging.yaml` など）そのまま `--env staging` で切り替えられる。

## klaus.config.yaml(既定値サンプル)

`klaus.config.yaml` は `klaus run` / `klaus ui` に毎回渡すオプションの既定値を書けるファイルで、cwd から上方探索で見つかる（`.git` のある階層で探索を止める）。このディレクトリの `klaus.config.yaml` は `run.env: local` と `ui.port: 4884` / `ui.host: 127.0.0.1`（いずれも既定値と同じ値だが、config で設定する記入例として明示している）を有効にしており、`examples/` を作業ディレクトリにして実行すれば `klaus run` は `-e local` を、`klaus ui` は `--port` / `--host` を省略できる。CLI で `--env` / `--port` / `--host` を明示すれば config より優先されるため、`--env development` への切り替えや `--port 4885 --no-open` はそのまま効く（`make verify` のコンテナ内では `verify/docker/klaus.config.yaml` がこのファイルを上書きする。`verify/README.md` 参照）。その他の設定可能なキー（`run.report` / `run.reportFile` / `run.history` / `run.mask`、`ui.open`）はコメントアウトした記入例として `klaus.config.yaml` に載せている。詳細は [CLI オプションの既定値](../docs/guide/config.md) を参照。

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

同梱の `mock-server.mjs` を起動すれば、そのまま `auth-flow.yaml` を実行できる。`mock-server.mjs` は WebSocket
サーバーの実装に `ws` パッケージ(リポジトリ root の devDependencies。テストフィクスチャでも使用)を使うため、
リポジトリ root で `pnpm install` 済みであれば examples 側の追加インストールなしにそのまま起動できる。
なお klaus 本体の WebSocket クライアント実装は `ws` に依存していない(undici の WebSocket を使用)。

```bash
# ターミナル1: ダミー API を起動
node examples/mock-server.mjs        # → mock API on http://127.0.0.1:3000

# ターミナル2: examples に入って実行
cd examples
klaus run flows/auth-flow.yaml               # local: $.email == test@example.com
klaus run flows/auth-flow.yaml --env development   # development: dev@example.com
klaus run api/login-check.yaml                # 単発チェック: $.token の存在確認
```

mock は login した email をそのまま `/me` で返すので、env を切り替えると `testEmail` の値が変わり、リクエスト内容とアサーション結果も連動して変わる（`--json` や `.klaus/history/*.jsonl` で確認できる）。実運用では `environments/*.yaml` の `baseUrl` を自分の API に向ける。

### GraphQL / SSE / WebSocket

`mock-server.mjs` は HTTP の CRUD エンドポイントに加えて GraphQL・SSE・WebSocket にも対応している。実行方法は
通常の `klaus run` と同じで、種別ごとにコマンドを分ける必要はない。

```bash
# ターミナル1で mock-server.mjs を起動したまま、ターミナル2で:
cd examples
klaus run api/users-check.yaml         # GET /users(query/headers/body/bodySchema の一通り)
klaus run api/graphql-check.yaml       # POST /graphql(request.graphql)
klaus run api/sse-events-check.yaml    # GET /events(sse: での受信・eventCount/events)
klaus run api/ws-echo-check.yaml       # ws://.../ws(ws: での送受信・messageCount/messages)
klaus run flows/users-crud-flow.yaml   # POST → GET → DELETE の3ステップシナリオ
```

- `api/graphql-check.yaml` は `request.graphql`(`query` + `variables`)を使う。`request.body` とは排他で、
  method は省略すると実行時に POST が既定値になる。
- `api/sse-events-check.yaml` は `sse:` を `request` に併用し、レスポンスを Server-Sent Events ストリームとして
  受信する。`assert.eventCount` / `assert.events` で受信件数・個別イベントを検証できる。
- `api/ws-echo-check.yaml` は `request` の代わりに `ws:` を指定する(`use:` との併用は不可)。URL は
  `environments/*.yaml` の `wsUrl`(`{{wsUrl}}/ws`)を参照する。`assert.messageCount` / `assert.messages` は
  SSE の `eventCount` / `events` とセマンティクスが同じ。

## OpenAPI からの生成(`klaus generate`)

`openapi/users-api.yaml` は `mock-server.mjs` のエンドポイント(login / me / users の一覧・取得・作成・削除)に
対応した OpenAPI 3.0.3 定義。`klaus generate` の入力として、生成 → validate → 実行までの一連の流れを試せる。

```bash
cd examples
klaus generate openapi/users-api.yaml --out-dir generated
```

- `paths` × HTTP メソッドの operation ごとに `generated/<operationId 等を kebab-case 化した名前>.yaml` が
  1ファイルずつ生成される(例: `list-users.yaml` / `get-user.yaml`)。生成前に各ファイルは自動で validate され、
  スキーマを通ったものだけが書き込まれる。
- 生成物はあくまで**骨組み**(`request` + `assert.status` のみ)であり、`api/*.yaml` のような詳細なアサーション
  は付かない。特にパスパラメータを含む operation(`getUser` → `/users/{id}` など)は `url` の `{id}` が
  置換されずそのまま残るため、実際の id 値や `{{userId}}` のようなキャプチャ変数に生成後の手直しが必要になる
  (`flows/users-crud-flow.yaml` の `{{userId}}` を参照)。`getCurrentUser`(`/me`)も同様に、認証ヘッダー
  (`Authorization: "Bearer {{token}}"`)は生成されないため手動で追加する。
- 既に同名のファイルが `generated/` にある場合はスキップされ、上書きされない。もう一度試したい場合は
  `generated/` 配下の該当ファイルを削除してから再実行する。
- `generated/` は `examples/.gitignore` で無視されるため、そのままコミット対象には含まれない。
