# フロー定義リファレンス

klaus のリクエスト定義は素の YAML。**1ファイル = 1フロー(複数ステップ)**で、キャプチャとアサーションを定義に内包する。スキーマは zod で検証され、違反は exit 2(ParseError)になる。

## ファイル構造

```yaml
name: 認証フロー        # 必須: フロー名
env: local             # 任意: environments/local.yaml を参照
steps:                 # 必須: 1件以上。name はフロー内で一意
  - name: login
    request: { ... }   # request / ws のどちらか一方が必須(排他)
    sse: { ... }       # 任意: SSE 受信設定
    capture: { ... }   # 任意: レスポンスからの変数キャプチャ
    assert: { ... }    # 任意: アサーション
```

- 環境ファイルは cwd から上方探索(`.git` を含む祖先ディレクトリ、またはファイルシステムルートで打ち切り)で `environments/<name>.yaml` を解決する。詳細は [Getting Started](getting-started.md) を参照。`klaus run --env <name>` でフローの `env:` を上書きできる
- 環境ファイルは `キー: 文字列値` のフラットなマップ。値にはテンプレート(<code v-pre>{{env.X}}</code> 等)を使える

## request(HTTP ステップ)

```yaml
request:
  method: POST                  # graphql 指定時のみ省略可(省略時 POST)。大文字化して扱われる
  url: "{{baseUrl}}/login"      # 必須。テンプレート可
  headers:                      # 任意。値はテンプレート可
    Content-Type: application/json
  body:                         # 任意。object → JSON 送信(Content-Type 未指定なら application/json を自動付与)
    email: "{{testEmail}}"      #        string → そのまま送信
  timeoutMs: 30000              # 任意。デフォルト 30000。超過は RuntimeError(exit 3)
```

レスポンスは Content-Type が JSON なら自動でパースされ、JSONPath アサーション / キャプチャの対象になる。それ以外はテキストとして保持され `bodyText` アサーションの対象になる。リダイレクト・TLS の挙動は undici のデフォルトに従う(klaus 側では制御しない)。

## GraphQL

`request.graphql` を指定すると GraphQL リクエストの糖衣になる。**`body` とは排他**(両方指定は ParseError)。

```yaml
request:
  url: "{{baseUrl}}/graphql"
  graphql:
    query: 'query { user(id: "{{userId}}") { id name } }'   # テンプレート可
    variables:                                              # 任意。テンプレート可
      limit: 10
```

- method 省略時は POST、Content-Type 未指定時は application/json
- 送信 body は `{ query, variables }`(variables 未指定なら `{ query }` のみ)
- レスポンスは通常の JSON として扱われるため、`$.data.…` / `$.errors` への JSONPath アサーション・キャプチャがそのまま使える

## SSE(Server-Sent Events)

`Accept: text/event-stream` ヘッダーがある、または `sse:` ブロックを書いたステップは SSE モードになる。

```yaml
request:
  method: GET
  url: "{{baseUrl}}/events"
  headers:
    Accept: text/event-stream
sse:
  maxEvents: 5          # デフォルト 100
  maxDurationMs: 3000   # デフォルト 10000
```

- `maxEvents` / `maxDurationMs` の**どちらかに達した時点で受信を打ち切り、正常終了**する(打ち切りは失敗ではない)
- 受信イベントは `{ event?, id?, data }` の配列として結果の `events` に入る。`response.body` は undefined
- `capture` は SSE ステップでは**無視される**
- アサーションは `eventCount` / `events`(後述)を使う

## WebSocket

ステップに `request` の代わりに `ws:` を書く(**排他・どちらか必須**)。

```yaml
ws:
  url: "{{wsBaseUrl}}/socket"   # ws:// / wss://(http(s):// は ParseError)。テンプレート可
  headers:                      # 任意
    Authorization: "Bearer {{token}}"
  send:                         # 任意: 接続後に順次送信。string はそのまま、object は JSON 化。テンプレート可
    - "ping"
    - { type: subscribe, channel: orders }
  maxMessages: 50               # デフォルト 100
  maxDurationMs: 5000           # デフォルト 10000
```

