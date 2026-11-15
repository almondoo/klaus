# 実行履歴

klaus は全リクエスト / レスポンス / 所要時間をローカルの JSONL に追記する。CLI の text 出力が成功時1行要約に留まるのは、フル詳細をこちらに逃がしているため。localhost UI の履歴ブラウザもこのファイルを読む。

ブラウザ UI を使わずに CLI から直接参照したい場合は `klaus history`(一覧)/ `klaus history show <runId>`(詳細)を使う。オプションの詳細は [CLI リファレンス](cli.md#klaus-history) を参照。

## ファイル規則

- パス: `.klaus/history/<YYYY-MM-DD>.jsonl`(**cwd 基準**、日付は各エントリの `startedAt`(ステップの開始時刻)の UTC 日付)
- ディレクトリは自動作成される
- `klaus run --no-history` で書き込みを無効化できる
- **書き込みに失敗しても実行結果には影響しない**(stderr に警告が出るだけで、ステップの pass/fail はそのまま)

## 1行のスキーマ(v: 1)

1行 = 1ステップ実行。`runId` で同一実行のステップをグルーピングできる。

```jsonc
{
  "v": 1,                       // スキーマバージョン
  "runId": "<uuid>",            // 実行単位の ID(全フロー共通)
  "flow": "認証フロー",          // フロー名
  "step": "login",              // ステップ名
  "startedAt": "2026-08-08T…",  // ISO 8601
  "durationMs": 6,
  "status": "passed",           // "passed" | "failed" | "skipped" | "error"(旧エントリには無い場合がある。運用上の注意を参照)
  "request": {                  // skipped ステップでは省略される
    "method": "POST",
    "url": "http://…",          // テンプレート解決済み(シークレットはマスク後)
    "headers": { … },           // テンプレート解決済み(シークレットはマスク後)
    "body": { … }
  },
  "response": {                 // skipped ステップでは省略される
    "status": 200,
    "headers": { … },
    "body": { … }               // JSON ならパース済みの値、それ以外はテキスト
  },
  "events": [                   // SSE ステップでのみ設定(受信イベント一覧)
    { "event": "message", "id": "1", "data": "…" }
  ],
  "assertions": [
    { "ok": true, "kind": "status", "expected": 200, "actual": 200, "message": "…" }
  ],
  "error": "…",                 // status が "error" のときだけ(安全柵の拒否、またはレスポンスを受け取った後に失敗したステップ): 理由
  "errorCode": "guard.allowed-hosts",  // 省略可、error があるときだけ: エラーコードを参照
  "env": "local",               // 省略可: 監査項目を参照
  "envProtection": "protected", // 省略可: 保護された環境のときだけ。監査項目を参照
  "envSource": "file",          // 省略可: 環境を --env-file から読み込んだときだけ。監査項目を参照
  "file": "api/auth-flow.yaml", // 省略可
  "actor": { "kind": "agent", "name": "claude-code" },  // 省略可
  "git": { "commit": "<sha>", "dirty": false }          // 省略可
}
```

### ステップ種別ごとの内容

| 種別 | request | response | events |
|---|---|---|---|
| HTTP / GraphQL | method / url / headers / body | status / headers / body | — |
| SSE | 通常どおり | status / headers、**body は undefined** | 受信イベント一覧(`{event?, id?, data}`) |
| WebSocket | method は `"WS"`、body は送信メッセージ配列 | status は `101` 固定、body は受信メッセージ(data 文字列)の配列 | — |
| skipped | 省略 | 省略 | — |

**skipped ステップも記録される**(`status: "skipped"`、request/response なし、assertions は空)。`error` で終わったステップが記録されるのは次の 2 つの場合だけ。安全柵(`guard.allowedHosts` または `$protected`)に拒否されたステップは監査のために記録され、`status: "error"`、送信しようとしたリクエスト(マスク済み)、`error` に拒否理由、監査項目を持つ。**レスポンスを受け取った後に**失敗したステップ(`capture` の失敗、テキストのまま保持した本文への JSONPath の capture、レスポンスの検査中のエラー)は、`status: "error"`、リクエスト、レスポンス、`error` のメッセージを持つ形で記録される。レスポンスを受け取る前、または使えるレスポンスが無いままのエラーは記録されない。接続エラー、タイムアウト、本文の途中でのネットワークエラー、`http.maxResponseBytes` を超えるレスポンス、展開できないテンプレートがこれに当たる。

入れ子が 200 段を超える JSON のレスポンスは、パースせずテキストのまま(文字列の `body`。記録された `response` には `bodyTooDeep: true`)保持する。そうしたレスポンスに対する JSONPath の capture・`body` の path アサーション・`bodySchema` は明示的なメッセージで失敗する。`bodyText` のアサーションと `regex` の capture は引き続き使える。

**スナップショットの結果**は、`kind: "snapshot"` のアサーションと `snapshot` オブジェクトとして記録される。`snapshot` には `key`、`file`(スナップショットファイル)、`state`(`matched` / `written` / `updated` / `mismatch` / `missing`)が入り、不一致なら `differences`(最大 20 件)と `differenceCount` も入る。`mismatch` と `missing` の結果は、基準として書き込まれるはずだったマスク済みの `{ status?, headers?, body }` を `candidate` としても保持する。`klaus snapshot accept <runId>` はこの候補をそのまま書き込むので、変更を受け入れても API をもう一度呼ぶことはない([klaus snapshot](cli.md#klaus-snapshot))。候補は、エントリの他の部分と同じ秘密値のマスクを通した後の値から作られる。レスポンス全体のコピーなので、`klaus history`(一覧)は出力せず、`klaus history show <runId>` も `--step` を付けたときだけ含める。

新規に書き込まれるエントリには常に `status` が設定される。`status` フィールドが無い旧エントリは、従来どおり `assertions` の内容から成否を導出して読み込める(後方互換)。

## エラーコード

`error` で終わったステップは、英語の自由文の `error` メッセージを持つ。原因が下記のいずれかなら、メッセージの文字列照合に頼らずに使える安定した `errorCode` も持つ。このフィールドは省略可で追加のみの変更なので `v` は 1 のまま。コードを持たないエラー(接続不能・タイムアウト・テンプレート変数の未解決など)では省略する。

| `errorCode` | 原因 |
|---|---|
| `guard.allowed-hosts` | 送信先ホストが `guard.allowedHosts` に無い(許可リストの設定時に URL を解釈できない場合も含む) |
| `guard.protected` | 環境が `$protected: true` |
| `guard.readonly` | 環境が `$protected: readonly` で、メソッドが `GET` / `HEAD` / `OPTIONS` 以外(WebSocket ステップを含む) |
| `guard.method-override` | 環境が `$protected: readonly` で、リクエストがメソッド上書きヘッダーを持つ |
| `guard.host-header` | `Host` ヘッダーが URL のホストと違う、またはホストとして不正 |
| `guard.proxy-header` | `http.proxy` の使用中に、ホップ間ヘッダーなどの禁止ヘッダーが設定された |
| `guard.path` | カレントディレクトリの外のファイル(`bodyFile`・`multipart` のファイル・スナップショットのファイル)を参照した |
| `guard.redirect` | リダイレクトのホップが、より具体的なコードを持たない安全柵に拒否された(下記) |
| `response-too-large` | 応答(または SSE ストリーム)が `http.maxResponseBytes` を超えた |

- **リダイレクト**: リダイレクトの途中のホップが拒否されたときは、その拒否が持つより具体的なコードを残す(許可リスト外のホストへのホップは `guard.redirect` ではなく `guard.allowed-hosts`)。`guard.redirect` になるのは、拒否そのものがコードを持たない場合だけ
- **現れる場所**: `errorCode` は、エラーメッセージが出る場所にそのメッセージと並んで付く。`klaus run --json` の `error` ステップ、`klaus req --json`、`klaus run --dry-run --json` で拒否されたステップの `guard.errorCode`、履歴エントリ、UI サーバーの応答。サマリーだけの出力には付けない
- **履歴では**: `error` として記録されるのは安全柵の拒否と、レスポンスを受け取った後に失敗したステップ。後者には通常 `errorCode` が付かない(capture の失敗には無い)ので、履歴ファイルに現れるコードは `guard.*` だけ。`response-too-large` は実行の出力と UI にだけ出る

## 監査項目

実行の出どころを記録する、省略可能な6つのフィールド。追加のみの変更なので `v` は 1 のままで、これらが導入される前のエントリには単に存在しない。

| フィールド | 内容 |
|---|---|
| `env` | 環境名。`--env-file` の場合はそのファイルのベース名。環境を使わない実行では省略 |
| `envProtection` | `"protected"`(`$protected: true`)または `"readonly"`(`$protected: readonly`)。保護された環境を読み込んで書いたすべてのエントリに付く。環境を名前で選んだ場合も `--env-file` の場合も、どの入口(CLI・`klaus ui`・`klaus mcp`)からでも、安全柵の拒否のエントリにも付く。保護されていない環境・環境なしの実行・このフィールドが導入される前のエントリには無い。`klaus mcp` が使う: `klaus_promote` はこの run を拒否し、履歴を読むツールは、その環境の値をマスク用に得られないとき、このエントリのリクエストとレスポンスを返さない([MCP サーバー](/ja/guide/mcp)を参照) |
| `envSource` | 環境を `--env-file` のパスから読み込んだときの `"file"`(どの入口でも)。名前で選んだ環境には無い。このとき `env` はファイルのベース名だけになり、拡張子の無いファイル(`secrets/ro`)は名前付き環境 `ro` と見分けがつかないので、この項目で区別する。`--env-file environments/ro.yaml` もファイルとして扱う(`env` は `ro.yaml`)。`klaus mcp` はこのエントリを名前で解決しない |
| `file` | フロー定義ファイルの cwd からの相対パス(POSIX 区切り)。単発リクエストでは省略 |
| `actor` | `{ kind, name? }`。`kind` は `human` / `agent` / `ci` で、環境から検出する: エージェントのマーカー `CLAUDECODE` / `AI_AGENT` を優先し、次に `CI`、どれも無ければ `human`。`klaus run --actor <name>` / `klaus req --actor <name>` で `name` を設定できる(`kind` は引き続き検出)。`klaus ui` からの実行は `human` を記録する |
| `git` | `{ commit, dirty }`: 実行時の `HEAD` と、追跡対象ファイルに未コミットの変更があるか(未追跡ファイルは無視)。git が使えない場合は省略 |

`klaus history --fields env,envProtection,envSource,file,actor,git` または `klaus history show <runId>` で参照できる。

## run の比較

`klaus diff <runA> <runB>` は記録済みの2つの run をステップ単位で比較する。API(またはフロー)を変更した後に、レスポンスの何が動いたかを正確に確認するために使う。

### 比較する run の指定

- run ID を2つ(`klaus history show` と同じ完全一致)。
- `--flow <name>` と組み合わせた `latest` / `previous`: そのフローを含む最新の run と、その1つ前の run。`--flow` なしの `latest` / `previous` は、単発リクエストや他のフローが混ざって基準が曖昧になるためエラー。
- run ID なしの `klaus diff --flow <name>` は `previous`(A)と `latest`(B)を比較する。

`--flow` 指定時は、両方の run をそのフローのステップに絞る。ステップはフロー名・ステップ名・イテレーション(`--data` 実行)で突き合わせ、片方の run にしか無いステップは `added`(B のみ)または `removed`(A のみ)として報告する。

### 比較される内容

| 観点 | 報告される条件 |
|---|---|
| `status` | ステップの status が変わった(`passed` / `failed` / `skipped` / `error`) |
| `httpStatus` | HTTP ステータスコードが変わった |
| `responseHeaders` | ヘッダーが追加・削除・変更された(名前は大文字小文字を区別しない) |
| `body` | レスポンス body が異なる |
| `request` | リクエスト自体が異なる: `method`・`url`・`body`(ヘッダーは比較しない) |
| `events` | SSE イベントが異なる |
| `error` | 記録されたエラーメッセージ(安全柵の拒否、またはレスポンスを受け取った後の失敗)が異なる |
| `durationMs` | `--duration-threshold <ms>` 指定時のみ、所要時間の差がその値を超えた |

リクエストの変更は `body` / `httpStatus` とは別に `request` に出るため、「リクエスト自体が変わった」と「レスポンスが変わった」を区別できる。片側に request / response が無い(skipped ステップや安全柵の拒否)場合、そのステップでは `status` と `httpStatus` だけを報告する。レスポンスを受け取った `error` ステップは、他のステップと同じように比較する。

JSON body は構造 diff になる: `{ path, kind, before, after }` のリストで、`path` は JSONPath 風(`$.items[0].name`)、`kind` は `added` / `removed` / `changed` / `type-changed` / `too-deep`。オブジェクトはキーで突き合わせ(キー順は無関係)、配列はインデックスごとに比較するため順序依存で、長さの違いは `added` / `removed` として現れる。JSON でない body は行単位の要約(追加・削除の行数と変更行)になる。

既定の除外リストにあるレスポンスヘッダーは比較しない: `date`、`age`、`content-length`、`server-timing`、`x-request-id`、`x-correlation-id`、`request-id`、`x-trace-id`、`x-amzn-trace-id`、`x-amz-request-id`、`x-amz-id-2`、`traceparent`、`cf-ray`。`etag` は意図的にリストに入れていない。ノイズになる場合は `--ignore-header etag` を追加する。

### 揮発する値の除外

| オプション | 効果 |
|---|---|
| `--ignore-header <name>` | レスポンスヘッダーをもう1つ除外する(繰り返し可、大文字小文字を区別しない) |
| `--no-default-ignores` | 既定の除外リストにあるヘッダーも比較する |
| `--ignore-path <jsonpath>` | JSON body の比較からパスを除外する(繰り返し可)。レスポンス body・リクエスト body・SSE イベントに適用される |
| `--duration-threshold <ms>` | この値より大きい所要時間の変化を差分に含める |

`--ignore-path` は JSONPath の小さなサブセットを受け付ける: `$.id`、`$.items[0]`、`$.items[*].createdAt`(`$.items.*.createdAt` も可)、`$['odd-key']`、`$..updatedAt`(任意の深さ。1つのパスに含められる `..` は最大2個)。パスに一致したノードは、その配下もまとめて除外される。このサブセット外の式は引数エラー(exit 1)になる。

比較は反復で行うため、深く入れ子になった body でもスタックを溢れさせない。256 階層未満は通常の差分を報告し、それより深いサブツリーは等価かどうかだけを比較して、異なる場合は(値を伴わない)`too-deep` の差分を1件報告する。差分に載る値のうち 100 階層より深いものは、文字列 `[too deep to display]` に置き換えられる。

### 出力と exit code

出力は stdout が TTY でなければ既定で JSON、TTY ならテキスト。`--json` / `--text` で強制できる。各ステップは `change`(`same` / `different` / `added` / `removed`)を持ち、`same` のステップは簡潔に列挙される。テキストでは差分のあるステップだけを出力する。

```jsonc
{
  "version": 1,
  "status": "different",               // "same" | "different"
  "runs": { "a": { "runId": "…", "flows": ["login and fetch"], "startedAt": "…", "steps": 2, "status": "passed", "env": "local", "actor": { "kind": "agent" }, "git": { "commit": "…", "dirty": false } }, "b": { … } },
  "counts": { "same": 1, "different": 1, "added": 0, "removed": 0 },
  "steps": [
    { "flow": "login and fetch", "step": "login", "change": "same" },
    {
      "flow": "login and fetch", "step": "get-me", "change": "different",
      "status": { "a": "passed", "b": "failed" },
      "body": {
        "kind": "json", "total": 2, "omitted": 0,
        "differences": [
          { "path": "$.plan", "kind": "changed", "before": "pro", "after": "free" },
          { "path": "$.extra", "kind": "added", "after": { "beta": true } }
        ]
      }
    }
  ]
}
```

出力を有限に保つため、各ステップはセクションごとに最大 `--max-differences <n>` 件(既定 50)の差分だけを保持し、残りは `omitted` に件数として入り、テキストでは「and N more」と表示される。値は JSON では `--max-value-length <n>` を指定しない限り完全な形で出力され、テキストでは指定しない場合 80 文字に切り詰められる。

| exit code | 意味 |
|---|---|
| 0 | 差分なし |
| 4 | 差分あり(`klaus run` のアサーション失敗に並ぶ扱い) |
| 1 | 引数不正(フラグの併用・不正な `--ignore-path`・`--flow` なしの `latest` / `previous`)、不明な run ID・該当する `latest` / `previous` が無い(`klaus history show` と同じ)、または予期しないエラー |

履歴はシークレットを `***` として保存し、`***` は自分自身と等しいと比較されるため、シークレット値の変更は diff では見えない。

## run のフロー化

`klaus promote <runId...>` は、記録済みの履歴を、観測したレスポンスから推論したアサーション付きの、再実行可能なフロー YAML に変換する。想定する流れは、`klaus req` やアサーションなしのフローで API を探索し、その記録を `klaus promote` で回帰テストにし、API 変更後に `klaus diff` で差分を見る、というもの。

```
klaus promote <runId...> [-o <path> | --stdout] [--force] [--assert status|schema|values|all]
                         [--base-url-var <name>] [--no-chain] [--name <name>] [--flow <name>] [--json|--text]
```

### 出力ファイル

- 既定のパスはリポジトリの規約に従う: 1 ステップなら `api/<name>.yaml`、複数ステップなら `flows/<name>.yaml`。`<name>` はフロー名のスラッグ。`-o, --out <path>` で変更できる。
- パスは cwd 配下に解決されなければならない。シンボリックリンクは要素ごとに検査する: 最終要素がシンボリックリンクなら(行き先が cwd 内でも、`--force` を付けても)常に拒否し、親ディレクトリのシンボリックリンクは実在して cwd 内を指す場合だけ許可する(宙づりは拒否)。ファイルは `O_NOFOLLOW` で開くため、検査後に差し替えられたリンクも辿らない(親ディレクトリについては狭い競合が残る)。これらの拒否は exit 2。
- 既存ファイルは `--force` を付けない限り上書きしない(exit 2)。
- `--stdout` はファイルを書かずに YAML を出力する。この場合サマリーは stderr に出る。
- ファイルの先頭は `klaus init` / `klaus generate` と同じ `$schema` コメントで、続けて、埋めるべきプレースホルダー・環境ファイルに書く値・推論したキャプチャをコメントで列挙する。YAML は書き込む前に検証される(`klaus validate` と同じ規則)。
- 複数の run ID は指定した順に連結される(例: ステップごとに1回の `klaus req`)。複数のフローを含む run は `--flow <name>` が必要。`--data` 実行は最初のイテレーションだけをフロー化する。同じミリ秒に開始したステップは、履歴ファイルに書き込まれた順序を保つ。
- ファイルの先頭には `NOTICE` コメントが付き(コマンドも同じ注意を出力する)、記録した通信から生成したファイルなので、コミット前に機微情報を確認すること。機微らしい記録値はプレースホルダーに置き換えられる(下記参照)。

### リクエストの再構成

- 記録されたステップごとに1ステップを、記録順に生成し、`method`・`url`(クエリ文字列は URL に残る)・`headers`・`body` は記録どおりにする。単発リクエスト(フロー名 `(single)`)のステップ名は `<method>-<パス末尾のセグメント>` で、重複する名前には `-2`、`-3` ... が付く。
- ホップバイホップヘッダーと計算されるヘッダーは落とす: `content-length`、`host`、`connection`、`keep-alive`、`transfer-encoding`、`te`、`trailer`、`upgrade`、`proxy-connection`。
- マスク値(`***`)は再現できない。URL・ヘッダー・body の文字列中の `***` はすべて <code v-pre>{{env.TODO_*}}</code> に置き換えるため、ファイルにリテラルの `***` は残らない。名前は場所から決まる: ヘッダー `Authorization` は `TODO_AUTHORIZATION`、body のパス `$.user.password` は `TODO_BODY_USER_PASSWORD`、クエリパラメータ `api_key` は `TODO_QUERY_API_KEY`、URL パスの3番目のセグメントは `TODO_URL_PATH_3`。同じ値の中の2つ目の `***` には `_2` が付く。同じ場所は全ステップで同じ名前になる。実行前に OS 環境変数として設定する。コマンドの出力に一覧が出る。
- `--base-url-var <name>` はすべての URL の origin を <code v-pre>{{name}}</code> に置き換え(他の origin は `name_2`、`name_3` ...)、環境ファイルに書く値を表示する。既定では URL はリテラルのまま。
- SSE ステップは、リクエストと `sse: {}` だけを持ち、status のみをアサートするステップになる。WebSocket ステップ・skipped ステップ・`error` で終わったステップ(安全柵の拒否にはレスポンスが無く、レスポンスを受け取った後に失敗したステップは基準にしない)はスキップされ、出力に理由が示される。
- リクエストの記録値(URL・クエリ・ヘッダー値・body の文字列)にリテラルの <code v-pre>{{</code> が含まれる場合は生成を拒否する(exit 2、ステップと場所を示す)。klaus には <code v-pre>{{</code> のエスケープ構文が無く、そのままだとフロー実行時にテンプレートとして展開されるため、敵対的なサーバーが返した <code v-pre>{{env.SECRET}}</code> のような値で OS 環境変数が次のリクエストの送信先へ漏れてしまう。`--allow-template-literals` を付けると出力し、各箇所を警告(出力・`notes`・ファイル先頭のコメント)に列挙する。`klaus promote` 自身が生成するプレースホルダーとキャプチャは対象外。
- 再現できないマスクの形: `=` を持たないクエリ要素中の `***`(`?***`)は `TODO_QUERY_PARAM` になる。マスクされた body キー・ヘッダー名・クエリパラメータ名は、場所を示して拒否する(exit 2)。
- 100 階層より深く入れ子になったリクエスト body は拒否する。

#### マスクされずに保存された機微な値

履歴がマスクするのは <code v-pre>{{env.X}}</code> で解決した値だけで、環境ファイル・`--var`・capture 由来の値はそのまま保存される。これらを生成ファイルに残さないため、次のいずれかに当てはまるリクエスト値は <code v-pre>{{env.TODO_*}}</code> のプレースホルダー(命名は上記と同じ。`placeholders` と、理由つきで `redacted` に列挙される)に置き換える:

- 機微なキー(`token`・`secret`・`password` / `passwd` / `pwd`・`credential`・`signature`・`cookie`・`bearer`・`session`・`key`(`apiKey` / `api_key` を含む)・`auth`(`author` は除く)に大文字小文字を区別せず一致する。祖先のキーも含む)、機微なヘッダー名(`authorization`・`cookie`・`x-api-key`・`x-auth-*`・`proxy-authorization`、またはそのパターンに一致するもの)、機微なクエリパラメータ名の下にある。`Authorization` / `Proxy-Authorization` では `Bearer` / `Basic` / `Digest` / `Token` / `ApiKey` のスキーム接頭辞を残す。
- トークンらしい: JWT、既知のキー接頭辞(`sk_`・`pk_`・`rk_`・`ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_`・`github_pat_`・`xox*-`・`AKIA...`・`AIza...`)、または 32 文字以上でエントロピーの高い文字列(UUID はトークンとみなさない)。

推論したキャプチャが供給する値は置き換えない(既に <code v-pre>{{name}}</code> 参照になっているため)。それでも生成ファイルは確認すること: ヒューリスティクスですべての秘密情報を見分けられるわけではない。

### 推論されるアサーション

`--assert` で厳しさを選ぶ。どのモードでも、観測した status と等しい `assert.status` は常に含まれる。

| モード | 追加されるもの |
|---|---|
| `status` | 追加なし |
| `schema`(既定) | 観測したメディアタイプを `contains` する `content-type` ヘッダー、および JSON body の `bodySchema` |
| `values` | `content-type` のマッチャーと、安定したスカラー葉の `body` `equals` マッチャー |
| `all` | 上記の両方 |

規則はすべて決定的:

- `bodySchema` は観測した値から推論する: 型と必須キーのみ。存在したキーはすべて必須で、`additionalProperties` は制限せず、`enum` や `const` も使わない。数値は `number` 型(JSON では `10` と `10.0` を区別できないため)。配列は先頭 100 要素を併合して型付けする: キーは全要素が持つ場合のみ必須で、要素の型が混在すれば `anyOf` になる。
- `body` の equals マッチャーは、機微なキー(上記)の下の値やトークンらしい値には作らない。対象は安定していそうなスカラー葉に限る: 真偽値、絶対値が 1000 以下の整数、短い enum 風の文字列(英数字・`_`・`-`、32 文字以下、数字は3文字以下)。配列はインデックス 4 まで辿り、1ステップあたり最大 20 件。
- 揮発しそうなものは除外する: `***` を含む文字列、UUID、日付(`YYYY-MM-DD`)を含む文字列、8 桁以上の数字列、16 文字以上の 16 進文字列、長いトークン風の文字列、JWT、および `id`・`*_id`・`*Id`・`*_at`・`*At`、または `token`・`secret`・`uuid`・`hash`・`etag`・`timestamp`・`expires`・`created`・`updated`・`password`・`session` を含むキーの値(真偽値はキー名では除外しない)。
- JSON でない body は status と content-type のみをアサートする(出力に注記が出る)。

### 値のチェイン

`--no-chain` を付けない限り、先行ステップの JSON レスポンスのスカラー値が後続のリクエストにそのまま再登場した場合、先行ステップの `capture` と、後続側の <code v-pre>{{name}}</code> 参照に置き換える。意図的に保守的にしてある:

- 値は UUID、または数字を含む 8 文字以上であること(20 文字以上なら数字は不要)。数値は 8 桁以上が対象。
- URL パスセグメント全体、クエリ値全体、ヘッダー値全体(または `Bearer <token>` のような空白区切りの最後のトークン)、body 文字列全体または body 文字列内の空白区切りトークンに一致する場合のみ。JSON body 内の数値は、テンプレートが常に文字列を生成するため置き換えない。origin も置き換えない。
- その値を生んだステップ以前のリクエストに既に現れている値は、利用者が与えた値とみなしてチェインしない。
- 複数の先行ステップに同じ値があれば、最も近いステップを使う。キャプチャ名は JSON キーから付ける(`$.token` は `token`)。衝突した場合や、キーがテンプレート関数・名前空間と同名(`newUuid`・`newDate`・`newTimestamp`・`env`)の場合は、ステップ名を前置して解決する。

推論したリンクはすべて出力とファイル先頭のコメントに列挙されるので、確認できる。

### 出力と exit code

サマリーは stdout が TTY でなければ JSON、TTY ならテキスト(`--json` / `--text` で強制できる)。

```jsonc
{
  "version": 1,
  "status": "ok",
  "written": true,
  "file": "flows/login-and-fetch.yaml",
  "flow": "login and fetch",
  "assert": "all",
  "steps": [ { "name": "login", "method": "POST", "url": "{{baseUrl}}/login", "from": { "runId": "…", "flow": "login and fetch", "step": "login" } }, … ],
  "placeholders": [ { "name": "TODO_X_API_KEY", "locations": ["step \"login\": header x-api-key"] } ],
  "variables": [ { "name": "baseUrl", "value": "http://127.0.0.1:47831" } ],
  "captures": [ { "name": "token", "from": { "step": "login", "path": "$.token" }, "used": [ { "step": "get-me", "location": "header \"authorization\"" } ] } ],
  "skipped": [],
  "redacted": [ { "name": "TODO_AUTHORIZATION", "location": "step \"get-me\": header authorization", "reason": "sensitive key" } ],
  "templateLiterals": [],
  "notes": [],
  "notice": "Generated from recorded traffic: review this file for sensitive data (tokens, passwords, personal data) before committing it."
}
```

| exit code | 意味 |
|---|---|
| 0 | フローを生成した(`--stdout` でなければ書き込んだ) |
| 1 | 引数不正、不明な run ID、複数フローの run で `--flow` が無い(`klaus history show` と同じ)、または予期しないエラー |
| 2 | 出力ファイルが既に存在する、cwd 外または安全でないシンボリックリンク経由の出力パス、フロー化できるステップが無い、記録値にリテラルの <code v-pre>{{</code> が含まれる(`--allow-template-literals` なし)、再現できないマスク値がある、または生成されたフローが不正 |

## バージョニング契約

履歴 JSONL は localhost UI(および将来のツール)が読む**契約**であり、以下のルールで進化する:

- `v` を変えない変更は**フィールド追加のみ**(additive)。既存フィールドの削除・意味変更・型変更はバージョンを上げる
- 読み手は未知のフィールドを無視し、未知の `v` の行はスキップする

## 運用上の注意

- **テンプレート解決済みの値が記録される**。ただし <code v-pre>{{env.X}}</code> で OS 環境変数から解決した値(長さ 4 文字以上)は、書き込み直前に request の url/headers/body・response の headers/body・assertions(expected/actual/message)・events(event/id/data)内で `***` にマスクされる。マスクは生の値だけでなく、その URL エンコード形(パーセントエンコード、`URLSearchParams` が空白を `+` にする form-urlencoded 形、および WHATWG URL 正規化に近い encodeURI 形)にも及ぶため、`request.query` に置いたシークレットや `request.url` テンプレートへ直書きしたシークレットもエンコード後の姿で記録されずに済む。マスクされるのはこの経路で解決した値のみで、`environments/*.yaml` 由来の値、`capture:` で取得した値、ライブ実行結果(実行中 UI・StepResult)はマスク対象外。詳細は [SECURITY.md](https://github.com/almondoo/klaus/blob/main/SECURITY.md) を参照
- マスクされない値(4文字未満のシークレットや environments ファイル由来の値など)を扱うプロジェクトでは、引き続き `.klaus/` を `.gitignore` に入れること(このリポジトリの scaffolding では最初から ignore 済み)
- テキストファイルなので、あえて git 管理して実行記録をチームで共有する運用も可能(マスクされない値が含まれないことを確認したうえで)
