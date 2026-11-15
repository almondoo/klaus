# フロー定義リファレンス

klaus のリクエスト定義は素の YAML。**1ファイル = 1フロー(複数ステップ)**で、キャプチャとアサーションを定義に内包する。スキーマは zod で検証され、違反は exit 2(ParseError)になる。

## ファイル構造

```yaml
name: 認証フロー        # 必須: フロー名
env: local             # 任意: environments/local.yaml を参照
tags: [smoke, auth]    # 任意: フロー単位のタグ。`klaus run --tags` / `--exclude-tags` で使う
steps:                 # 必須: 1件以上。name はフロー内で一意
  - name: login
    request: { ... }   # request / ws / use のいずれか一方が必須(排他)
    sse: { ... }       # 任意: SSE 受信設定
    capture: { ... }   # 任意: レスポンスからの変数キャプチャ
    assert: { ... }    # 任意: アサーション
```

- 環境ファイルは cwd から上方探索(`.git` を含む祖先ディレクトリ、またはファイルシステムルートで打ち切り)で `environments/<name>.yaml` を解決する。詳細は [Getting Started](getting-started.md) を参照。`klaus run --env <name>` でフローの `env:` を上書きできる。`klaus run --env-file <path>` は代わりに任意パスの環境ファイルを(上方探索なしで)直接読み込み、`klaus run --var <key=value>` はその上から個別の変数を追加・上書きする([CLI リファレンス](cli.md#klaus-run)参照)
- 環境ファイルは `キー: 文字列値` のフラットなマップ。値にはテンプレート(<code v-pre>{{env.X}}</code> 等)を使える
- 予約キー `$protected: true` を環境ファイルに書くと、その環境への `klaus run` はデフォルトで拒否される(exit 3)。`--allow-protected` を明示した場合のみ実行できる。本番相当の環境を誤って実行しないためのガードレールで、`$protected` はテンプレート変数(<code v-pre>{{...}}</code>)としては参照できない。`klaus ui` / server API 経由のフロー実行はこのフラグを渡さないため、常に拒否される
- `$protected: readonly` はより緩いモード: `--allow-protected` なしでは `GET` / `HEAD` / `OPTIONS` のステップは実行され、それ以外のメソッド(および WebSocket)は exit 3 で拒否される。GraphQL ステップは既定で `POST` のため拒否される。[CLI リファレンス](cli.md#保護環境-protected)を参照
- `$protected` はファイル直接編集でのみ設定・解除する。`klaus ui` の環境エディタには表示されず、保護環境(`true` / `readonly`)への UI からの保存は 403 で拒否されるため、ファイルを直接編集すること

## tags

```yaml
name: 認証フロー
tags: [smoke, auth]   # 任意: 空文字列を含まない文字列配列。一意性の制約は無い
steps: [ ... ]
```

- フロー単位のみ — ステップ単位のタグは無い
- `klaus run --tags <list>` / `--exclude-tags <list>` によるフロー選択専用([CLI リファレンス](cli.md#タグによるフロー選択-tags-exclude-tags)参照)。タグ自体は実行に他の影響を与えない
- `klaus ui` や server API には公開されない

## http(HTTP クライアント設定)

```yaml
name: login flow
http:
  followRedirects: true   # 省略可: 3xx を 1 ホップずつ追う(既定 false)
  maxRedirects: 5         # 省略可: 既定 10
  cookies: true           # 省略可: この実行の間 Set-Cookie をメモリ上に保持する(既定 false)
steps: [ ... ]
```

- `auth` はフロー全体の既定の[認証ヘルパー](#auth認証ヘルパー)で、ステップ自身の `request.auth` が優先する。
- `maxResponseBytes` は、レスポンスボディ(または SSE ストリーム)をメモリに読み込む最大バイト数(既定 104857600 = 100 MiB)。超えるとメモリを使い切る代わりに、明確なメッセージでステップを `error` にする。
- リクエスト URL のホスト・ポートと違う `Host` ヘッダーは、`guard.allowedHosts` を設定しているか `http.proxy` を設定しているときは拒否する(安全柵の拒否として履歴に残る)。許可リスト外の仮想ホストへ到達できてしまうためで、どちらも無ければ書いたとおりに送る。proxy 設定中は、ホップ間ヘッダーの `Connection`・`Keep-Alive`・`TE`・`Trailer`・`Upgrade`・`Transfer-Encoding` も拒否し、`Proxy-Authorization` は黙って取り除く(proxy の認証情報は設定ファイルからだけ)。
- 認証情報を含む `Location`(`https://user:pass@host/`)のリダイレクトは辿らない。フラグメントは、URL を記録・送信する前に落とす。
- フローの実行 1 回につき HTTP クライアントを 1 つ作り、全ステップ(HTTP・SSE・WebSocket)で共有する。実行終了時に閉じる。cookie は保存しない。
- 各キーは `klaus.config.yaml` の `http` セクション([HTTP クライアント](config.md#http-クライアント-http))の同じキーを上書きする。何も指定しなければリダイレクトを追わず、cookie も保持しない。
- リダイレクトの各ホップは通常のリクエストと同じく `guard.allowedHosts` と `$protected` の判定を通る。拒否されたホップはステップを `error`(終了コード 3)にし、履歴に残る。経由した URL はステップ結果・履歴・`run` の JSON 出力の `redirects` に入る。
- 別オリジン(スキーム・ホスト・ポートのいずれかが違う。同じホストでの https から http への格下げも含む)へ移るときは、ユーザーが指定したヘッダーのうち内容交渉のもの(`Accept`・`Accept-Language`・`Accept-Encoding`・`User-Agent`、ボディを保つ `307` / `308` では `Content-Type`・`Content-Language` も)**だけ**を転送し、それ以外は名前・値に関わらずすべて落とす。`Authorization`・`Cookie`・`Proxy-Authorization`、`X-Api-Key` などの API キー、先のレスポンスから capture してカスタムヘッダーで送るセッショントークンも含む(capture した値は秘密値として登録されないため、値で判定する規則では漏れる)。フロー側で例外にする指定はない。同一オリジンのホップは全ヘッダーを保つ。落としたヘッダー名(ホップごと、名前のみ)はステップ結果と履歴の `droppedHeaders` に入る。
- cookie の値は値ではなく位置でマスクする: `Cookie` リクエストヘッダーと `Set-Cookie` レスポンスヘッダーの各ペアの値部分は、履歴・出力・カセット・レポートで `***` と表示される(`Path` などの属性は残る)。cookie の値は部分一致の秘密値として登録しないため、`json` や `true` のような短い値が無関係な出力を壊すことはない。`capture: { x: { cookie: name } }` で取り出した値は実行中は使え、その時点から秘密値として登録されるので、表示されるどこでもマスクされる。サーバーがレスポンスボディに cookie の値をそのまま返す場合は、この規則ではマスクされない。cookie は各ホップと WebSocket のハンドシェイクのたびに jar から付け直す。`Secure` cookie は `http://` に送らない。
- cookie はサブドメイン間でもポート間でも共有されない: `Domain` が親ドメインを指していても、cookie は設定したホストとポートそのものに対してだけ保存する(公開サフィックス一覧を持たないための安全側の挙動。RFC 6265 はポートを区別しないが、同じホストの別ポートで動く無関係なローカルサービスどうしが cookie を見られてはならないため)。スキームは範囲に含めない(同じポートの `http` と `https` は同じ範囲で、`Secure` は別に判定する)。あるサブドメインやポートでログインして別のものを呼ぶフローは、ログインのレスポンスから取り出したセッションをヘッダーで明示的に渡す。
- `proxy` と `tls` は**フローには書けない**(検証エラー、終了コード 2)。通信の行き先と信頼先を決めるため、`klaus.config.yaml` にだけ書ける。

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
  # form / multipart / bodyFile: body の代わりに使える(下記を参照)
  timeoutMs: 30000              # 任意。デフォルト 30000。超過は RuntimeError(exit 3)
```

レスポンスは Content-Type が JSON なら自動でパースされ、JSONPath アサーション / キャプチャの対象になる。それ以外はテキストとして保持され `bodyText` アサーションの対象になる。`http.followRedirects` を指定しない限りリダイレクトは追わない([http](#http-http-クライアント設定)を参照)。

`url` にすでに書かれたクエリ文字列は、書かれたままの文字列で保つ(再パース・再エンコードしないため、`&`・`+`・`=`・`/` を含む値も書いたとおりにサーバーへ届く)。追加するのは `query` の項目だけで、form-urlencoded でエンコードする。キーが `url` にすでにある項目は、最初の出現を置き換え、以降の同名を取り除く。

### form・multipart・bodyFile

```yaml
request:
  method: POST
  url: "{{baseUrl}}/login"
  form:                          # application/x-www-form-urlencoded
    username: "{{user}}"
    password: "{{env.PASSWORD}}"
```

```yaml
request:
  method: POST
  url: "{{baseUrl}}/upload"
  multipart:                     # multipart/form-data
    title: "Quarterly report"    #   文字列はテキストフィールド
    attachment:                  #   `file` を持つオブジェクトはファイルのアップロード
      file: reports/q3.pdf       #     cwd からの相対パス(必須)
      filename: q3.pdf           #     省略可。既定はファイルのベース名
      contentType: application/pdf   # 省略可
```

```yaml
request:
  method: PUT
  url: "{{baseUrl}}/blobs/1"
  headers: { Content-Type: application/octet-stream }
  bodyFile: blobs/one.bin        # ファイルのバイト列をそのままボディとして送る
```

- `body`・`graphql`・`form`・`multipart`・`bodyFile` は同時に指定できない(指定すると検証エラー)。値とファイルパスはテンプレートを使える。
- `form` は、`Content-Type` を指定していなければ `Content-Type: application/x-www-form-urlencoded` を付ける。`multipart` は常に boundary つきの `Content-Type: multipart/form-data` を付け、multipart のリクエストに指定した `Content-Type` ヘッダーは無視される。`bodyFile` は `Content-Type` を付けないため、API が必要とする場合は `headers` に指定する。
- ファイルはカレントディレクトリの配下(シンボリックリンクは先に解決する)に限る。`step.use` や `klaus req --body @file` と同じ規則で、フローがマシン上の任意のファイルを送れないようにするためである。cwd の外のパスは安全柵の拒否と同じ扱いで、ステップは `error`(終了コード 3)になり、何も送信されず、拒否は履歴に残る。存在しないファイルやディレクトリも `error`。ファイルは送信の直前に読む。
- 履歴・`--json` 出力・`--dry-run` には、ファイルパートと `bodyFile` についてファイル名とサイズだけを記録し(例: `{ "bodyFile": "blobs/one.bin", "size": 5 }`)、内容は残さない。`form` の値と multipart のテキストフィールドに含まれる秘密値は、エンコード形も含めてマスクされる。
- `http.followRedirects` では、`307` / `308` はボディ(ファイルを含む)を再送し、`POST` への `301` / `302` と `303` はボディなしの `GET` になる。

## auth(認証ヘルパー)

```yaml
http:
  auth:                                  # 省略可: フロー内の全 HTTP / SSE ステップの既定
    bearer: { token: "{{env.API_TOKEN}}" }
steps:
  - name: admin call
    request:
      method: GET
      url: "{{baseUrl}}/admin"
      auth:                              # 省略可: このステップだけ http.auth を上書き
        basic: { username: admin, password: "{{env.ADMIN_PASSWORD}}" }
  - name: public call
    request:
      method: GET
      url: "{{baseUrl}}/public"
      auth: none                         # 継承した http.auth をこのステップだけ無効にする
  - name: machine to machine
    request:
      method: GET
      url: "{{baseUrl}}/reports"
      auth:
        oauth2:
          grant: client_credentials      # 対応する grant はこれだけ
          tokenUrl: "{{authUrl}}/oauth/token"
          clientId: "{{clientId}}"
          clientSecret: "{{env.CLIENT_SECRET}}"
          scope: "reports:read"          # 省略可
          audience: "https://api.example.com"   # 省略可
```

- `basic` / `bearer` / `oauth2` のうち 1 つだけ(または文字列 `none`)。値はすべてテンプレートを使える。ヘルパーは `Authorization` ヘッダーを設定するため、ステップが自分で `Authorization` ヘッダーも指定しているとエラーになる。
- `basic` は `Authorization: Basic <base64(username:password)>`、`bearer` は `Authorization: Bearer <token>` を送る。
- `oauth2` は `tokenUrl` へ `POST`(`application/x-www-form-urlencoded`。ボディに `grant_type`・`client_id`・`client_secret` と、指定時は `scope` / `audience`)してアクセストークンを取得し、`Authorization: Bearer <token>`(サーバーが返す `token_type` があればそれ)として送る。トークンは実行中キャッシュし、`expires_in` が過ぎたら(5 秒早めに)取り直す。`expires_in` がなければ実行の間ずっと使う。トークン取得はステップではないため履歴には残らないが、通常のリクエストと同じ判定を通る: `guard.allowedHosts` を満たす必要があり(トークンエンドポイントのホストも許可リストに要る)、`$protected: readonly` では `POST` のため拒否される(そのフローは `--allow-protected` で実行する)。リダイレクトは追わず、`--record` / `--replay` でも動く。トークン取得の失敗はシークレットを出さずにステップを `error` にする。
- パスワード・トークン・クライアントシークレット・取得したアクセストークン・`username:password` の base64 形は秘密値で、履歴・標準出力・JSON・レポート・エラーメッセージでマスクされる(4 文字未満の秘密値は認識されない)。
- `auth` は HTTP と SSE のステップに効く。WebSocket ステップは自分の `headers` で指定する。
- 別オリジンへのリダイレクトでは `Authorization` ヘッダーを落とす([http](#http-http-クライアント設定)を参照)。`klaus run --dry-run` は秘密値をマスクしたヘッダーを表示し、トークンは取得しない(OAuth2 のステップにはプレースホルダーが出る)。

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
  requestId: { header: X-Request-Id }          # レスポンスヘッダー(名前は大文字小文字を無視)
  session: { cookie: sid }                     # run の cookie jar の値(http.cookies: true が必要)
  orderNo: { regex: "order=(\\w+)", group: 1 }  # レスポンス本文テキストへの正規表現
  code: { status: true }                       # HTTP ステータスコード(数値)
```

- JSON レスポンスに JSONPath を適用し、結果を後続ステップのテンプレート変数にする(ログイン → トークン → Authorization ヘッダーが代表ケース)
- **マッチしない・レスポンスが JSON でない場合は RuntimeError** になりステップは error(exit 3)。`Bearer undefined` のようなサイレント連鎖は起きない。値が `null` のキャプチャは成功扱い
- **キャプチャした値はマスクされない**。シークレットマスクの対象は <code v-pre>{{env.X}}</code> で解決した値のみのため、ここでキャプチャしたトークンは履歴 JSONL・JUnit レポート・record カセットにそのまま書き込まれる。マスクの境界は [SECURITY.md](https://github.com/almondoo/klaus/blob/main/SECURITY.md) を参照
- オブジェクト形式(いずれも 1 キーだけ。キーを混ぜると ParseError):
  - `{header: name}`: レスポンスヘッダーの値。無ければ RuntimeError
  - `{cookie: name}`: run の cookie jar にある cookie の現在値(最終 URL で引くため、リダイレクト途中のホップで付いた cookie も含む)。`http.cookies: true` が必要で、jar が無い・該当 cookie が無い場合は RuntimeError
  - `{regex, group?}`: レスポンス本文テキストに適用する(JSON でない本文にも使える)。`group` の既定は、パターンにキャプチャグループがあれば 1、無ければ 0(マッチ全体)。不一致・参加しなかったグループは RuntimeError。パターンは書いたまま使う(capture 定義はテンプレート展開されないため、別の capture で差し替えられない)
  - `{status: true}`: ステータスコードを数値で取得
- エラーメッセージにはキャプチャした値やレスポンス本文を含めない
- SSE / WS ステップでは無視される

## assert(アサーション)

すべて任意。複数書いた場合はすべて評価され、1つでも失敗すればステップは failed(exit 4)。1つのエントリに複数マッチャーを書くと、マッチャーごとに個別の結果(`AssertionResult`)が出る。

```yaml
assert:
  status: 200                 # [200, 201](いずれか)や "2xx"(ステータスクラス)も可
  headers:
    - { name: content-type, contains: json }
    - { name: content-length, lte: 100000 }
  body:
    - { path: "$.token", exists: true, type: string, length: { min: 20 } }
    - { path: "$.email", equals: "{{testEmail}}" }
    - { path: "$.total", gte: 0 }
    - { path: "$.state", oneOf: [pending, paid] }
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
  snapshot:                   # 保存した基準と比較する(下の「snapshot」を参照)
    ignore: ["$.id"]
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
| ステータス | `status` | 数値(完全一致)・数値の配列(いずれか)・`"2xx"`(`1xx`〜`5xx` のクラス) |
| ヘッダー | `headers[]` | `name` + `equals` / `contains` / `regex` / `exists` + 下記の比較マッチャー |
| ボディ(JSONPath) | `body[]` | `path` + `exists` / `equals` / `contains` / `regex` + 下記の比較マッチャー |
| ボディ(生テキスト) | `bodyText` | `equals` / `contains` / `regex` |
| ボディ(JSON Schema) | `bodySchema` | JSON Schema オブジェクト |
| 所要時間 | `duration` | `maxMs` |
| 基準との比較(HTTP のみ) | `snapshot` | `true`、または `ignore` / `include` / `headers` / `name`([snapshot](#snapshot-基準との比較)を参照) |
| SSE イベント数 | `eventCount` | `min` / `max` / `equals` |
| SSE イベント | `events[]` | `index?` + `path?` + 上記マッチャー |
| WS メッセージ数 | `messageCount` | `min` / `max` / `equals` |
| WS メッセージ | `messages[]` | `index?` + `path?` + 上記マッチャー |

比較マッチャー(`headers[]` と `body[]` のみ。マッチャーごとに個別の結果が出て、値が存在しなければ失敗):

| マッチャー | pass の条件 |
|---|---|
| `gt` / `gte` / `lt` / `lte` | 値が数値で、比較を満たす。`body[]` では `"7"` のような数値文字列は数値として扱わない。ヘッダー値は常に文字列なので、ヘッダーでは数値文字列を数値として比較する(数値でなければ失敗) |
| `length` | 文字列・配列の長さが指定値(数値)と一致、または `{min, max}` の範囲内(両端を含み、片方だけも可)。オブジェクトなど他の型は失敗 |
| `type` | JSON 型が `string` / `number` / `integer` / `boolean` / `null` / `array` / `object` のいずれかと一致(`number` は整数も受け入れる) |
| `oneOf` | 値が配列のいずれかの要素と構造的に等しい(オブジェクト・配列も可) |

`events` / `messages` の共通セマンティクス(`exists` / `equals` / `contains` / `regex` のみ使える):

- `index` 指定時: そのインデックスの受信データに対して評価
- `index` 省略時: **いずれかの受信データが一致すれば pass**
- `path` 指定時: 受信データ(`data`)を JSON parse して JSONPath を適用。省略時は生文字列にマッチャーを適用

### bodySchema(JSON Schema によるボディ検証)

- `bodySchema` には JSON Schema オブジェクトを YAML に直接埋め込む(外部ファイル参照は現時点で非対応)
- 検証は [ajv](https://ajv.js.org/) の **draft 2020-12**(`Ajv2020`)で行う。OpenAPI 3.1 由来のスキーマもおおむねそのまま使える
- スキーマに複数の違反があった場合、**違反ごとに個別の `AssertionResult`** が返る(1件目で打ち切らず一括報告される)。各結果の `message` には ajv の `instancePath`(ルート違反の場合は `(root)`)と違反内容が含まれる
- body が存在しない SSE / WS ステップでは ok:false になる。body が存在するが JSON としてパースできない HTTP レスポンスは、生の文字列のままスキーマ検証にかけられる(例: `type: object` を要求するスキーマなら失敗し、`type: string` なら通り得る)
- スキーマ自体が不正で ajv がコンパイルできない場合も、例外にはならず ok:false のアサーション失敗として報告される

### snapshot(基準との比較)

`snapshot` は、保存しておいた基準とレスポンスを比較する。項目ごとのアサーションを書かなくても、API が変わればステップが失敗する(「API のビジュアルリグレッション」)。変わったレスポンスは構造的な差分で示され、変更を受け入れるのは明示的な操作になる。

```yaml
assert:
  status: 200
  snapshot:
    ignore: ["$.id", "$.items[*].createdAt"]   # 揮発する値。文法は `klaus diff --ignore-path` と同じ
    include: [status, headers, body]            # 既定は [status, body]
    headers: [content-type, etag]               # include に headers があるときに残すヘッダー(既定は content-type)
    name: v2                                    # キーに足す任意のラベル
```

`snapshot: true` は既定(status と body)を使う。どのキーも省略できる。

- **基準の置き場所**: フローファイルの隣の `__snapshots__/<フローファイル名>.snap.json`(`flows/login.yaml` なら `flows/__snapshots__/login.yaml.snap.json`)。ファイルはキー順にソートして整形した JSON で、スナップショットのキーを `{ status?, headers?, body }` に対応づける。git の差分で読みやすい。JSON のボディは JSON の値として、それ以外のボディは文字列として保存する。キーはステップ名で、`--data` の n 回目の反復なら ` #<n>`、`name` を指定していれば ` :: <name>` が付く(例: `login`、`login #2`、`login #2 :: v2`)。2 つのステップが同じキーにならないよう、`snapshot` を持つステップの名前は ` :: ` を含んだり ` #<数字>` で終わったりできない(定義エラーで exit 2。`klaus validate` でも報告される)。
- **秘密値**: 基準は、履歴と同じマスクを通したレスポンス(<code v-pre>{{env.X}}</code> で解決した値は `***` になる)から書き、比較もマスク済み同士で行う。宣言された秘密値が、コミットする前提のファイルに残ることはない。`--no-mask` は stdout の出力にだけ効き、スナップショットは変えない。秘密値として宣言されていない値(ボディ中の名前・メールアドレス・id など)はそのまま保存されるので、揮発する値や機微な値は `ignore` に書き、コミット前にファイルを確認すること。
- **`ignore`**: 一致した値は保存する基準では固定値 `"[ignored]"` に置き換わり、比較もされない。タイムスタンプや生成された id で基準が揺れない。パターンはボディに適用する(`$.items[*].id`、`$..updatedAt`)。`..` は 1 つのパターンに 2 個まで。
- **`include` / `headers`**: `headers` は名前を挙げたレスポンスヘッダーだけを保存する(大文字小文字を区別せず、ファイル内では小文字)。`include` に `"headers"` が必要。`Date` のような揮発するヘッダーは含めないこと。
- **比較**: 構造的に行う。オブジェクトのキー順は関係なく、配列の順序は関係する。差分があればステップが失敗し(exit 4)、パスと前後の値を示す(1 ステップあたり最大 20 件)。
- **基準が無い場合・`--update-snapshots`・`--ci`・古いエントリ**: [スナップショット](cli.md#スナップショット-update-snapshots-ci)を参照。要点は、基準が無ければローカルの実行では書き込み、CI では失敗する。変わった基準は `klaus run -u` で書き換え、記録済みの run の不一致は `klaus snapshot accept <runId>` で受け入れる。
- **対象**: HTTP ステップのみ。SSE・WebSocket のステップに `snapshot` を書くと、その旨のメッセージで失敗する(黙って無視はしない)。`--dry-run` はスナップショットを読み書きしない。`--replay` では再生したレスポンスを比較するが、基準は書かない。
- **安全**: スナップショットファイルは、カレントディレクトリ内に解決される `__snapshots__` ディレクトリの下でだけ読み書きし、シンボリックリンクは辿らない(`__snapshots__` ディレクトリと基準ファイルは、行き先がディレクトリ内でもリンクであってはならず、基準は通常のファイルでなければならない。`.git/` のような隠しディレクトリの下の `__snapshots__` は拒否する。違反するとステップは `error`、exit 3)。カレントディレクトリの外にあるフローファイルはスナップショットを使えない。`$protected` な環境に対する実行で新しい基準を書くには `--update-snapshots` が必要(本番のデータがコミットされるファイルに残ってしまうため)。
- **`use` とのマージ**: `snapshot` は単一値のフィールドで、参照先ステップと呼び出し側の両方に書くと `status` などと同じく衝突になる。

### `regex` のパターンはテンプレート展開される

他のアサーション値と同様、`regex` マッチャー(`assert.headers[].regex` / `assert.body[].regex` / `assert.bodyText.regex` / `assert.events[].regex` / `assert.messages[].regex`)に渡すパターンもマッチング前にテンプレート展開される。そのためパターン中の <code v-pre>{{...}}</code> はリテラルに限らず、キャプチャや `--var` から解決され得る。キャプチャは検証対象 API のレスポンスボディから埋まるため、キャプチャした値を `regex` に流すフローでは、実質的にそのパターンを API 側が選べることになる。破滅的バックトラッキングを起こすパターン(例: `^(a+)+$`)だと、入力文字数が1つ増えるごとにマッチング時間が指数的に伸び、数十文字程度でも1分を優に超えて固まる。アサーション評価には(HTTP リクエストのみをカバーする `request.timeoutMs` と異なり)タイムアウトが一切ない。`klaus ui` ではこれが実行だけでなく共有サーバープロセス自体をブロックする。

これは可用性のみへの影響であり(実行が固まるだけで、データの露出や改ざんは起きない)、そもそもフローの実行・編集権限(`klaus ui` ではセッショントークン)が前提になる。またキャプチャや `--var` の値をフローが意図的に `regex` に流し込んだ場合にのみ発生し、フローファイルに直書きしたリテラルパターンは影響を受けない。`contains` / `equals` はパターンを評価しないため、値の由来に関わらずこの影響を受けない。関連する regex タイムアウトのスコープ注記は [SECURITY.md](https://github.com/almondoo/klaus/blob/main/SECURITY.md) を参照。

## if

```yaml
steps:
  - name: login
    request: { method: POST, url: "{{env.baseUrl}}/login" }
    assert: { status: 200 }
  - name: cleanup
    request: { method: DELETE, url: "{{env.baseUrl}}/session" }
    if: steps.login.status == "passed"   # login が passed のときだけ実行する
  - name: use-token
    request: { method: GET, url: "{{env.baseUrl}}/me", headers: { Authorization: "Bearer {{token}}" } }
    if: captures.token != ""
```

- `if` はステップを実行するかどうかのゲートになる。汎用の式言語では**なく**、意図的に小さく留めた文法(`src/core/condition.ts` が評価する)を持つ:
  - `ref op literal`(`ref` は `steps.<name>.status` または `captures.<name>`、`op` は `==` / `!=`、`literal` はダブルクォート文字列・シングルクォート文字列・空白を含まないベアトークンのいずれか)
  - `stepName` / `captureName` に `.` や空白は含められない
  - クォート文字列はエスケープシーケンスに対応しない。値に反対側のクォート文字を含めたい場合は逆のクォート種別で囲む(例: `"` を含めたいならシングルクォートで囲む)
  - `'` または `"` で始まるリテラルは、同じクォート文字で終端していなければならない。未終端のクォート(例: `captures.token == "abc`)はベアトークンとして黙って解釈**されず**、不正な式として拒否される(RuntimeError)
  - 比較は常に文字列として行う。`captures.<name>` 側の値は、テンプレート展開(例: <code v-pre>{{token}}</code>)と同じ方法で文字列化する(オブジェクト・配列は JSON 文字列化、それ以外は `String()`)。`steps.<name>.status` は元々文字列
- **`if` の中では <code v-pre>{{...}}</code> テンプレート展開は行われない。**それまでのキャプチャは <code v-pre>{{name}}</code> ではなく `captures.<name>` で直接参照する
- `steps.<name>.status` は同じフロー内で**それより前**にあり、かつ実行が完了しているステップのみ参照できる(`continueOnError` で継続したステップも、その実際の `failed` / `error` ステータスが後続の条件式から見える。これが `if` と `continueOnError` を組み合わせる狙いそのもの — 例: setup が passed のときだけ後始末を実行する)
- 条件式が **false** の場合、ステップは**実行せず** `skipped` になる(リクエストは送られず `retry` も適用されない)。`error` には `"skipped because condition not met: <expression>"` が入る。これはフローの残りステップをスキップしない — 後続ステップは通常どおり実行される(「前のステップの失敗」による skip とは別理由。[ステップ失敗時のフロー挙動](#ステップ失敗時のフロー挙動) を参照)
- 条件式が**例外を投げた**場合(文法エラー、または未知のステップ/capture 名の参照)、そのステップは元のメッセージ(利用可能なステップ/capture 名一覧を含むことがある)とともに `error` になり、後述の通常のエラーセマンティクスに従う(`continueOnError` が無ければ残りステップは skipped になる)
- それより前の未処理の失敗による `skipRest`(後述)が優先する: フローが既に残りステップをスキップ中の場合、このステップの `if` はそもそも評価されない

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

## continueOnError

```yaml
steps:
  - name: optional-check
    request: { method: GET, url: "{{env.baseUrl}}/optional" }
    assert: { status: 200 }
    continueOnError: true   # 任意。既定値は false
  - name: next-step
    request: { method: GET, url: "{{env.baseUrl}}/next" }
```

- ステップに `continueOnError: true` を設定すると、そのステップの最終結果が **`failed`** または **`error`** になっても以降のステップはスキップされず、次のステップから実行が継続される
- 「最終結果」とは、`retry` を併用している場合は **retry を使い切った後**を指す。retry は通常どおり先に実行され、リトライがすべて尽きて初めて `continueOnError` が効果を持つ
- ステップ自体の状態は `failed` / `error` のまま変わらず、フロー(および run)全体の集約ステータスと exit code もこれまでどおり失敗として扱われる(詳細は [CLI リファレンス](cli.md#exit-code))
- `continueOnError` が影響するのは**そのステップ自身の失敗のみ**。`continueOnError` を指定していない**後続の**ステップが失敗した場合は、下記のとおりそれ以降のステップはスキップされる

## ステップ失敗時のフロー挙動

- ステップが **failed**(アサーション失敗)または **error**(runtime エラー)になると、そのフローの**残りステップは実行されず skipped**(`error: "skipped because a previous step failed"`)として記録される。ただし失敗したステップに `continueOnError: true` が設定されている場合は残りステップが実行される([continueOnError](#continueonerror) を参照)
- [`if`](#if) の条件式が false になったステップも `skipped` として記録されるが、理由は別(`error: "skipped because condition not met: <expression>"`)で、上記の「残りステップをスキップする」挙動は**発生しない** — いずれの場合もフローは次のステップから実行を続ける
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