- 受信メッセージが `maxMessages` / `maxDurationMs` のどちらかに達したら打ち切って正常終了。相手からの正常 close も正常終了
- 接続失敗・異常 close は RuntimeError(exit 3)
- 受信メッセージは `{ data }` の配列として結果の `wsMessages` に入る。`response` は持たない
- `capture` は WS ステップでは**無視される**
- アサーションは `messageCount` / `messages`(後述)を使う

## テンプレート

<code v-pre>{{...}}</code> は以下の順で解決される。**未解決の変数・未定義の OS 環境変数は RuntimeError(exit 3)**になる(黙って空文字にはならない)。

| 記法 | 解決先 |
|---|---|
| <code v-pre>{{var}}</code> | ①それまでのステップのキャプチャ変数 → ②環境ファイルの値(キャプチャ優先) |
| <code v-pre>{{env.X}}</code> | OS 環境変数 `X`。シークレットは定義ファイルに直書きせずこれを使う |
| <code v-pre>{{newUuid}}</code> | `crypto.randomUUID()` の UUID |
| <code v-pre>{{newDate}}</code> | 現在時刻の ISO 8601 文字列 |
| <code v-pre>{{newTimestamp}}</code> | 現在時刻の epoch ミリ秒 |

展開が適用される場所: `request.url` / `request.headers` の値 / `request.body`(文字列値の深い展開)/ `graphql.query` / `graphql.variables` / `ws.url` / `ws.headers` / `ws.send` / アサーションの期待値(<code v-pre>equals: "{{testEmail}}"</code> 等)。

## capture(変数キャプチャ)

```yaml
capture:
  token: "$.token"     # 変数名: JSONPath
```

- JSON レスポンスに JSONPath を適用し、結果を後続ステップのテンプレート変数にする(ログイン → トークン → Authorization ヘッダーが代表ケース)
- **マッチしない・レスポンスが JSON でない場合は RuntimeError** になりステップは error(exit 3)。`Bearer undefined` のようなサイレント連鎖は起きない。値が `null` のキャプチャは成功扱い
- SSE / WS ステップでは無視される

## assert(アサーション)

すべて任意。複数書いた場合はすべて評価され、1つでも失敗すればステップは failed(exit 4)。1つのエントリに複数マッチャーを書くと、マッチャーごとに個別の結果(`AssertionResult`)が出る。

```yaml
assert:
  status: 200
  headers:
    - { name: content-type, contains: json }
  body:
    - { path: "$.token", exists: true }
    - { path: "$.email", equals: "{{testEmail}}" }
  bodyText:
    contains: "ok"
  duration:
    maxMs: 1000
  # SSE 用
  eventCount: { min: 1, max: 10 }
  events:
    - { index: 0, path: "$.type", equals: "message" }
  # WebSocket 用
  messageCount: { min: 1 }
  messages:
    - { path: "$.type", contains: "order" }
```

### マッチャー一覧

| 対象 | フィールド | マッチャー |
|---|---|---|
| ステータス | `status` | 数値の完全一致 |
| ヘッダー | `headers[]` | `name` + `equals` / `contains` / `regex` / `exists` |
| ボディ(JSONPath) | `body[]` | `path` + `exists` / `equals` / `contains` / `regex` |
| ボディ(生テキスト) | `bodyText` | `equals` / `contains` / `regex` |
| 所要時間 | `duration` | `maxMs` |
| SSE イベント数 | `eventCount` | `min` / `max` / `equals` |
| SSE イベント | `events[]` | `index?` + `path?` + 上記マッチャー |
| WS メッセージ数 | `messageCount` | `min` / `max` / `equals` |
| WS メッセージ | `messages[]` | `index?` + `path?` + 上記マッチャー |

`events` / `messages` の共通セマンティクス:

- `index` 指定時: そのインデックスの受信データに対して評価
- `index` 省略時: **いずれかの受信データが一致すれば pass**
- `path` 指定時: 受信データ(`data`)を JSON parse して JSONPath を適用。省略時は生文字列にマッチャーを適用

## ステップ失敗時のフロー挙動

- ステップが **failed**(アサーション失敗)または **error**(runtime エラー)になると、そのフローの**残りステップは実行されず skipped** として記録される
- 複数フローファイルを渡した場合、あるフローが失敗しても**他のフローは実行される**
- 最終 exit code は [CLI リファレンス](cli.md#exit-code) の優先ルールに従う
