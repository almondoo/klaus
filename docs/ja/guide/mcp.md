# AI エージェント向けの MCP サーバー(klaus mcp)

`klaus mcp` は [Model Context Protocol](https://modelcontextprotocol.io) のサーバーを stdin/stdout で動かし、AI エージェントが `curl` の代わりに、klaus 自身の安全柵のもとで API を調べ、検証できるようにする。エージェントは `klaus_request` や `klaus_run_flow` といったツールを呼ぶ。送信はすべて CLI と同じ送信先の許可リスト・環境の保護・シークレットのマスク・履歴を通り、サーバーにはそのどれも無効にするオプションがない。各安全柵が何を守り、何を守らないかは[安全柵が守る範囲](#安全柵が守る範囲)に書いた。実際の API にエージェントを向ける前に読むこと。

## これは何か

- **stdio のみ。** クライアントが `klaus mcp` を子プロセスとして起動し、その stdin/stdout で MCP を話す。ネットワークのリスナーは持たない。stdin が閉じたとき、または SIGINT / SIGTERM で exit code 0 で終了する。その時点でキューに待機している呼び出しは開始されない。すでに送信中のリクエストは中断せず、プロセスは最長 3 秒で終了する。そのため、クライアントが切断した時点で送信中だったリクエストは、履歴のエントリを残さないまま相手のサーバーに届いている可能性がある。
- **作業ディレクトリがプロジェクト。** フロー・環境・履歴・`klaus.config.yaml` は、サーバーを起動したディレクトリから解決する。プロジェクトのディレクトリで起動すること。
- **設定は呼び出しごとに読み直す。** `klaus.config.yaml` の `guard`・`http`・`run.openapi` は、再起動なしで次のツール呼び出しから効く。ファイルが不正なときは、guard なしで送ってしまわないよう、送信するツールがエラーになる。それ以外の `run` の既定値(`env`・`history`・`mask` など)は適用しない。履歴とマスクは常にオンで、`env` は呼び出しごとに渡す。
- **診断は stderr へ。** stdout にはプロトコルのメッセージだけを出す。

## MCP クライアントへの登録

### 汎用の設定

多くの MCP クライアントは、コマンドとその引数を受け取る。klaus をインストール済み(`klaus` が `PATH` にある)なら次のとおり:

```json
{
  "mcpServers": {
    "klaus": {
      "command": "klaus",
      "args": ["mcp"]
    }
  }
}
```

グローバルにインストールしない場合は `npx` に取得させる。`-y` は確認プロンプトを省く(省かないとクライアントが止まる):

```json
{
  "mcpServers": {
    "klaus": {
      "command": "npx",
      "args": ["-y", "@almondoo/klaus", "mcp"]
    }
  }
}
```

ファイルを書き込むツールを外すには、`args` に `"--read-only"` を足す([読み取り専用モード](#読み取り専用モード)を参照)。設定ファイルの名前や最上位のキーはクライアントごとに違うので、クライアントのドキュメントを確認すること。

### Claude Code

プロジェクトのディレクトリで実行する:

```bash
claude mcp add klaus -- klaus mcp
# グローバルにインストールしていない場合
claude mcp add klaus -- npx -y @almondoo/klaus mcp
```

`--` より後ろがサーバーのコマンド。`-s user` か `-s project` で設定の保存先を選べる(既定のスコープは `local`)。サーバーがプロジェクトのディレクトリで動くことを確認すること([トラブルシューティング](#トラブルシューティング)を参照)。

## ツール

ツール名はすべて `klaus_` で始まる。入力は各ツールの入力スキーマで記述された JSON オブジェクトで、パスはプロジェクトのディレクトリからの相対パス。

| ツール | 内容 | 影響 |
|---|---|---|
| `klaus_list_flows` | フローファイルを名前とステップ数つきで一覧する(不正なものはエラーつき) | 読み取り専用 |
| `klaus_validate_flow` | フローファイル 1 つをスキーマ検証し、`valid` とエラーを返す | 読み取り専用 |
| `klaus_list_environments` | 環境と保護モード(`none`・`protected`・`readonly`。読めないものは `unknown`)を一覧する。返すのは名前と保護モードだけ | 読み取り専用 |
| `klaus_dry_run` | 各ステップの展開後リクエストと、`errorCode` を含む安全柵の判定を示す。`env` と `variables` は任意。保護された環境の値は `***`、保護されていない環境の値は展開されて表示される([安全柵が守る範囲](#安全柵が守る範囲)を参照) | 読み取り専用。何も送らず、履歴も書かない |
| `klaus_run_flow` | フローを実行し、ステップごとの要約(HTTP ステータス・エラー・`errorCode`・失敗したアサーション・snapshot と OpenAPI の結果)を返す。`env` と `variables` は任意 | リクエストを送る。履歴と、無かったスナップショットの基準を書く |
| `klaus_request` | 単発のリクエスト(`method`・`url`・`headers`・`query`・`body`・`env`)を送り、ステータス・ヘッダー・本文(マスク済み)を返す | リクエストを送る。履歴を書く |
| `klaus_history_list` | 最近のステップを要約行で返す(`flow`、100 件までの `limit`、`statuses` で絞り込み)。本文は含まない | 読み取り専用 |
| `klaus_history_show` | 1 つの run の記録を返す。`step` で 1 ステップに絞る。`step` と併せて、`path` は一致した値だけを返し、`offset` / `length` は長い文字列を窓に区切って読む([大きな値を読む](#大きな値を読む)を参照) | 読み取り専用 |
| `klaus_diff_runs` | 2 つの run を比較する(`a` / `b` は run ID・`latest`・`previous`)。`ignorePaths`・`ignoreHeaders` | 読み取り専用 |
| `klaus_snapshot_list` | run のうち、承認待ちのスナップショットのアサーションを返す | 読み取り専用 |
| `klaus_promote` | 記録済みの run から**新しい**フローファイルを書く(`runIds`・`out`・任意の `name`)。パス、利用者が埋める `TODO_*` のプレースホルダー、検証結果を返す | 新しいファイルを 1 つ書く。上書きしない。`--read-only` では使えない |
| `klaus_snapshot_accept` | 承認待ちのスナップショット 1 件(`runId`・`snapshotFile`・`key`)を新しい基準として受け入れる | 基準を置き換える。`--read-only` では使えない |

`klaus_run_flow` が返すのは要約で、レスポンスの本文ではない。本文を見るには、`runId` と `step` を指定して `klaus_history_show` を呼ぶ(記録されたステップには、そのための `{ runId, step }` を持つ `historyRef` が付く)。スナップショットの候補(レスポンス全体のコピー)は、`klaus history show` と同じく、`step` を指定したときだけ `klaus_history_show` に含まれる。

run が履歴に記録するもの: `passed`・`failed`(アサーション・snapshot・OpenAPI 検証)・`skipped` で終わったステップ、安全柵に拒否されたステップ、レスポンスを受け取った後に `error` で終わったステップ(例: キャプチャの失敗。エントリは `status: "error"` で、リクエスト・レスポンス・エラーメッセージを持つ)は記録される。レスポンスを受け取る前、または使えるレスポンスが無いままエラーで終わったステップは記録されない。タイムアウト、接続エラーや本文の途中でのネットワークエラー、大きすぎるレスポンス、展開できないテンプレートがこれに当たる。`historyRef` が付くのは記録されたステップだけで、付いていないステップを履歴から引いても見つからない。`klaus run --json` も同じで、実際に記録されたステップにだけ `historyRef` を出す。

入れ子が 200 段を超える JSON のレスポンス本文は、パースせずテキストのまま保持する(`klaus req --body` とカセットの再生も同じ規則で、SSE イベントや WebSocket メッセージの JSON がそれほど深い場合は `path` のアサーションに一致しない)。文字列に JSONPath を当てると文字に一致してしまう(`$[0]` が先頭の文字になる)ため、そうしたレスポンスに対する JSONPath のキャプチャ・`body` の path アサーション・`bodySchema` は、代わりに明示的なメッセージ(`response body is nested deeper than 200 levels and is kept as text; JSONPath and schema checks cannot be applied`)で失敗する。キャプチャの失敗はステップを `error` にする。本文全体のテキストに対する検査(`bodyText`、`regex` のキャプチャ)は引き続き使える。記録されたレスポンスには `bodyTooDeep: true` が付き、読み手は深い JSON のテキストだと分かる。`klaus_request` は、200 段を超える object / array の `body` を拒否する。文字列として渡し、`headers` で `Content-Type` を指定すること。

ツールには標準の MCP 注釈(`readOnlyHint`・`destructiveHint`・`idempotentHint`・`openWorldHint`)が付く。リクエストを送るツールは、フローやリクエストが対象 API のデータを変え得るため、破壊的かつオープンワールドとして示される。`klaus_promote` は上書きしないので破壊的ではなく、`klaus_snapshot_accept` は破壊的。クライアントはこれを確認ダイアログの判断に使える。

リクエストを送るツールとファイルを書くツールは、呼び出された順に 1 つずつ実行されるので、並行した呼び出しが履歴やスナップショットファイルを同時に書き換えることはない。

## 安全柵

### 安全柵が守る範囲

送信はすべて、`klaus.config.yaml` の guard(`guard.allowedHosts`)と環境の保護(`$protected`)だけを使う。`klaus mcp` には `--allow-protected` も `--no-mask` も、guard の設定を渡せるオプションやツール引数もないので、MCP 経由で拒否を上書きすることはできない。拒否は `errorCode`(`guard.allowed-hosts`・`guard.protected`・`guard.readonly`・`guard.method-override` など)つきで返り、保護環境のメッセージは、`klaus mcp` は上書きできず、利用者が端末から自分で `klaus run --allow-protected` を実行する必要があることを伝える。拒否も他と同じく履歴に記録される。

安全柵が守らないものも、守るものと同じくらい重要になる:

- **`$protected` が止めるのは、その環境を選ぶ run。** 保護は環境の名前に結び付いていて、ホストには結び付いていない。`klaus_run_flow`・`klaus_dry_run`・`klaus_request` が保護を適用するのは、run(または `env` 引数)が保護された環境を選んだときだけ。`env` なしの `klaus_request` は環境を読み込まず、どの保護の対象にもならない。
- **エージェントの送信先を限るのは `guard.allowedHosts`。** `env` なしの `klaus_request` は、`guard.allowedHosts` が許すすべてのホストへ届き、未設定ならすべてのホストへ届く。
- **保護された環境の値は見せず、保護されていない環境の値は見せる。** ツールの呼び出しが、保護が `true` または `readonly` の環境を読み込むと、そのファイルのすべての変数の値が、その呼び出しの間シークレットとして登録される。`klaus_dry_run` の出力(展開後の URL とホスト・ヘッダー・クエリ・ボディ。ステップが拒否された場合も同じで、安全柵の判定と `errorCode` は残る)、`klaus_run_flow` と `klaus_request` の結果、エラーや拒否のメッセージとヒント、それらの呼び出しが書く履歴のエントリで `***` になる。`klaus_history_show`・`klaus_history_list`・`klaus_diff_runs`・`klaus_snapshot_list` は、以前に(CLI や UI などが)記録したエントリに含まれる、現在保護されているすべての環境の値を隠し、`klaus_promote` は保護された環境に対して記録された run を拒否する(それ以外の run でも、昇格の前にその値を隠す)。CLI と UI は変わらず、これは `klaus mcp` だけの挙動。保護されていない環境の値は隠れず、`klaus_dry_run` は展開して示す。
- **保護された環境についてエージェントがなお知り得るもの:** 環境の名前と保護モード(`klaus_list_environments`)、変数の名前(`available: env: ...` のようなテンプレートのエラーや、`klaus_validate_flow` に環境ファイルを渡したときのスキーマのパス。値はエコーされない)、リクエストが拒否されたことと理由(`errorCode`)、そして 4 文字未満の値。短い値は、隠すとテキストが壊れるためマスクされない。許可されたリクエスト(`readonly` の環境の GET)のレスポンスの本文は返り、隠れるのはその環境自身の値だけ。
- **`klaus mcp` プロセスのどの OS 環境変数も参照できる。** リクエストやフローから <code v-pre>{{env.NAME}}</code> で参照し、許可されたホストへ送れる。値は結果と履歴ではマスクされるが、送信先には渡る。

拒否の返し方はツールによって違う:

- `klaus_run_flow` と `klaus_dry_run` は、そのステップが `status: "error"` と `errorCode`(dry-run では `guard.status: "refused"`)を持つ通常の結果を返す。アサーションに失敗した、または拒否されたステップを含む run はツールのエラーではない(エージェントに詳細が必要なため)。
- `klaus_request` は 1 件のリクエストだけを送るので、拒否や送信の失敗はツールのエラー(`isError: true`)になり、`error`・`errorCode`・`hint` を返す。404 のような HTTP のエラーステータスは通常の結果。

### 推奨する設定

- `klaus mcp` を使うときは、`klaus.config.yaml` に `guard.allowedHosts` を必ず設定する。エージェントの送信先を限る手段はこれだけ。
- 本番の値を持つ環境には `$protected` を付ける。その値はエージェントから隠れる。`klaus_request` で届く API からエージェントを遠ざけるために `$protected` を当てにせず、本番の認証情報は、エージェントのプロジェクトのディレクトリにある保護されていない環境ファイルに置かないこと。
- エージェントにファイルを書かせたくないときは `--read-only` を使う。

### 出力は常にマスクされる

OS 環境変数から解決した値(<code v-pre>{{env.NAME}}</code>)と `Cookie` / `Set-Cookie` ヘッダーの値は、`klaus run` の既定の出力と同じく、すべてのツールの結果と履歴で `***` に置き換えられる。`variables` として渡した値と、環境ファイルやキャプチャ由来の値はシークレットとして登録されない。本物のシークレットは OS 環境変数に置き、<code v-pre>{{env.NAME}}</code> で参照すること。

### 書き込みツール

`klaus_promote` と `klaus_snapshot_accept` は、CLI ではなく [localhost UI](./ui.md) の厳しい規則に従う。

- `klaus_promote` が書くのは新しいファイルだけで、場所は `api/`・`flows/`・既にフローファイルがあるディレクトリのいずれかで、`.yaml` か `.yml` で終わるもの。バックスラッシュ・隠しディレクトリ・`klaus.config.yaml`・プロジェクトの外のパスは拒否し、既存のファイルは上書きせず、記録された値にリテラルの <code v-pre>{{</code> が含まれる場合も拒否する。シークレットやトークンらしい値は、利用者が埋める <code v-pre>{{env.TODO_*}}</code> のプレースホルダーになる。
- `klaus_snapshot_accept` が受け入れるのは、その run の承認待ちになっている (`snapshotFile`, `key`) の組だけ。保護環境に対する run は拒否し(端末で `klaus snapshot accept` を使う)、他のアサーションが失敗したステップも拒否する。人が頼りにしている基準を変える操作なので、エージェントは先に利用者へ確認すること。
- 他のツールに渡すフローのパスは、プロジェクトのディレクトリの中(シンボリックリンクを辿った先も)に解決でき、`.yaml` か `.yml` で終わる必要がある。それ以外は `errorCode: "guard.path"` で拒否される。

run の間、スナップショットは対話的な `klaus run` と同じ振る舞いをする。基準が無ければ書き込み、不一致は報告するだけで更新しない。

### 読み取り専用モード

`klaus mcp --read-only` は `klaus_promote` と `klaus_snapshot_accept` を登録すらしない。ツールの一覧に現れず、呼び出しても不明なツールとして失敗する。他のツールは上記のとおりに動く。特に `klaus_run_flow` と `klaus_request` は引き続きリクエストを送って履歴を書き、run は無かったスナップショットの基準も書く。

### actor として記録される名前

`klaus mcp` 経由で書かれた履歴のエントリは、すべて `actor.kind: "agent"` になる。名前は、MCP の `initialize` リクエストでクライアントが名乗ったクライアント名。名乗らなければ環境変数(`CLAUDECODE`・`AI_AGENT`)から検出したエージェント名、それも無ければ `mcp`。クライアント名は自己申告なので、身元の証明ではなくラベルとして扱うこと。

## 結果の形式とサイズの上限

どのツールも、整形した JSON を入れたテキストブロックを 1 つ返す。想定される失敗(拒否されたパス・不明な run ID・定義エラー・`klaus_request` の安全柵による拒否)は `isError: true` で返り、本文は `{ "error": "...", "errorCode": "...", "hint": "..." }` の形になる。`errorCode`・`hint`・`runId` は当てはまるときだけ付く。予期しない例外も `isError: true` でメッセージを返し、詳細は stderr に出て、サーバーは動き続ける。入力スキーマに合わない引数(足りない・型が違う引数)は、ツールが動く前に MCP の SDK が拒否する。この場合も `isError: true` で返るが、本文はこの JSON ではなく、`Input validation error: Invalid arguments for tool ...` という平文のメッセージになる。

結果は 256 KiB までに制限される。それを超える文字列と `body` の値は `[truncated: 1048576 bytes; read it with klaus_history_show: pass step and path (a path into the history entry, for example $.response.body) and, for a string value, offset and length to read it in windows; the stored record is also in .klaus/history]` のような印に置き換えられ、オブジェクトには `"resultTruncated": true` が付くので、JSON は常に有効なまま。

### 大きな値を読む

`klaus_history_show` は run 全体より少ない範囲を返せるので、切り詰められた値も完全に読める。マスクは保存されたとおり(履歴はすでにマスク済み)で、保護された環境の値は `path` を当てる前に隠すので、窓が値を分断することはない。

- `path`(`step` が必要)は、選んだ各履歴エントリの中の値を 1 つ選ぶ。例: `$.response.body`・`$.response.body.items[0]`・`$.response.headers['content-type']`・`$.request.url`。受け付ける形は 4 つだけ: `$`、`.name`(英数字・`_`・`-`。先頭は英字か `_`)、`['name']` または `["name"]`(引用符つき。`\\`・`\'`・`\"`・`\n`・`\t` のエスケープ)、`[n]`(0 以上の整数)。再帰下降(`..`)・ワイルドカード・スライス・和集合・フィルター・スクリプト式は、エントリの価値を大きく超えるコストを掛けられてしまうため、`invalid path` のエラーで拒否する。結果にはエントリごとに `matchCount`(0 か 1)と `matches` が並ぶ。何にも一致しない path は空のリストになる。
- `offset` と `length`(`path` が必要)は、`path` が選んだ単一の文字列の値(例: `$.response.body` のテキスト本文)の窓を読む。単位は文字(UTF-16 コード単位)で、`length` の既定は 32768、最大は 40000。そのため窓は常に 256 KiB の上限に収まる。窓の結果には `text`・`offset`・`length`・`totalLength`・`nextOffset`(末尾では無い)が入る。`nextOffset` が無くなるまで、それを次の `offset` として渡す。`path` がちょうど 1 つの文字列を選ばないときは、呼び出しが失敗し、その旨を伝える。

## トラブルシューティング

**サーバーを起動した直後に、クライアントがプロトコルエラーやパースエラーを報告する**

stdout にはプロトコルのメッセージだけを出す必要がある。`klaus mcp` はそれ以外を書かないが、ラッパースクリプト、起動時に何かを表示するシェルのプロファイル、同じ名前で登録された別のコマンドは書き得る。`klaus`(または `npx`)を直接登録し、登録したコマンドが本当に `klaus mcp` であることを確認すること。

**`klaus_list_flows` が空の一覧を返す、またはフローが見つからない**

サーバーは、起動したディレクトリを基準にすべてを解決する。クライアントを(クライアントにサーバーの作業ディレクトリの設定があればそれを使って)プロジェクトのディレクトリで起動すること。

**リクエストが拒否される**

```
host "127.0.0.1" is not in guard.allowedHosts (klaus.config.yaml); refusing to send the request.
```

そのホストは `guard.allowedHosts` に無い。MCP 経由では変更できない。利用者に伝えること。利用者は `klaus.config.yaml` を編集でき、次の呼び出しから反映される。

**環境が拒否される**

```
environment "prod" is protected ($protected: true) and refuses execution by default. klaus mcp cannot override environment protection; the user must run this themselves from a terminal with `klaus run --allow-protected`.
```

その環境は `$protected` に指定されている。別の環境を使うか、利用者に端末でフローを実行してもらうこと。

**ファイルが既にあって `klaus_promote` が失敗する**

```
"flows/x.yaml" cannot be written: it already exists or a parent path is not a usable directory; klaus_promote never overwrites files
```

別の `out` パスを選ぶこと。

**ツールが見つからないと報告される**

```
Tool klaus_promote not found
```

サーバーが `--read-only` で起動されている。書き込みが意図したものなら、オプションなしで再起動すること。
