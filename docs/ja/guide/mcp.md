# AI エージェント向けの MCP サーバー(klaus mcp)

`klaus mcp` は [Model Context Protocol](https://modelcontextprotocol.io) のサーバーを stdin/stdout で動かし、AI エージェントが `curl` の代わりに、klaus 自身の安全柵のもとで API を調べ、検証できるようにする。エージェントは `klaus_request` や `klaus_run_flow` といったツールを呼ぶ。送信はすべて CLI と同じ送信先の許可リスト・環境の保護・シークレットのマスク・履歴を通り、サーバーにはそのどれも緩める手段がない。

## これは何か

- **stdio のみ。** クライアントが `klaus mcp` を子プロセスとして起動し、その stdin/stdout で MCP を話す。ネットワークのリスナーは持たない。stdin が閉じたとき、または SIGINT / SIGTERM で exit code 0 で終了する。
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
| `klaus_list_environments` | 環境と保護モード(`none`・`protected`・`readonly`。読めないものは `unknown`)を一覧する。値は返さない | 読み取り専用 |
| `klaus_dry_run` | 各ステップの展開後リクエスト(マスク済み)と、`errorCode` を含む安全柵の判定を示す | 読み取り専用。何も送らず、履歴も書かない |
| `klaus_run_flow` | フローを実行し、ステップごとの要約(HTTP ステータス・エラー・`errorCode`・失敗したアサーション・snapshot と OpenAPI の結果)を返す。`env` と `variables` は任意 | リクエストを送る。履歴と、無かったスナップショットの基準を書く |
| `klaus_request` | 単発のリクエスト(`method`・`url`・`headers`・`query`・`body`・`env`)を送り、ステータス・ヘッダー・本文(マスク済み)を返す | リクエストを送る。履歴を書く |
| `klaus_history_list` | 最近のステップを要約行で返す(`flow`、100 件までの `limit`、`statuses` で絞り込み)。本文は含まない | 読み取り専用 |
| `klaus_history_show` | 1 つの run の記録を返す。`step` で 1 ステップに絞る | 読み取り専用 |
| `klaus_diff_runs` | 2 つの run を比較する(`a` / `b` は run ID・`latest`・`previous`)。`ignorePaths`・`ignoreHeaders` | 読み取り専用 |
| `klaus_snapshot_list` | run のうち、承認待ちのスナップショットのアサーションを返す | 読み取り専用 |
| `klaus_promote` | 記録済みの run から**新しい**フローファイルを書く(`runIds`・`out`・任意の `name`)。パス、利用者が埋める `TODO_*` のプレースホルダー、検証結果を返す | 新しいファイルを 1 つ書く。上書きしない。`--read-only` では使えない |
| `klaus_snapshot_accept` | 承認待ちのスナップショット 1 件(`runId`・`snapshotFile`・`key`)を新しい基準として受け入れる | 基準を置き換える。`--read-only` では使えない |

`klaus_run_flow` が返すのは要約で、レスポンスの本文ではない。本文を見るには、`runId` と `step` を指定して `klaus_history_show` を呼ぶ。スナップショットの候補(レスポンス全体のコピー)は、`klaus history show` と同じく、`step` を指定したときだけ `klaus_history_show` に含まれる。

ツールには標準の MCP 注釈(`readOnlyHint`・`destructiveHint`・`idempotentHint`・`openWorldHint`)が付く。リクエストを送るツールは、フローやリクエストが対象 API のデータを変え得るため、破壊的かつオープンワールドとして示される。`klaus_promote` は上書きしないので破壊的ではなく、`klaus_snapshot_accept` は破壊的。クライアントはこれを確認ダイアログの判断に使える。

リクエストを送るツールとファイルを書くツールは、呼び出された順に 1 つずつ実行されるので、並行した呼び出しが履歴やスナップショットファイルを同時に書き換えることはない。

## 安全柵

### 安全柵は上書きできない

送信はすべて、`klaus.config.yaml` の guard(`guard.allowedHosts`)と環境の保護(`$protected`)だけを使う。`klaus mcp` には `--allow-protected` も `--no-mask` も、guard の設定を渡せるオプションやツール引数もない。拒否は `errorCode`(`guard.allowed-hosts`・`guard.protected`・`guard.readonly`・`guard.method-override` など)つきで返り、保護環境のメッセージは、`klaus mcp` は上書きできず、利用者が端末から自分で `klaus run --allow-protected` を実行する必要があることを伝える。拒否も他と同じく履歴に記録される。

拒否の返し方はツールによって違う:

- `klaus_run_flow` と `klaus_dry_run` は、そのステップが `status: "error"` と `errorCode`(dry-run では `guard.status: "refused"`)を持つ通常の結果を返す。アサーションに失敗した、または拒否されたステップを含む run はツールのエラーではない(エージェントに詳細が必要なため)。
- `klaus_request` は 1 件のリクエストだけを送るので、拒否や送信の失敗はツールのエラー(`isError: true`)になり、`error`・`errorCode`・`hint` を返す。404 のような HTTP のエラーステータスは通常の結果。

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

どのツールも、整形した JSON を入れたテキストブロックを 1 つ返す。想定される失敗(不正な引数・拒否されたパス・不明な run ID・定義エラー・`klaus_request` の安全柵による拒否)は `isError: true` で返り、本文は `{ "error": "...", "errorCode": "...", "hint": "..." }` の形になる。`errorCode`・`hint`・`runId` は当てはまるときだけ付く。予期しない例外も `isError: true` でメッセージを返し、詳細は stderr に出て、サーバーは動き続ける。

結果は 256 KiB までに制限される。それを超える文字列と `body` の値は `[truncated: 1048576 bytes; the full value is available via klaus_history_show with step, or in .klaus/history]` のような印に置き換えられ、オブジェクトには `"resultTruncated": true` が付くので、JSON は常に有効なまま。要求を絞る(小さな `limit`、1 つの `step`)か、履歴ファイルを読むこと。

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
