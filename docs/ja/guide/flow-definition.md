# フロー定義リファレンス

klaus のリクエスト定義は素の YAML。**1ファイル = 1フロー(複数ステップ)**で、キャプチャとアサーションを定義に内包する。スキーマは zod で検証され、違反は exit 2(ParseError)になる。

## ファイル構造

```yaml
name: 認証フロー        # 必須: フロー名
env: local             # 任意: environments/local.yaml を参照
steps:                 # 必須: 1件以上。name はフロー内で一意
  - name: login
    request: { ... }   # request / ws / use のいずれか一方が必須(排他)
    sse: { ... }       # 任意: SSE 受信設定
    capture: { ... }   # 任意: レスポンスからの変数キャプチャ
    assert: { ... }    # 任意: アサーション
```

- 環境ファイルは cwd から上方探索(`.git` を含む祖先ディレクトリ、またはファイルシステムルートで打ち切り)で `environments/<name>.yaml` を解決する。詳細は [Getting Started](getting-started.md) を参照。`klaus run --env <name>` でフローの `env:` を上書きできる。`klaus run --env-file <path>` は代わりに任意パスの環境ファイルを(上方探索なしで)直接読み込み、`klaus run --var <key=value>` はその上から個別の変数を追加・上書きする([CLI リファレンス](cli.md#klaus-run)参照)
- 環境ファイルは `キー: 文字列値` のフラットなマップ。値にはテンプレート(<code v-pre>{{env.X}}</code> 等)を使える
- 予約キー `$protected: true` を環境ファイルに書くと、その環境への `klaus run` はデフォルトで拒否される(exit 3)。`--allow-protected` を明示した場合のみ実行できる。本番相当の環境を誤って実行しないためのガードレールで、`$protected` はテンプレート変数(<code v-pre>{{...}}</code>)としては参照できない。`klaus ui` / server API 経由の実行はこのフラグを渡さないため、保護環境は常に拒否される
- `$protected` はファイル直接編集でのみ設定・解除する。`klaus ui` の環境エディタには表示されず、UI からの保存でも既存の `$protected` の値は変更されずそのまま保持される

## request(HTTP ステップ)

```yaml
request:
  method: POST                  # graphql 指定時のみ省略可(省略時 POST)。大文字化して扱われる
  url: "{{baseUrl}}/login"      # 必須。テンプレート可
  headers:                      # 任意。値はテンプレート可
    Content-Type: application/json
  query:                        # 任意。値はテンプレート可
    page: "1"                   #   url のクエリ文字列にマージされる。url に同名キーがあれば query 側で上書き
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

## use(ステップ参照)

ステップに `request` / `ws` の代わりに `use:` を書くと、他のフロー定義ファイル(1 ステップのみのもの)を参照して、その request / sse / assert を取り込める。`request` / `ws` / `sse` とは**排他**(併記は ParseError)。同じ API チェックを複数のフローからコピペせずに再利用するための機構で、参照先ファイル自体も従来どおり単体実行できる(`api/` を「実行される API カタログ」として扱う設計。詳細は [examples](https://github.com/almondoo/klaus/tree/main/examples) を参照)。

```yaml
# api/login-check.yaml — 従来どおり単体実行可能
name: ログイン API 単体チェック
steps:
  - name: login
    request:
      method: POST
      url: "{{baseUrl}}/login"
      body: { email: "{{testEmail}}" }
    assert:
      status: 200
      body:
        - path: "$.token"
          exists: true
```

```yaml
# flows/auth-flow.yaml — login を書き直さず参照
name: 認証フロー
steps:
  - name: login
    use: ../api/login-check.yaml   # このフローファイル基準の相対パス
    capture:
      token: "$.token"
  - name: me
    request:
      method: GET
      url: "{{baseUrl}}/me"
      headers:
        Authorization: "Bearer {{token}}"
    assert:
      status: 200
```

- **解決タイミング**: フローのロード時(`klaus run` / `klaus validate` / UI のフロー詳細取得)。参照先の唯一のステップから `request` / `sse` / `assert` を取り込んだ通常ステップに展開してから実行される
- **`name` / `capture` は呼び出し側のもの**を使う。参照先の値は無視される
- **`assert` は加算マージ**(置換ではない): `headers` / `body` / `events` / `messages` は参照先→呼び出し側の順に配列を連結する。`status` / `bodyText` / `duration` / `eventCount` / `messageCount` / `bodySchema` は両側で定義されていると、単体チェックの保証を弱める置換とみなして ParseError / `klaus validate` の FlowIssue になる(どちらか一方にのみ定義するか、参照先の定義に任せる)
- **参照先の `env:` は取り込まない**(環境は常に実行するフロー側が決める)。プレースホルダ(<code v-pre>{{var}}</code>)は取り込んだ後、呼び出し側フローの env / capture で通常どおり解決される
- **パスはこのフローファイル基準の相対パス**。絶対パスは拒否される。解決後のパスがプロジェクトディレクトリ(`klaus` 実行時の cwd)の外に出る場合も拒否される(`../` によるプロジェクト外参照はできない)
- 参照先ステップがさらに `use` を持つ場合は再帰的に解決される。循環参照は検出され拒否される

### v1 の制限

- 参照先は**1 ステップのフローファイルのみ**(複数ステップの取り込み・継承・request フィールドの上書きはスコープ外)
- 参照先は **HTTP request ステップのみ**(`ws:` ステップの参照は非対応)
- 参照切れ・循環参照・複数ステップファイルへの参照・`assert` のスカラー競合は、`klaus validate` では hint 付きの構造化 issue、`klaus run` では ParseError(exit 2)になる

## テンプレート

<code v-pre>{{...}}</code> は以下の順で解決される。**未解決の変数・未定義の OS 環境変数は RuntimeError(exit 3)**になる(黙って空文字にはならない)。

| 記法 | 解決先 |
|---|---|
| <code v-pre>{{var}}</code> | ①それまでのステップのキャプチャ変数 → ②環境ファイルの値(キャプチャ優先) |
| <code v-pre>{{env.X}}</code> | OS 環境変数 `X`。シークレットは定義ファイルに直書きせずこれを使う |
| <code v-pre>{{newUuid}}</code> | `crypto.randomUUID()` の UUID |
| <code v-pre>{{newDate}}</code> | 現在時刻の ISO 8601 文字列 |
| <code v-pre>{{newTimestamp}}</code> | 現在時刻の epoch ミリ秒 |

展開が適用される場所: `request.url` / `request.headers` の値 / `request.query` の値 / `request.body`(文字列値の深い展開)/ `graphql.query` / `graphql.variables` / `ws.url` / `ws.headers` / `ws.send` / アサーションの期待値(<code v-pre>equals: "{{testEmail}}"</code> 等)。

## capture(変数キャプチャ)

```yaml
capture:
  token: "$.token"            # 変数名: JSONPath
  userId: "$.data.user.id"    # ネストしたフィールド
  firstId: "$.items[0].id"    # 配列インデックス
```

- JSON レスポンスに JSONPath を適用し、結果を後続ステップのテンプレート変数にする(ログイン → トークン → Authorization ヘッダーが代表ケース)
- **マッチしない・レスポンスが JSON でない場合は RuntimeError** になりステップは error(exit 3)。`Bearer undefined` のようなサイレント連鎖は起きない。値が `null` のキャプチャは成功扱い
- **キャプチャした値はマスクされない**。シークレットマスクの対象は <code v-pre>{{env.X}}</code> で解決した値のみのため、ここでキャプチャしたトークンは履歴 JSONL・JUnit レポート・record カセットにそのまま書き込まれる。マスクの境界は [SECURITY.md](https://github.com/almondoo/klaus/blob/main/SECURITY.md) を参照
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
  bodySchema:
    type: object
    required: [id, email]
    properties:
      id: { type: integer }
      email: { type: string, format: email }
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
| ボディ(JSON Schema) | `bodySchema` | JSON Schema オブジェクト |
| 所要時間 | `duration` | `maxMs` |
| SSE イベント数 | `eventCount` | `min` / `max` / `equals` |
| SSE イベント | `events[]` | `index?` + `path?` + 上記マッチャー |
| WS メッセージ数 | `messageCount` | `min` / `max` / `equals` |
| WS メッセージ | `messages[]` | `index?` + `path?` + 上記マッチャー |

`events` / `messages` の共通セマンティクス:

- `index` 指定時: そのインデックスの受信データに対して評価
- `index` 省略時: **いずれかの受信データが一致すれば pass**
- `path` 指定時: 受信データ(`data`)を JSON parse して JSONPath を適用。省略時は生文字列にマッチャーを適用

### bodySchema(JSON Schema によるボディ検証)

- `bodySchema` には JSON Schema オブジェクトを YAML に直接埋め込む(外部ファイル参照は現時点で非対応)
- 検証は [ajv](https://ajv.js.org/) の **draft 2020-12**(`Ajv2020`)で行う。OpenAPI 3.1 由来のスキーマもおおむねそのまま使える
- スキーマに複数の違反があった場合、**違反ごとに個別の `AssertionResult`** が返る(1件目で打ち切らず一括報告される)。各結果の `message` には ajv の `instancePath`(ルート違反の場合は `(root)`)と違反内容が含まれる
- body が存在しない SSE / WS ステップでは ok:false になる。body が存在するが JSON としてパースできない HTTP レスポンスは、生の文字列のままスキーマ検証にかけられる(例: `type: object` を要求するスキーマなら失敗し、`type: string` なら通り得る)
- スキーマ自体が不正で ajv がコンパイルできない場合も、例外にはならず ok:false のアサーション失敗として報告される

## retry

```yaml
retry:
  count: 3          # 必須。初回実行後のリトライ回数(1〜100)
  intervalMs: 500   # 任意。試行間の固定待機時間(ミリ秒)。既定値は 1000
```

- `count` は初回実行「後」のリトライ回数なので、ステップは合計で**最大 `count + 1` 回**実行される
- ステップの結果が **`failed`**(アサーション失敗)または **`error`**(接続エラー・タイムアウト等の例外)になった場合にリトライする。`passed` になった時点で `count` を使い切っていなくても即座にループを止める
- 試行間の待機は `intervalMs` による固定値(バックオフや条件式は無い)
- `request` / `sse` / `ws` すべてのステップ種別に一律で適用される(ステップ全体、つまりリクエスト/レスポンスとアサーションをまとめて再実行する)
- **記録されるのは最終試行のみ**: ステップ結果・履歴エントリともに1件、`onStepStart` / `onStepComplete` もステップごとに1回ずつ呼ばれる。途中の failed / error な試行は保持されない
- `retry` を設定すると、結果と履歴エントリに実際に実行された試行回数(1 以上)を表す `attempts` フィールドが付く。`retry` 未設定時は `attempts` は省略される。`durationMs` は従来どおり最終試行自体の所要時間のまま変わらない

## ステップ失敗時のフロー挙動

- ステップが **failed**(アサーション失敗)または **error**(runtime エラー)になると、そのフローの**残りステップは実行されず skipped** として記録される
- 複数フローファイルを渡した場合、あるフローが失敗しても**他のフローは実行される**
- 最終 exit code は [CLI リファレンス](cli.md#exit-code) の優先ルールに従う

## JSON Schema

フロー定義のスキーマは JSON Schema としても公開している。エディタの補完・バリデーションや、AI エージェントがフロー YAML を生成する際の参照に使える。

- 公開 URL: `https://almondoo.github.io/klaus/schema/flow.schema.json`
- npm パッケージ同梱パス: `node_modules/@almondoo/klaus/dist/schema/flow.schema.json`

YAML ファイルの先頭に `# yaml-language-server: $schema=` コメントを書くと、対応エディタ(VS Code の YAML 拡張など)で補完・検証が効くようになる。

```yaml
# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json
name: 認証フロー
steps:
  - name: login
    request:
      method: POST
      url: "{{baseUrl}}/login"
```

**注意**: `request.body` と `request.graphql` の排他、`step.request` / `step.ws` / `step.use` のどちらか一方が必須、`ws.url` のスキーム制約、ステップ名の一意性など、このページで説明した `superRefine` によるチェックは JSON Schema の構造そのものには表現されない(対象プロパティの `description` に注記としては含まれる)。これらは `klaus validate` / `klaus run` の実行時検証でのみ強制される。`use:` の参照解決(パス境界・循環参照・assert の加算マージなど)も同様に、スキーマ検証ではなく `klaus validate` / `klaus run` のロード時検証で行われる。
