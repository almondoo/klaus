# CLI リファレンス

klaus のコマンドは `run`(フロー実行)・`req`(単発リクエストの送信)・`ui`(localhost Web UI 起動)・`validate`(スキーマ検証)・`schema`(JSON Schema 出力)・`generate`(OpenAPI 仕様からのフロー生成。[OpenAPI からのフロー生成](./generate.md)を参照)・`init`(雛形生成)・`history`(実行履歴の参照)・`diff`(2つの run の比較)・`promote`(履歴からのフロー生成)・`mock`(記録済みカセットのモックサーバー化)の11個。

## --help

`klaus --help` および `klaus run --help` の末尾には、docs サイト(このサイト。英語版はサイトのルート、`/en/` 配下ではない)へのリンク・`klaus init` で雛形生成できる旨・exit code の一行要約が付与される。

## klaus run

```
klaus run <files...> [options]
```

複数ファイルを渡すと順次実行する(glob 展開はシェルに任せる)。

| オプション | 説明 | デフォルト |
|---|---|---|
| `--env <name>` | フロー定義の `env:` 指定を上書き(`--env-file` とは併用不可) | フローの `env:` |
| `--env-file <path>` | `environments/` 配下の名前付き環境の代わりに、任意パス(cwd 相対または絶対)の YAML ファイルから環境変数を読み込む。フロー定義の `env:` を上書きする。`-e`/`--env` とは併用不可 | — |
| `--var <key=value>` | その場限りのテンプレート変数を設定する(繰り返し指定可。値自体に `=` を含められる。最初の `=` のみを区切りとして扱う)。環境ファイルの値と同じ名前空間(裸の <code v-pre>{{name}}</code>)に入り、環境から読み込んだ同名キーを上書きする | — |
| `--json` | TTY でも JSON 出力を強制 | — |
| `--text` | 非 TTY でも text 出力を強制(`--json` とは併用不可) | — |
| `--report <list>` | 生成するレポート形式のカンマ区切りリスト: `junit`、`tap`、`html`、`github`(例: `junit,html`) | — |
| `--report-file <path>` | `--report` で指定したレポート形式の出力先(繰り返し指定可。詳細は後述) | フォーマットごとの既定値(後述) |
| `--no-history` | 履歴 JSONL への書き込みを無効化 | 履歴有効 |
| `--no-mask` | stdout(JSON/text 出力とも)へのシークレットマスキングを無効化 | マスク有効 |
| `--record <dir>` | record モード: 実際に HTTP リクエストを送信し、マスク済みの request/response ペアを `<dir>` のカセットに保存する | — |
| `--replay <dir>` | replay モード: 実ネットワークではなく `<dir>` のカセットから HTTP レスポンスを再生する(記録外リクエストは exit code 3 で失敗する)。`--record` とは併用不可 | — |
| `--allow-protected` | `$protected: true` / `$protected: readonly` の環境ファイルへの実行を許可する(未指定時は exit code 3 で拒否。後述の「保護環境」を参照) | — |
| `--actor <name>` | この実行の履歴エントリの `actor.name` に記録する名前(1〜100 文字)。`actor.kind` は従来どおり環境から推定される([実行履歴](history.md#監査項目)を参照) | — |
| `--data <path>` | データ駆動実行: この JSON/YAML データファイルの各行につき、指定した全フローファイルを1回ずつ実行する(詳細は後述の「データ駆動実行(--data)」を参照) | — |
| `--tags <list>` | カンマ区切りのタグ一覧。フローの `tags:` にいずれか1つでも含まれるものだけを実行する(OR 条件。詳細は後述の「タグによるフロー選択」を参照) | — |
| `--exclude-tags <list>` | カンマ区切りのタグ一覧。フローの `tags:` にいずれか1つでも含まれるものを除外する。`--tags` より優先される | — |
| `--jobs <n>` | 実行ユニットをこの数だけ並列実行する(1-32 の整数。詳細は後述の「並列実行(--jobs)」を参照)。`--record` とは併用不可 | 1(逐次実行) |
| `--dry-run` | 何も送信せず、各ステップの展開後リクエストと、安全柵が拒否するかどうかを出力する(後述の「ドライラン(--dry-run)」を参照)。`--record`・`--replay`・`--report` とは併用不可 | — |
| `-u`, `--update-snapshots` | `assert.snapshot` の、異なる・未記録の基準を書き換え、古いエントリを取り除く(後述の「スナップショット」を参照)。`--dry-run`・`--replay`・`--ci` とは併用不可。`klaus.config.yaml` では設定できない | — |
| `--ci` | `assert.snapshot` の基準が無いとき、書き込まずに失敗にする | 環境変数 `CI` が空・`0`・`false` 以外なら有効 |
| `--openapi <path>` | すべての HTTP レスポンスを OpenAPI 3.0/3.1 の文書に照らして検証し、オペレーションのカバレッジを報告する(繰り返し指定可。後述の「OpenAPI の検証」を参照)。既定値は `klaus.config.yaml` の `run.openapi` | — |
| `--openapi-base-url <url>` | リクエストの照合で、この URL も OpenAPI 文書のサーバーとして扱う。`--openapi` が必要 | — |
| `--openapi-strict` | 照合できないリクエスト、文書に書かれていないステータスコード、検証できないレスポンスを失敗にする。`--openapi` が必要。`--dry-run` とは併用不可 | — |
| `--openapi-coverage-min <percent>` | オペレーションのカバレッジがこの割合(0-100)未満なら実行を失敗(exit 4)にする。`--openapi` が必要。`--dry-run` とは併用不可 | — |

`--report` はカンマ区切りのフォーマット一覧を受け取る(各要素は trim され、`junit`・`tap`・`html`・`github` のいずれかでなければならない)。未知のフォーマットや空要素を1つでも渡すと stderr にエラーを出して exit 1。`--report` はフォーマットの重複(例: `--report junit,junit`)や、`--report-file` の解決先パスがフォーマット間で同一になる場合も同様に stderr にエラーを出して exit 1 で拒否する(どちらも同一ファイルへの書き込みが競合するため)。`--report` に N 個のフォーマットを渡した場合、`--report-file` は**同じ順序でちょうど N 回**指定する(1個目の `--report-file` が1個目のフォーマットとペアになる)か、**一度も指定しない**(この場合フォーマットごとの既定ファイル名 — `junit` は `klaus-report.xml`、`tap` は `klaus-report.tap`、`html` は `klaus-report.html`、`github` は `klaus-report.md`(例外は [GitHub レポート](#github-レポート) を参照) — に書き出される)かのいずれかにする。それ以外の回数(例: 2フォーマットに対して `--report-file` を1回だけ)はエラーとして拒否され、exit 1 でどのファイルも書き出さない。これは単一フォーマットの従来挙動をそのまま一般化したものであり、`--report junit` 単体は変わらず `klaus-report.xml` が既定値になる。`--json` と `--text`、または `-e`/`--env` と `--env-file` を同時に指定した場合も同様に stderr にエラーを出して exit 1(何も実行しない)。この `-e`/`--env` と `--env-file` の併用エラーは、**コマンドラインで明示的に指定した** `-e`/`--env` に対してのみ発生する。`klaus.config.yaml` の `run.env` による既定値は、明示指定された `--env-file` と衝突せずそちらに道を譲る([CLI オプションの既定値](config.md)参照)。

`--env-file` は、読み込んだファイルの `$protected` を名前付き環境と全く同じように尊重する(後述)。

### 保護環境(`$protected`)

| `$protected` | `--allow-protected` なしの挙動 |
|---|---|
| `true` | 全ステップを拒否する(exit code 3) |
| `readonly` | `GET` / `HEAD` / `OPTIONS` は通常どおり実行し、それ以外のメソッドと WebSocket ステップはすべて拒否する(exit code 3)。GraphQL ステップは既定で `POST` のため拒否される |

`readonly` では、メソッド上書きヘッダー(`X-HTTP-Method-Override`・`X-HTTP-Method`・`X-Method-Override`)を付けた `GET` / `HEAD` / `OPTIONS` も拒否される(サーバーが書き込みとして扱い得るため)。判定の対象は HTTP メソッドとこれらのヘッダーのみで、`GET` で送られた GraphQL のミューテーションは検出できず、拒否されない。

`--allow-protected` を渡すとどちらも解除される。拒否は送信の直前に行われるため、拒否されたステップは `error`(exit code 3)になる。`--replay` は何も送信しないが、メソッドの判定は適用される。別機構の `klaus.config.yaml` の [`guard.allowedHosts`](config.md#送信先ホストの許可リスト-guard-allowedhosts)(送信先ホストの許可リスト)には、上書きする CLI フラグがない。どちらの拒否も exit code 3 で、[トラブルシューティング](troubleshooting.md)を参照。

`--var` の値は <code v-pre>{{env.X}}</code>(OS 環境変数参照)と異なり、シークレットとして登録されず、出力でもマスクされない。真のシークレットを渡したい場合は OS 環境変数経由で <code v-pre>{{env.X}}</code> として参照し、[実行履歴](history.md)に記載のマスキングの恩恵を受けること。

`--env` / `--report` / `--report-file` / `--no-history` / `--no-mask` / `--jobs` / `--openapi` は `klaus.config.yaml` で既定値を設定できる。`--var`・`--env-file`・`--data`・`--tags`・`--exclude-tags`・`--dry-run`・`--openapi-base-url`・`--openapi-strict`・`--openapi-coverage-min` は設定できない。詳細は [CLI オプションの既定値](config.md) を参照。

### タグによるフロー選択(--tags / --exclude-tags)

フロー定義には最上位で `tags: [smoke, auth]` を宣言できる([フロー定義リファレンス](flow-definition.md#tags)参照)。`--tags` と `--exclude-tags` はそれぞれカンマ区切りのリストを受け取る(各要素は trim される。trim 後に空文字列になる要素 — 先頭・末尾・連続するカンマなど — があるとエラーになり exit 0 以外・スタックトレース無しで終了する)。

- **`--tags`**: 指定したタグのうち**1つでも**持つフローだけを残す(OR 条件)。未指定なら選抜段階での絞り込みは行わない(全フローが通過する)
- **`--exclude-tags`**: 指定したタグの**いずれか**を持つフローを除外する。`--tags` の選抜段階の後に適用される。未指定なら除外を行わない。フローが `--tags` と `--exclude-tags` の両方に一致する場合は**除外が優先**される
- **タグ無しフロー**(`tags:` フィールドが無い): `--tags` のどれとも一致しないため、`--tags` 指定時は除外される。`--exclude-tags` のどれとも一致しないため、`--exclude-tags` のみ指定時は保持される
- **絞り込みで落ちたフローは一切実行されない**: タグによる絞り込みで除外されたフローはランナーに到達すらしないため、JSON/JUnit 出力にも実行履歴にも一切現れない。これは記録される `skipped` ステップとは異なる([ステップ失敗時のフロー挙動](flow-definition.md#flow-behavior-on-step-failure)参照)
- **絞り込み結果が0件だとエラー**: 絞り込みの結果、実行対象のフローが1件も残らない場合、`klaus run` は stderr に `no flows match the specified tags` を出力し、何も実行せず **exit 1** で終了する。これは意図的な仕様で、CI でタグ名の typo により意図せず全緑の空実行になる事故を防ぐため
- **`--data` との組み合わせ**: 絞り込みはデータ駆動実行の行展開より先に行われる — 行 × フローのイテレーションは、絞り込みを通過したフローのみを対象にする
- `klaus.config.yaml` では設定不可(上述のとおり)

### データ駆動実行(--data)

`--data <path>` を指定すると、指定した JSON/YAML データファイルの**行ごとに**、指定した全フローファイルを1回ずつ実行する(Newman 方式のデータ駆動実行)。データファイルはオブジェクトの配列でなければならず、各値はスカラー(string / number / boolean / null)のみ許容する(ネストしたオブジェクト・配列は拒否される)。CSV には非対応(JSON/YAML のみ。新規依存を追加しないための判断。詳細は `src/core/data.ts` のスキーマ定義コメントを参照)。空配列も拒否される。

- **反復順序**: 行(外側)× フロー(内側)の順で反復する — `flowA(行1)`, `flowB(行1)`, `flowA(行2)`, `flowB(行2)`, ...(Newman のコレクションランナーと同じイテレーション優先順)
- **変数注入**: 各行の値は `--var` や環境ファイルと同じテンプレートの env 名前空間(裸の <code v-pre>{{name}}</code>)に入り、`--var` の同名キーを上書きし、`--var` は環境ファイルの同名キーを上書きする(この優先順位を維持)。capture 変数の解決順序には影響しない(従来どおり capture が env 名前空間より先に解決される)
- **値の変換**: 行の値が number/boolean の場合は capture 変数と同様 `String(value)` で文字列化してから注入する。値が `null` のキーは**そもそも注入されない** — テンプレートで参照すると通常の未解決変数エラーになる(意図的な仕様)
- **マスク対象外**: `--var` と同様、行の値はシークレットとして登録されず、出力でもマスクされない。真のシークレットには <code v-pre>{{env.X}}</code>(OS 環境変数参照)を使うこと
- **集約**: 全イテレーションのフロー結果は同じ実行結果にフラットに並ぶ — いずれかのイテレーションが失敗すれば実行全体も失敗として扱われる(通常の複数フロー実行と同じ `aggregateStatus`・exit code のルール)
- **レポートへの反映**: `--data` 使用時、各フロー結果には 1 始まりの `iteration` が付く。反映先は次のとおり: `--json` 出力の各フローエントリの `iteration` フィールド(追加のみの変更のため `version` は `2` のまま)、JUnit の `<testsuite name="...">` に付く `(iteration N)` サフィックス(各 `<testcase>` の `classname` はフロー名のまま)、text 出力のフローヘッダーに付く `(iteration N)` サフィックス、実行履歴 JSONL の各エントリの `iteration` フィールド(追加のみの変更のため `v` は `1` のまま)

### 並列実行(--jobs)

`--jobs <n>` を指定すると、複数の**実行ユニット**を順番にではなく同時に実行する。実行ユニットとは1つのフローファイル(`--data` 指定時は、`--data` のイテレーション優先順が生成するのと同じ単位である「フローファイル × データ行」の組)を指す。`<n>` は 1〜32 の整数でなければならず、範囲外・非整数の値は `--port`/`--last` と同じ流儀で exit 0 以外・スタックトレース無しで拒否される。

- **デフォルトは 1(逐次実行)、Hurl のような既定並列ではない**: klaus はここで意図的に Hurl 等のツールと異なる選択をしている。`--jobs` を指定しない場合、このオプションが存在する前のバージョンと出力がバイト単位で完全に一致する(ワーカープールも並び替えレイヤーも一切介さない、既定経路は無変更)。
- **フロー内のステップは `--jobs` の値に関わらず常に逐次実行のまま**: 並列化されるのは*ユニット*(フローファイル単位の実行)のみで、1つのフロー内のステップが並列化されることはない。ステップ N で capture した値をステップ N+1 で使うようなフローの挙動は従来と変わらない。
- **結果の順序は常に完了順ではなく入力順**: `RunResult.flows`(したがって `--json` 出力・JUnit/TAP レポートの並び順・exit code の集約)は、どのユニットが実際に先に完了したかに関わらず、`--data` が既に使っているイテレーション優先順(行が外側・フローが内側)のまま並ぶ。`runId`・`aggregateStatus`・exit code は `--jobs` の影響を受けない。
- **text 出力の順序**: `--jobs` を 2 以上にすると、klaus は各ユニットのステップ進捗行をバッファし、入力順で手前にある全ユニットが既に出力し終わってから、そのユニットの全ブロックをまとめて出力する — そのため実際のリクエストは並行して走っていても、text 出力を読む人間から見ると `--jobs 1` のときと同じ順序のまま、入れ替わりも混在も起きない(実装上の補足: 現在最も進んでいるユニットをライブストリーミングする方式ではなく、各ユニットの出力を完全にバッファし、入力順で次に出力可能になったユニットからまとめて解放する方式を採用している)。
- **実行履歴の順序は保証されない**: 各ステップは従来どおり `.klaus/history/*.jsonl`([実行履歴](history.md)参照)に1行ずつ追記されるが、`--jobs` が 2 以上のとき、並行実行中の複数ユニットからの追記が書き込まれたタイミングの順にファイル中で混ざり得る — メモリ上の `RunResult` とは異なり、この JSONL ファイルの**行の順序**は入力順を反映しない。各エントリには `runId`/`flow`/`step`/`startedAt` が引き続き付くため、必要であれば読み出し側でグルーピング・順序の再構成ができる。書き込み自体が壊れたり途中で途切れたりすることはない(各行は1回の `O_APPEND` によるアトミックな書き込み)。相対的な順序のみが不定になる。
- **`--record` とは併用不可**: record モードは同じカセットファイル(`--record <dir>`)へ、method+URL をキーとして全レスポンスを追記する。`--jobs` を 2 以上にすると、同一の method+URL への並行リクエストが実行のたびに異なる相対順序で追記され得るため、同じ method+URL への繰り返しリクエストを**再生**した際にどのレスポンスが返るか(`findCassetteEntry` は最初に記録された一致を採用する)が記録のたびに非決定的になってしまう。そのため `--record` と `--jobs` の 2 以上の組み合わせは、何も実行せずエラー・exit code 1 で拒否される。`--replay` にはこの制約は無い: 各ユニットはリクエスト送信を始める前に、それぞれ独立して自分用の読み取り専用カセット索引を読み込む(全ユニットで1つの索引を共有・事前に一括読み込みするわけではない) — replay 中はカセットファイルへの書き込みが一切発生しないため、この並行した独立読み込みは `--jobs` を 2 以上にしても安全である。

### ドライラン(--dry-run)

`--dry-run` は、`klaus run` が送信するはずの内容を、送信せずに表示する。各ステップについて、テンプレート展開後のリクエスト(メソッド、クエリをマージした URL、ヘッダー、ボディ。SSE ステップも同様で、WebSocket ステップは URL・ヘッダー・送信するメッセージ)と、送信直前に行われるのと同じ安全柵の判定結果を出力する。実際に実行する前に、フローが `guard.allowedHosts` や `$protected` の環境に引っかかるかを確認するために使う。

何も送信せず、何も書き込まない: 履歴エントリ、カセットの読み書き、リトライ、アサーション、`capture` はいずれも行わない。フローファイル、`--data`、`--tags`、`--exclude-tags`、`--env`、`--env-file`、`--var`、`--allow-protected` は通常の実行とまったく同じように解釈され、パースエラーは引き続き exit 2 になる。`--jobs` は受け付けるが、並行して実行するものはなく、出力順は変わらない(`--data` と同じく行が外側、フローが内側)。`--dry-run` は `--record`・`--replay`・`--report` と併用できない。これは引数エラーで、`klaus run` の他の引数の組み合わせエラーと同じく、何も実行せず exit 1 になる。`klaus.config.yaml` の `run.report` の既定値は `--dry-run` では無視される。`klaus.config.yaml` からは設定できない。

- **capture に依存する変数**: 同じフローの前段のステップが `capture` で定義する変数はまだ値がないため、出力では <code v-pre>{{name}}</code> のまま残り、ステップの `unresolved` フィールドに列挙される。これはエラーではない。環境に同名の値があっても、その名前は未解決として扱う。実行時には capture した値が環境より優先されるため。
- **実行時にも解決できない変数**: 前段の `capture` が定義するものでも、環境・`--var`・データ行にあるものでもない変数や、OS 環境変数が未定義の <code v-pre>{{env.X}}</code> は、実行時と同じメッセージでステップの `error` に報告され、そのステップに `request` は付かない。
- **生成される値**: <code v-pre>{{newUuid}}</code>・<code v-pre>{{newDate}}</code>・<code v-pre>{{newTimestamp}}</code> は実行時と同じように展開されるため、実際の実行で生成される値とは異なる。
- **`if` 条件**は実行時のステータスや capture に依存するため評価しない: ステップに `conditional: true` を付け、`if` のテキストを表示し、リクエストは引き続き展開する。
- **安全柵**: `guard.status` は `allowed`、`refused`(実行時の拒否と同じ理由つき)、または `guard.allowedHosts` が設定されていて送信先ホストそのものに未解決の変数が含まれる場合(例: `base` が前段で capture される `url: "{{base}}/x"`)の `undetermined` のいずれか。`$protected: readonly` の環境での `POST` のように、ホストに依存しない拒否は引き続き `refused` と報告する。パスやクエリだけが未解決ならホストは確定しているので、許可リストを判定する。各ステップは個別に判定する: 拒否されたステップがあっても、その後のステップは隠れない(実際の実行では後続はスキップされる)。

JSON 出力(非 TTY、または `--json`)は、最上位に `"dryRun": true` の印を持つ compact な1つのオブジェクト。`flows[].steps[]` の構造とフィールド名は [`run` の JSON 出力](#json-出力-機械向け)に揃えてあるが、ステップごとの `status`、`assertions`、`historyRef` は無く、リクエストボディは切り詰めない(ドライランには全文を引き直せる履歴が無いため)。<code v-pre>{{env.X}}</code> 由来のシークレットは通常どおりマスクされる(`--no-mask` で無効化)。

```jsonc
{
  "version": 1,
  "dryRun": true,
  "status": "ok",            // 拒否されるステップや展開に失敗するステップがあれば "error"(exit code 3)
  "summary": { "flows": 1, "steps": 2, "refused": 0, "undetermined": 0, "unresolved": 1, "errors": 0 },
  "flows": [
    {
      "name": "chain",
      "file": "flows/chain.yaml",
      "steps": [
        {
          "name": "login",
          "kind": "http",               // "http" | "sse" | "ws"
          "request": { "method": "POST", "url": "http://127.0.0.1:18766/login", "headers": { "X-Key": "***" }, "body": "{\"user\":\"alice\"}" },
          "unresolved": [],
          "conditional": false,
          "guard": { "status": "allowed" }
        },
        {
          "name": "me",
          "kind": "http",
          "request": { "method": "GET", "url": "http://127.0.0.1:18766/me?who=alice", "headers": { "Authorization": "Bearer {{token}}" } },
          "unresolved": ["token"],
          "conditional": true,
          "if": "steps.login.status == \"passed\"",
          "guard": { "status": "allowed" }
        }
      ]
    }
  ]
}
```

text 出力(TTY、または `--text`)は同じ情報をステップごとに出力し、最後に1行のサマリーを付ける。JSON Schema は `klaus schema --target dry-run-report` で取得できる([klaus schema](#klaus-schema)を参照)。

exit code は、安全柵に拒否されるステップ、または実行時にも展開に失敗するステップ(上の `error` のケース。実際の実行でも実行時エラーになる)があれば **3**、なければ **0**。検証エラーは引き続き 2。アサーションは評価しないため exit code 4 は無い。

### スナップショット(--update-snapshots / --ci)

`assert.snapshot`([詳細](flow-definition.md#snapshot-基準との比較))を持つステップは、マスク済みのレスポンスを、フローファイルの隣の基準ファイルと比較する。比較する基準が無いとき、またはレスポンスが変わったときの動作は、この 2 つのフラグで決まる。

| 状況 | 既定(ローカルの実行) | `--ci`、または `CI` が設定済み | `--update-snapshots` |
|---|---|---|---|
| 基準と一致 | 成功(`matched`) | 同じ | 同じ |
| 基準と異なる | 構造的な差分つきで失敗、exit 4(`mismatch`) | 同じ | 基準を書き換えて成功(`updated`) |
| 基準が無い | 基準を書き込んで成功(`written`) | 失敗、exit 4(`missing`) | 基準を書き込んで成功(`written`) |
| どのステップも生成しなくなったエントリ | 警告(`obsolete`) | 同じ | エントリを削除 |

- 基準の書き込みは実行の終了時に一度だけ行う。実行が途中で止められても、ファイルは元のまま残る。書き込んだファイルは出力に列挙される(text では `snapshot file written: ...`、JSON では `snapshots.files`)ので、確認してコミットすること。
- `--update-snapshots` は、変わったレスポンスを受け入れる明示的な操作である。`klaus.config.yaml` からは決して読まず、`--ci` との併用は exit 1。環境変数 `CI=true` の下でも使える。受け入れる方法はもう 1 つあり、`klaus snapshot accept <runId>` で行う([klaus snapshot](#klaus-snapshot))。
- 基準が無くても暗黙には記録しない場合が 3 つある。そのステップの他のアサーションが失敗した(失敗したレスポンスが基準になってしまうため)、`$protected` な環境に対する実行(本番のデータがコミットされるファイルに残るため。意図して記録するなら `--update-snapshots`)、`--replay`(再生したレスポンスは比較するが書き込まず、`--update-snapshots` とも併用できない)。結果は `missing` で、最初の場合を除きステップは失敗する(最初の場合はステップがすでに失敗している)。
- 壊れたスナップショットファイル(JSON でない、形が違う)は、何も実行する前に exit 2 で終わる。内容は出力しない。直すか削除するか、`--update-snapshots` で作り直す。
- 古いエントリ(どのステップも生成しなかったキー)は、フローの全ステップが実行された(スキップがなく、すべての snapshot ステップが比較まで到達した)後にだけ判定する。部分的な実行で基準が消えることはない。`--data` なしで、データ駆動の実行で作られた `#<n>` のキーを含むファイルに対して実行すると、それらは古いエントリとして報告されるので、その状態で `-u` を併用しないこと。
- `--dry-run` はスナップショットファイルに一切触れない。
- 同じステップの他のアサーションが失敗した応答は、基準として記録しない。`--openapi` の OpenAPI の検証もこれに含む。基準が無ければ結果は `missing`、基準と異なれば `mismatch` のまま(メッセージに、基準を更新しなかったと出る)で、`--update-snapshots` でも同じ。`klaus snapshot accept` もそのような候補は拒否する(`failed-step`。[klaus snapshot](#klaus-snapshot)を参照)。
- スナップショットファイルは、通常のファイルとしてだけ読み書きする。`__snapshots__` ディレクトリと基準ファイルは、行き先がカレントディレクトリ内でもシンボリックリンクであってはならない。基準のパスにある名前付きパイプやデバイスは、実行を止めずに壊れたファイルとして報告する。`.git/` のような隠しディレクトリの下の `__snapshots__` は拒否する(違反するとステップは `error`、exit 3)。200 階層より深く入れ子になった基準は壊れたファイル(exit 2、内容は出さない)で、それほど深いレスポンスは記録しない(snapshot アサーションが、その旨のメッセージで失敗する)。
- スナップショットのキーは、ステップ名に `--data` の反復番号と `name` を足したもの。そのため `assert.snapshot` を持つステップの名前は、` :: ` を含んだり ` #<数字>` で終わったりできない(他のステップのキーと衝突し得るため)。定義エラーで、exit 2(`klaus validate` でも報告される)。
- 基準はロックファイル(`<基準>.lock`。書き終えると消える)の下で、書く直前にファイルを読み直して書く。そのため、同じファイルの別のキーを同時に書く 2 つの実行(たとえば UI から起動した 2 つの実行)が、互いのキーを失うことはない。30 秒より古いロックは無視する。
- UI サーバーから起動した実行には `CI` の設定を渡さない。サーバープロセスの環境変数 `CI` に関わらず、基準が無ければローカルの実行と同じく記録する。`CI` と `--ci` を読むのは `klaus run` だけ。

### OpenAPI の検証(--openapi)

`--openapi <path>` は、実行中のすべての HTTP レスポンスを OpenAPI 文書に照らして検証し、実行がどのオペレーションを呼んだかを報告する。複数の文書は繰り返し指定する。[`klaus.config.yaml`](config.md) の `run.openapi` に書けば既定値にできる(明示した `--openapi` は設定ファイルの一覧を置き換える)。フロー自体の変更は不要。

| オプション | 説明 |
|---|---|
| `--openapi <path>` | OpenAPI 3.0 または 3.1 の文書(YAML または JSON。繰り返し指定可) |
| `--openapi-base-url <url>` | リクエストの照合で、この URL も文書のサーバーとして扱う(文書が本番 URL を持つときにステージングの URL を指すなど)。絶対 `http(s)` URL |
| `--openapi-strict` | どのオペレーションにも照合できないリクエスト、文書に書かれていないステータスコード、検証できないレスポンスを失敗にする |
| `--openapi-coverage-min <percent>` | リクエストに照合されたオペレーションの割合がこの値(0-100。10 進数の数字のみで、`0x10` や `1e1` は拒否)未満なら、実行を失敗(exit 4)にする |

`--openapi-base-url`・`--openapi-strict`・`--openapi-coverage-min` は `--openapi` が必要(無ければ exit 1)。`--dry-run` とは `--openapi-strict` と `--openapi-coverage-min` を併用できない(exit 1)。

**文書。** 読むのはローカルファイルだけ。別のローカルの `.yaml` / `.yml` / `.json` への `$ref` は解決する(含んでいるファイルからの相対パス。フラグメントは JSON Pointer のみ)。リモートの `$ref`(`https://...`)は拒否する。`$ref` の行き先は、`--openapi` に渡した OpenAPI 文書のあるディレクトリの中でなければならない(シンボリックリンクは先に解決する)。存在しない、そのディレクトリの外にある、外へのリンク経由、のどれでも同じメッセージで拒否するので、文書を使ってどのファイルがあるかを探ることはできず、そのようなファイルの内容がエラーや違反に載ることもない。すべての `$ref` は実行前に確認し、循環するスキーマにも対応する。YAML はパーサーの警告を出さずに読み(警告の文面に、参照先ファイルの行が入り得るため)、マージキー(`<<:`)は適用する。読めない・パースできない文書、Swagger 2.0 の文書、解決できない `$ref`、上限(1 ファイル 8 MiB、合計 32 MiB・100 ファイル)を超えるファイルは exit 2 で、何も実行しない。メッセージにはファイル名と、構文エラーなら行・列を載せ、参照先ファイルの内容は載せない。文書の中身は一切実行しない。

**リクエストとオペレーションの照合。** リクエスト URL(クエリ・フラグメントを除く)を、各オペレーションのサーバー、パステンプレート、メソッドの順に照合する。

- サーバーは `servers`(文書・パス項目・オペレーションのいずれかのレベル。無ければ `/`)と `--openapi-base-url`。サーバー変数に対応し、`enum` を持つ変数はその値に、それ以外は 1 つのパスセグメント(既定値が `/` を含むなら、`api/v1` のように複数セグメント)に一致する。`/v1` のような相対のサーバー URL は任意のオリジンに一致する。スキームとホストは大文字小文字を区別せず、既定のポートは無視する。
- パステンプレートはセグメントごとに照合し、具体的なパスがテンプレートのパスより優先される(`/users/me` が `/users/{id}` より先)。候補になるのは、リクエストのメソッドを持つオペレーションだけ。末尾のスラッシュは無視し、`.` / `..` のセグメントは、実際に送られる URL と同じく先に解消する(`/users/x/../me` は `/users/me` として照合する)。
- 複数の文書は、コマンドラインの順で最初に一致したものを使う。
- どこにも一致しないリクエストはカバレッジの `unmatched` に載る。`--openapi-strict` を付けない限り、何も失敗にしない。

**検証する内容**(照合できたレスポンスについて):

1. **ステータス**: 完全一致のコード、次に `2XX`(該当する範囲)、次に `default`。文書に書かれていないステータスは報告され(`undocumented`)、`--openapi-strict` のときだけ失敗になる。そのステータスについて、他の検証はしない。
2. **必須ヘッダー**: `required: true` のレスポンスヘッダーはすべて存在すること(大文字小文字を区別しない。`Content-Type` は対象外)。ヘッダーの値は検証しない。
3. **content-type**: レスポンスが `content` を定義していて本文がある場合、`Content-Type`(パラメーターは無視)が宣言されたメディアタイプ(`application/json`、`text/*`、`*/*` など)のいずれかに一致すること。本文が空の場合と `HEAD` では、content-type とスキーマの検証を省く。ただし、スキーマつきの本文を宣言した応答(`204`・`205`・`304` を除く)が空の本文で返ったら、違反になる。
4. **本文**: JSON のメディアタイプ(`application/json` と `+json` 全般)では、同梱の Ajv(JSON Schema 2020-12)でスキーマに照らして検証する。JSON として不正な本文は違反になり、400 階層より深い本文は検証しない(`skipped`)。それ以外のメディアタイプは、content-type 以上の検証はしない。検証はワーカースレッドで、レスポンス 1 件あたり 3 秒の時間の上限をつけて行う。レスポンスに対して `pattern` が破滅的に長くかかるスキーマ(たとえば `^(a+)+$`)は途中で諦め、そのレスポンスは警告つきの `skipped` になり(`--openapi-strict` では失敗)、同じスキーマはその実行の中で二度と評価しない。

違反があるとステップは失敗になる(`kind: "openapi"` のアサーション、exit 4)。違反ごとに場所(`status`・`content-type`・`header`・`body`)と、本文なら `/items/0/id` のような JSON Pointer を持つ。保持するのは最大 20 件で、総数は `violationCount` に入る。レスポンスの値は違反に載せない。

**スキーマのキーワード。** OpenAPI 3.1 のスキーマは JSON Schema 2020-12 なので、書かれたとおりに使う(`$ref` の兄弟キーワードも有効)。`$id`・`$schema`・`$anchor`・`$dynamicAnchor` は取り除き、`$dynamicRef` と `$recursiveRef` は警告を出して無視し、`nullable`(OpenAPI 3.0 のキーワード)も警告を出して無視する(`type: [..., "null"]` を使う)。OpenAPI 3.0 では、`type` と並ぶ `nullable: true`(`enum` にも null を加える)と、真偽値の `exclusiveMinimum` / `exclusiveMaximum` を変換する。`$ref` の兄弟は、3.0 の仕様どおり無視する。どちらのバージョンでも次のとおり。

- `format` は、既知のものも未知のものも検証しない(`date-time`・`uuid`・未知の format でレスポンスを失敗にしない)。
- `readOnly` はレスポンスに影響しない。`writeOnly` のプロパティは、レスポンスに含まれないため `required` から外す(ある `allOf` の分岐の `required` が、別の分岐で `writeOnly` と宣言されたプロパティを挙げている場合も含む)。
- `discriminator`・`xml`・`externalDocs`・`example` は注釈なので無視する。それ以外のキーワード(`pattern`・`enum`・`allOf` / `oneOf` / `anyOf`・`additionalProperties` など)は、書かれたとおりに検証する。
- Ajv がコンパイルできないスキーマは警告にして、そのレスポンスは検証しない(`skipped`。`--openapi-strict` では失敗)。一部を使えず「任意の値を受け付ける」として扱ったスキーマ(解決できない `$ref`、スキーマの実体がない `$ref` の循環、`$dynamicRef`)も同じで、違反の無いレスポンスは `valid` ではなく `skipped` になる。

リクエストの検証(パラメーター・リクエストボディ)は行わない。

**カバレッジ。** 実行結果に `openapi` の集計が付く。文書、オペレーションの数と照合できた数(`operations.total` / `covered` / `percent`)、カバーしたオペレーションごとに観測したステータスコードと文書に書かれたレスポンスのキー、未カバーのオペレーション、照合できなかったリクエスト(メソッドと、クエリを除いた URL)、検証の対象外にしたステップ、仕様に違反したレスポンスの数。JSON 出力、text のサマリー前の `openapi:` 行、HTML レポート、GitHub のサマリーに出る。

- オペレーションは、レスポンスが 1 件でも照合できればカバー済み(ステータスは問わない)。
- `--tags` / `--exclude-tags` で一部のフローだけを実行すると、カバレッジに `partial: true` が付く(text では `partial run`)。その一部だけのカバレッジという意味。
- SSE ステップ、WebSocket ステップ、リダイレクトを追ったステップ(レスポンスが最初のリクエストのものではない)は検証せず、`excluded` に載せる。
- `--openapi-coverage-min` を下回ると、stderr にエラーを出し、`coverageMin.met` を `false` にして、全ステップが成功していても実行を失敗(exit 4)で終える。
- `--jobs`・`--data`(カバレッジはすべてのユニットの和集合)、`--replay`(再生したレスポンスも実際のものと同じく検証する)と併用できる。リトライしたステップは、すべての試行を数える。
- `--dry-run` では何も送らず、何も検証しない。展開後のリクエスト URL を照合し、`planned: true` でカバレッジを報告する。ベースが未解決の変数のままの URL は、パスで照合する。
- スキーマのコンパイルは実行ごとに 1 回、オペレーション単位で遅延して行う。

## 出力モード

- **自動判定**: stdout が TTY なら text、非 TTY(パイプ / エージェント実行 / CI)なら JSON。`--json` で非 TTY でも JSON を強制、`--text` で TTY でなくても text を強制できる(両者は同時指定不可)
- **結果データは stdout、診断メッセージ(パースエラー・警告)は stderr** に分離される

### text 出力(人間向け)

ステップ完了ごとにインクリメンタルに出力される。成功は1行要約のみ、失敗時だけ詳細を出す(フル詳細は履歴 JSONL 側に残る)。

```
認証フロー (/path/to/auth-flow.yaml)
  PASS login (200, 6ms)
  FAIL get-me (200, 3ms)
    body $.email: expected "a@example.com" but got "b@example.com"
  SKIP logout: skipped because a previous step failed

1 flow, 3 steps: 1 passed, 1 failed, 1 skipped (12ms)
```

- 行種別: `PASS` / `FAIL`(失敗アサーションの expected/actual、レスポンスボディは約500文字で切り詰め)/ `SKIP`(理由付き)/ `ERROR`(runtime エラーのメッセージ)
- TTY では ANSI 色付き(pass=緑 / fail=赤 / skip=黄)。`--json` 時は常に色なし。環境変数 `NO_COLOR`(色を無効化)/ `FORCE_COLOR`(非 TTY でも色付け。`FORCE_COLOR=0` は無効化)にも対応。ただし非 TTY で `FORCE_COLOR` を効かせるには text 出力自体を強制する `--text` の併用が必要(非 TTY のままでは既定で JSON 出力になり、色付き text 経路に到達しない)
- `FAIL` の詳細行・`ERROR` のメッセージ(レスポンス本文由来)に含まれる制御文字は、可視エスケープ(`\n` / `\r` / `\t` / `\xNN`)に変換されたうえで出力される。改行も対象にしているのは、レスポンス本文に改行を仕込んで偽の `PASS` 行を捏造したり出力を隠したりする端末出力の偽装を防ぐため

### JSON 出力(機械向け)

実行完了後に1個の JSON(pretty print なし、1行の compact JSON)を stdout に出力する。逐次出力はしない。
エージェント向けにトークン数を抑えるため **failure-focused** な構造にしてある: 成功(passed)したステップは
`name` / `status` / `durationMs` のみの1行要約に落とし、`failed` / `error` / `skipped` のステップだけ
request/response スナップショットや assertions などの詳細を持つ。

```jsonc
{
  "version": 2,           // 出力スキーマのバージョン
  "runId": "<uuid>",
  "startedAt": "2026-08-08T…",
  "durationMs": 123,
  "status": "passed",     // "passed" | "failed" | "error"
  "summary": { "flows": 1, "steps": 2, "passed": 1, "failed": 1, "error": 0, "skipped": 0 },
  "flows": [
    {
      "name": "認証フロー",
      "file": "…",
      "status": "failed",
      "durationMs": 120,
      "steps": [
        {
          // passed ステップは1行要約のみ(historyRef は履歴記録が有効なときだけ付与)
          "name": "login",
          "status": "passed",
          "durationMs": 6,
          "historyRef": { "date": "2026-08-08", "runId": "<uuid>", "step": "login" }
        },
        {
          // failed/error/skipped ステップは詳細を持つ
          "name": "get-me",
          "status": "failed",
          "durationMs": 4,
          "historyRef": { "date": "2026-08-08", "runId": "<uuid>", "step": "get-me" },
          "startedAt": "2026-08-08T…",
          "request": { "method": "GET", "url": "…", "headers": {}, "body": "…" },
          "response": { "status": 200, "headers": {}, "body": "…" },
          "assertions": [ { "ok": false, "kind": "status", "expected": 200, "actual": 401, "message": "…" } ]
        }
      ]
    }
  ]
}
```

- **truncate**: 詳細に含まれる request/response の `body`(JSON ボディは文字列化してから)、SSE `events` の `data`、WS `wsMessages` の `data` はいずれも約500文字で切り詰める(text 出力の切り詰めと同じ規則)。JSON ボディの構造そのままの全文は履歴側にしか無い
- <code v-pre>{{env.X}}</code> 由来のシークレットは既定でマスクされる(履歴 JSONL・`--report junit` と同じ規則。URL エンコード形(encodeURIComponent 形・form-urlencoded 形・WHATWG URL 正規化に近い encodeURI 形)・JSON エスケープ形も対象。詳細は [実行履歴](history.md) を参照)。`--no-mask` を付けるとこの JSON 出力のマスクだけを無効化できる(履歴 JSONL・JUnit ファイル出力は常にマスクされる)
- 制御文字の可視エスケープ(text 出力や JUnit レポートで行われるもの)はここには適用されず、生の値のまま出力される
- **historyRef**: 履歴記録が有効な実行(`--no-history` を付けていない)では、各ステップ(passed 含む)に `historyRef: { date, runId, step }` が付く。全文が必要な場合は `klaus history show <runId> --step <step>` で取得する(詳細は [klaus history](#klaus-history) / [実行履歴](history.md) を参照)。`historyRef.date` はそのステップが書き込まれた履歴ファイルの UTC 日付(ステップの `startedAt` から導出)。`--no-history` 実行時は `historyRef` を省略する
- SSE / WebSocket ステップでは `response.body` は無く、受信データは `events`(SSE)/ `wsMessages`(WS)フィールドに入る
- **snapshots**: トップレベルの集計 `snapshots: { matched, written, updated, mismatched, missing, obsolete, files, obsoleteEntries }`。snapshot アサーションを持つステップがある、スナップショットファイルに古いエントリがある、またはスナップショットファイルを書き込んだ場合にだけ付く(`files` は書き込んだファイルで、カレントディレクトリからの相対パス)。`assertions` の snapshot アサーションは `kind: "snapshot"`、`state`(`matched` / `written` / `updated` / `mismatch` / `missing`)、`snapshotKey`、`snapshotFile` を持ち、不一致なら `differences`(`[{ "path": "$.body.name", "kind": "changed", "before": "a", "after": "b" }]`、最大 20 件)と、総数の `differenceCount` も持つ。成功したステップは 1 行の要約なので、書き込んだ基準は `snapshots.written` / `snapshots.files` と、text 出力ではその `PASS` 行の `[snapshot written]` で分かる。`klaus snapshot accept` が書き込む候補は履歴に残り、この出力には含まれない
- **openapi**: `--openapi` のときだけ付くトップレベルの `openapi` オブジェクト(`--dry-run --json` にも付き、`planned: true`): `documents`(`file`・`title`・`version`・`operations`)、`operations`(`total`・`covered`・`percent`)、`covered`(`operation`・`document`・`statuses`・`documented`)、`uncovered`、`unmatched`(`method`・`url`・`count`)、`excluded`(`flow`・`step`・`reason`: `sse` / `websocket` / `redirected`)、`violations`、`partial`、`planned`、任意で `coverageMin`(`percent`・`met`)と `truncated`(一覧を 1000 件で切り詰めた)。`assertions` の OpenAPI アサーションは `kind: "openapi"` と `openapi` オブジェクトを持つ。`state`(`valid` / `invalid` / `undocumented` / `unmatched` / `skipped`)、`operation`(`GET /users/{id}`)、`document`、`status`、`invalid` なら `violations`(`[{ "location": "body", "path": "/id", "message": "must be integer" }]`、最大 20 件)と、総数の `violationCount`。成功したステップは 1 行の要約なので、成功した実行が何をカバーしたかは `openapi` の集計でだけ分かる
- **redirects / droppedHeaders**: リダイレクトを追った(`http.followRedirects`)ステップには、ステータスに関わらず `redirects`(最初のリクエストの後に辿った URL。最後が最終応答)が付き、別オリジンへの遷移で資格情報を落とした場合は `droppedHeaders`(`[{ "hop": 1, "headers": ["authorization"] }]`。ヘッダー名のみ)も付く。URL は他の URL と同じくマスクされる。text 出力の `FAIL` / `ERROR` では同じ情報を 1〜2 行にまとめて表示する
- **warnings**: トップレベルの `"warnings": ["..."]`。1 件以上あるときだけ付く。`http.tls.insecure is enabled: TLS certificate verification is DISABLED for this run` や履歴の書き込み失敗など、ステップの成否には影響しない警告を重複なく載せる。同じ警告は従来どおり stderr にも `klaus: warning:` 行で出る。text 出力ではサマリーの前に `warning:` 行として出し、HTML・GitHub レポートにも載せる

### JUnit レポート

`--report junit` で flow = `<testsuite>`、step = `<testcase>` の XML を `--report-file` に書き出す。stdout の text / JSON 出力とは独立して併用できる。特殊文字は XML エスケープされる。

<code v-pre>{{env.X}}</code> 由来のシークレットは履歴 JSONL と同じ規則でマスクされる(URL エンコード形(encodeURIComponent 形・form-urlencoded 形・WHATWG URL 正規化に近い encodeURI 形)・JSON エスケープ形も対象。詳細は [実行履歴](history.md) を参照)。このマスクは stdout の text / JSON 出力(`--json` を含む)にも既定で適用される。`--no-mask` を付けると stdout 側のマスクだけを無効化できる — 履歴 JSONL・JUnit ファイル出力は常にマスクされ、`--no-mask` の影響を受けない。レスポンス本文由来の制御文字は XML 1.0 が許容するタブ・LF・CR 以外を可視エスケープ(`\xNN`)に変換したうえで書き出される。**この制御文字の可視エスケープは JUnit レポートと text 出力にのみ適用され、JSON 出力(`--json` を含む)には適用されない。**

### TAP レポート

`--report tap` で [TAP version 13](https://testanything.org/) 形式のファイルを `--report-file` に書き出す: 先頭の `1..N` プラン行(N = 全フロー通しての総ステップ数)に続けて、実行順に1ステップ1行の `ok`/`not ok` 行(`<flowName> > <stepName>` という名前)が並ぶ。`skipped` ステップは `# SKIP <理由>` ディレクティブ付きの `ok` として表現される(TAP には専用の skip 行が無いため)。`failed`/`error` ステップは `not ok` になり、失敗したアサーションごとに1行の `# ...` 診断コメント(`error` ステップは実行時エラーメッセージ)が続く。flow/step 名や診断メッセージに含まれる改行と `#` は、行指向の TAP フォーマットを壊さないようエスケープされる。

マスキングは JUnit レポートと同じ規則に従う(<code v-pre>{{env.X}}</code> 由来のシークレットを制御文字のサニタイズより先にマスクし、`--no-mask` の影響を受けない)。

`--report` にカンマ区切りリストを渡す(例: `--report junit,tap`)と、1回の実行で両方のフォーマットを生成できる。ペアリングの規則は前述の `--report`/`--report-file` の説明を参照。

### HTML レポート

`--report html` で、自己完結した単一の HTML ファイルを `--report-file`(既定は `klaus-report.html`)に書き出す。CSS はインラインのみで、外部アセットも JavaScript も使わない。実行ヘッダー(ステータス、開始時刻、所要時間、run ID、判明していれば env・actor・git commit)、集計件数、フローごとのセクション(1ステップ1行: ステータス、リクエスト行、レスポンスステータス、所要時間)を表示する。`failed` と `error` のステップは既定で展開され(`<details>` 要素)、失敗したアサーションの期待値/実測値と、request/response(ボディは JSON 出力と同じく 500 文字で切り詰め)を表示する。ブラウザのライト/ダーク設定に追従し、印刷もできる。リダイレクトを追ったステップは経路(と落としたヘッダー名)を表示し、実行時の警告は件数の下の Warnings 欄に出す。動的なテキストはすべて HTML エスケープされる。マスクは JUnit レポートと同じ規則(`--no-mask` の影響を受けない)。

### GitHub レポート

`--report github` は GitHub Actions 向けで、2種類の出力を行う。

- **ジョブサマリー(Markdown)**: ステータス行、件数の表、failed/error ステップの表(フロー、ステップ、最初の失敗メッセージ)、フローごとの折りたたみ(`<details>`)。表のセルは切り詰められ(200 文字、メッセージは 300 文字)、エスケープされる(パイプ、バッククォート、`*`、`_`、`[`、改行、HTML。URL は無効化され、クリック可能なリンクは作られない)。サマリー全体は 512 KiB を上限として強制する(GitHub のステップサマリーの上限は 1 MiB): failed ステップの表は 200 行まで、折りたたみの詳細は予算を超えた時点で注記つきで打ち切り、最終手段として行境界で切って開いた `<details>` を閉じる。出力先は次の順で決まり、stdout には決して書かない(`--json` の機械可読な出力を壊さないため)。
  1. このフォーマットに `--report-file` が指定されている: そのパスへ Markdown を書き出す(上書き)。
  2. そうでなく `GITHUB_STEP_SUMMARY` が設定されている: そのファイルへ Markdown を追記する。
  3. どちらでもない: `klaus-report.md` に書き出す。
- **アノテーション**: `GITHUB_ACTIONS=true` のとき、failed/error ステップごとに `::error file=<フローファイル>,title=<フロー> / <ステップ>::<メッセージ>` を1行出力する。workflow command のエスケープ規則(`%`、CR、LF、およびプロパティ内の `:` と `,`)を適用する。出力先は stdout で、stdout が JSON を運ぶ場合(`--json`、または非 TTY)は stderr になる(GitHub はどちらからも workflow command を解釈する)。長いタイトルとメッセージは切り詰められる(200 文字と 4000 文字)。GitHub Actions 外ではアノテーションを出さない。実行結果にステップのソース位置が含まれないため、`line=` は付かない。

マスクは JUnit レポートと同じ規則に従う。

## exit code

| code | 意味 |
|---|---|
| 0 | 全件成功 |
| 1 | 一般エラー(不正な CLI 引数・予期しない例外) |
| 2 | 定義ファイルのパースエラー |
| 3 | 実行時エラー(接続不能・タイムアウト・キャプチャ失敗、`$protected` や `guard.allowedHosts` によるステップの拒否等) |
| 4 | アサーション失敗 |

判定ルールの詳細:

1. **実行前に全ファイルをパース検証**する。1件でもパースエラーがあれば何も実行せず、stderr にファイル名と理由を出して exit 2
2. 実行中に環境ファイル(`environments/*.yaml`)のパースエラーが出た場合も exit 2
3. 実行後、runtime エラー(status "error")を含むフローがあれば **3**、なければアサーション失敗(status "failed")があれば **4**、全成功で **0**。3 と 4 が混在する場合は 3 を優先
4. 履歴 JSONL の書き込み失敗は stderr への警告のみで、ステップ結果・exit code には影響しない
5. `--dry-run` では何も送信せずアサーションも走らないため、4 は返らない。返るのは 0(すべて送信される)、1(`--record` / `--replay` / `--report` との併用などの引数エラー、またはタグ指定で 0 件)、2(パースエラー)、3(安全柵が拒否するステップ、または実行時にも失敗する展開エラー)のいずれか([ドライラン](#ドライラン-dry-run)を参照)
6. `--openapi` では、読めない・不正な OpenAPI 文書は定義ファイルのエラー(exit 2、何も実行しない)、文書に違反するレスポンスはそのステップの失敗(4)、カバレッジが `--openapi-coverage-min` を下回れば、全ステップが成功していても実行は失敗(4)になる([OpenAPI の検証](#openapi-の検証-openapi)を参照)

エージェント(Claude Code 等)は exit code だけで故障箇所を判別できる: 2 なら定義を直す、3 なら対象 API の起動状態を見る、4 ならアサーション内容とレスポンスを比較する。

## klaus req

```
klaus req <method> <url> [options]
```

フロー定義ファイルを書かずに、HTTP リクエストを1件送る。`klaus ui` の単発リクエスト機能と同じ core の経路を通るため、リクエストには安全柵が効き(後述の「安全柵」を参照)、シークレットはマスクされ、履歴に残る。API を探索するときは `curl` の代わりにこれを使う。`<method>` は大文字小文字を区別しない。URL・ヘッダー値・クエリ値・ボディはフローと同じようにテンプレート展開される(<code v-pre>{{baseUrl}}</code>、<code v-pre>{{env.X}}</code>)。対応するのは HTTP のみで、`Accept: text/event-stream` を付けたリクエストは SSE として受信する。

| オプション | 説明 | デフォルト |
|---|---|---|
| `-H`, `--header <name:value>` | リクエストヘッダー(複数指定可)。最初の `:` で分割する。同名(大文字小文字を区別しない)を繰り返した場合は最後の値を使う | — |
| `--query <key=value>` | URL のクエリ文字列にマージするパラメータ(複数指定可。値に `=` を含められる)。URL に既にある同名キーは上書きする。同じキーを繰り返した場合は最後の値を使う | — |
| `--body <json>` | リクエストボディ。JSON の値、または `@<file>` でファイルから読む(後述の「リクエストボディ」を参照) | — |
| `-e`, `--env <name>` | `environments/<name>.yaml` を読み込む(`--env-file` とは併用不可) | 環境なし |
| `--env-file <path>` | 名前付き環境の代わりに、任意パス(cwd 相対または絶対)の YAML ファイルから環境変数を読み込む。`-e`/`--env` とは併用不可 | — |
| `--var <key=value>` | その場限りのテンプレート変数を設定する(複数指定可)。環境ファイルの同名の値を上書きする。`klaus run` と同じく、シークレットとしてはマスクされない | — |
| `--timeout <ms>` | リクエストのタイムアウト(ミリ秒、正の整数) | 30000 |
| `--json` | TTY でも JSON 出力を強制する | — |
| `--text` | 非 TTY でも text 出力を強制する(`--json` とは併用不可) | — |
| `--no-history` | 履歴 JSONL への書き込みを無効にする | 履歴は有効 |
| `--no-mask` | stdout 出力(JSON/text)のシークレットマスキングを無効にする | マスク有効 |
| `--actor <name>` | 履歴エントリの `actor.name` に記録する名前(1〜100文字) | — |

`--allow-protected` は意図的に用意していない(`klaus ui` の単発リクエスト機能と同じ)。

### リクエストボディ(--body)

- `--body '<json>'` はパースした JSON の値を送る。オブジェクト・配列は JSON として送られ、`Content-Type` を指定していなければ `application/json` が補われる。
- `--body @<file>` はファイルから値を読む。パスは cwd 相対(または絶対)で、シンボリックリンクを解決した後も cwd の中に収まる必要がある。それ以外は exit code 2 で拒否する。エージェントが任意のファイルを送信先へ流せないよう、読み取りを cwd 内に限っている。
- JSON として不正な入力(直接指定もファイル内容も)は、フローの文字列 `body` と同じく生の文字列として送る。この場合 `Content-Type` は補われないため、API が必要とするなら `-H` で指定する。`'"text"'` のような JSON 文字列も、同様に生の文字列 `text` として送られる。
- ボディ内の文字列値はテンプレート展開される。

### 出力

モードの決め方は `klaus run` と同じ: stdout が非 TTY なら JSON、TTY なら text、`--json` / `--text` で強制できる。結果データは stdout、診断メッセージは stderr に出る。

JSON 出力は compact な1つのオブジェクト。フィールド名は [`run` の JSON 出力](#json-出力-機械向け)のステップと揃えてあるが、応答の確認がこのコマンドの目的なので `request` と `response` は常に含まれる。

```jsonc
{
  "version": 1,               // この出力のスキーマバージョン
  "status": "passed",         // "passed" = 応答を受信した(HTTP ステータスは問わない)、"error" = 送信できなかった・拒否された
  "startedAt": "2026-11-15T…",
  "durationMs": 12,
  "request": { "method": "GET", "url": "…", "headers": {}, "body": "…" },
  "response": { "status": 200, "headers": {}, "body": "…" },
  "historyRef": { "date": "2026-11-15", "runId": "<uuid>", "step": "request" }
}
```

- `status` が `"error"` のとき `error` に失敗理由(接続不能・タイムアウト・未解決のテンプレート変数・安全柵による拒否)が入り、`response` は無い。`Accept: text/event-stream` のリクエストでは、受信した SSE イベントが `events` に入る。
- **切り詰め**: request / response の `body` と SSE の `data` は約500文字で切り詰める。全文は `historyRef` から取得できる。
- **historyRef**: 履歴エントリが実際に書き込まれた場合のみ付く(履歴が有効で、リクエストが応答を得たか安全柵に拒否された場合。接続不能・タイムアウトは履歴に残らない)。`klaus history show <runId> --step request` で全文を取得する。エントリは `flow: "(single)"`・`source: "single"` になり、ほかのエントリと同じく監査項目(`env`、`actor`、`git`)を持つ。[実行履歴](history.md)を参照。
- <code v-pre>{{env.X}}</code> 由来のシークレットは、`klaus run` と同じく出力で既定でマスクされる。`-H` や `--body` に直接書いたトークンはシークレットとして扱われずマスクされない。本物のシークレットは <code v-pre>{{env.X}}</code> 経由で渡す。
- JSON Schema は `klaus schema --target req-report` で取得できる([klaus schema](#klaus-schema)を参照)。

text 出力は、1行目に `METHOD URL -> status (duration)`、続いて応答ヘッダーと応答ボディ(約500文字で切り詰め、制御文字は可視エスケープに変換)を出し、履歴エントリを書き込んだ場合は最後に `klaus history show` コマンドを示す `history:` 行を出す。送信しなかったリクエストは、代わりに `ERROR: <理由>` を出す。

### 安全柵

`klaus req` は `klaus run` と同じ安全柵を、送信直前にテンプレート展開後のリクエストへ適用する。

- `klaus.config.yaml` の [`guard.allowedHosts`](config.md#送信先ホストの許可リスト-guard-allowedhosts)が送信先ホストを制限する。`klaus req` がこのファイルから読むのは `guard` と `http` のセクションだけ。`run:` の既定値(`run.env`、`run.history`、`run.mask` など)は `klaus run` 用で、`klaus req` には適用しない。
- `$protected: true` の環境ではすべてのリクエストを拒否する。`$protected: readonly` では `GET` / `HEAD` / `OPTIONS` だけを送り、メソッド上書きヘッダーつきのリクエストは拒否する。[保護環境](#保護環境-protected)を参照。

拒否されたリクエストは `status: "error"`・exit code 3 で報告され、拒否は履歴にも記録される。`klaus req` には `--allow-protected` がないため、保護環境による拒否のメッセージは、代わりに `klaus run --allow-protected` でフローを実行するよう案内して終わる([トラブルシューティング](troubleshooting.md)を参照)。

`--env-file` は、`klaus run` でも `klaus req` でも、カレントディレクトリの外のファイルを指してよい。利用者が明示的に選んだ入力だからである。ファイルの値は通常の変数であり、秘密値としては扱わない(マスクされるのは <code v-pre>{{env.X}}</code> の値だけ)。

### exit code

| code | 意味 |
|---|---|
| 0 | 応答を受信した(HTTP ステータスは問わない。アサーションは無い) |
| 1 | 引数が不正: `--json` と `--text` の併用、`-e` と `--env-file` の併用、またはオプションパーサーが拒否した不正なオプション(例: `:` の無い `--header`)。予期しない例外も 1 |
| 2 | 入力が不正: 存在しない・cwd の外にある `--body` ファイル、不正なリクエスト定義、不正な環境ファイルまたは `klaus.config.yaml` |
| 3 | 実行時エラー: 接続不能・タイムアウト・未解決のテンプレート変数、`$protected` や `guard.allowedHosts` によって拒否されたリクエスト |

exit code 4 は返さない。HTTP ステータスで失敗させたい場合は、`assert` を書いたフローを `klaus run` で実行する。

## klaus ui

```
klaus ui [-p <n>] [-H <host>] [--no-open]
```

| オプション | 説明 | デフォルト |
|---|---|---|
| `-p`, `--port <n>` | 待ち受けポート | `4884`(固定) |
| `-H`, `--host <host>` | 待ち受けホスト | `127.0.0.1` |
| `--no-open` | ブラウザの自動起動を抑止 | 自動起動する |

起動するとトークン付き URL(`http://127.0.0.1:<port>/?token=…`)を stdout に表示し、デフォルトブラウザで開く。Ctrl+C で終了。サーバーの機能・セキュリティモデル・HTTP API は [localhost UI](ui.md) を参照。

`--port` / `--host` / `--no-open` は `klaus.config.yaml` で既定値を設定できる。詳細は [CLI オプションの既定値](config.md) を参照。

共有のマルチユーザーホストでは、このトークン付き URL がブラウザ起動コマンドの引数として渡るため、他のローカルユーザーからプロセス一覧経由で読める可能性がある。そうした環境では `--no-open` を指定し、表示された URL を自分で開くこと。

### docker-compose での利用

コンテナ内で `klaus ui` を使う場合、ポートマッピングを固定するために既定ポート(`4884`)をそのまま使い、コンテナ外(ホスト側)から到達できるよう `--host 0.0.0.0` を指定する。

```yaml
services:
  klaus:
    image: your-klaus-image
    command: ["klaus", "ui", "--host", "0.0.0.0", "--no-open"]
    ports:
      - "4884:4884"
```

`--host 0.0.0.0` を指定するとネットワーク内の他ホストからも接続できるようになる(表示される URL は開ける URL として `127.0.0.1` のまま示され、末尾に `(listening on 0.0.0.0)` の注記が付く)。トークン付き URL を知っていれば誰でも UI・API にアクセスできてしまうため、信頼できないネットワークに公開しない、URL を共有しない、など取り扱いに注意すること。

## klaus validate

```
klaus validate [files...] [options]
```

フロー定義 YAML のスキーマ検証のみを行う(実行・ネットワークアクセスは一切しない)。環境ファイル(`environments/*.yaml`)は対象外。

| オプション | 説明 | デフォルト |
|---|---|---|
| `--json` | TTY でも JSON 出力を強制 | — |

- **引数あり**: 指定したファイルのみを検証する
- **引数なし**: カレントディレクトリ以下を再帰探索し、フロー候補 YAML(最上位に `steps` キーを持つもの、`klaus ui` の `GET /api/flows` と同じ探索仕様・除外ディレクトリ)を検証する

出力モードは `run` と同じ判定(TTY なら text、非 TTY または `--json` なら JSON、結果は stdout・診断は stderr)。

### text 出力

ファイルごとに `OK`(検証成功)または `NG`(検証失敗)を1行で表示し、`NG` の場合はエラー一覧を続けて表示する。エラーには主要なケース(method 不正・request/ws の排他や必須・body/graphql の排他・ws の URL スキーム不正・url 欠落・steps 空・step 名重複など)に限り、1行の修正例ヒントが付く。issue の位置が YAML ノードとして解決できた場合は、エラー行の末尾に `(line N)` が付加される(列番号はテキスト出力には含まれない)。

```
OK   flows/login.yaml
NG   flows/broken.yaml
  - steps.0.request.method (line 6): request.method is required unless request.graphql is set
    example: method: GET
```

### JSON 出力

```jsonc
{
  "version": 1,
  "files": [
    {
      "path": "flows/broken.yaml",
      "valid": false,
      "errors": [
        {
          "path": "steps.0.request.method",
          "message": "request.method is required unless request.graphql is set",
          "hint": "example: method: GET",
          "line": 6,
          "column": 7
        }
      ]
    }
  ]
}
```

`errors[].path` は zod issue の path をドット区切りにしたもの(YAML 構文エラーなど issue の位置を特定できない場合は空文字列)。`hint` は主要なケースにのみ付与される(undefined になりうる)。`line` / `column` は issue.path が指す YAML ノードの1始まり行・列番号で、ノードを解決できない場合は付与されない(undefined になりうる)。

exit code は全ファイル valid なら **0**、1件でも YAML 構文エラー・スキーマ違反があれば **2**。予期しない例外は `run` と同様 exit 1。

## klaus schema

```
klaus schema [-t <target>]
```

| オプション | 説明 | デフォルト |
|---|---|---|
| `-t`, `--target <target>` | 出力するスキーマ。`flow`(フロー定義 YAML)、`run-report`(`run --json` の出力ペイロード)、`req-report`(`req --json` の出力ペイロード)、`dry-run-report`(`run --dry-run --json` の出力ペイロード)、`config`([klaus.config.yaml](config.md)) | `flow` |

JSON Schema(zod スキーマから生成、2スペース pretty print)を stdout に出力するだけで、ファイルへの書き出しはしない。

各スキーマは静的ファイルとしても公開されている: `https://almondoo.github.io/klaus/schema/flow.schema.json` / `https://almondoo.github.io/klaus/schema/run-report.schema.json` / `https://almondoo.github.io/klaus/schema/req-report.schema.json` / `https://almondoo.github.io/klaus/schema/dry-run-report.schema.json` / `https://almondoo.github.io/klaus/schema/klaus-config.schema.json`。npm パッケージにも `node_modules/@almondoo/klaus/dist/schema/*.json` として同梱される。

`run --json` の `version` フィールドは package.json のバージョンとは独立した単なるリテラル値(現在は `2`。`req --json` と `run --dry-run --json` は `1`)。このスキーマの後方互換を壊す変更(フィールド削除・型変更・意味変更)をする場合のみ値を上げる(オプショナルフィールドの追加のような後方互換な変更では上げない)。利用側は現在の形が不変とは仮定せず、`version` を見て分岐すること。

`request`/`ws` の排他・どちらか必須、`body`/`graphql` の排他、`graphql` 無しの `method` 必須、`ws.url` のスキーム制約、step 名の一意性は zod の `superRefine` によるカスタムバリデーションであり JSON Schema では表現できないため、該当箇所の `description` に注記を付与する形で補っている。常に exit 0。

## klaus init

```
klaus init
```

オプションはない。カレントディレクトリに最小構成を生成する。

| 生成されるファイル | 内容 |
|---|---|
| `api/example.yaml` | `https://example.com` への GET 1件、ステータス200のアサーション(英語コメント付き) |
| `environments/local.yaml` | `baseUrl` を持つ最小の環境ファイル |
| `AGENTS.md` | AI コーディングエージェント向けに、コマンド体系・YAML スキーマ要点・assert の運用指針・exit code 表・api/flows のディレクトリ規約を約50行に圧縮したガイド(英語) |

既存ファイルは上書きせずスキップし、その旨を stdout に表示する。必要なディレクトリは自動で作成される。常に exit 0。1件以上生成した場合、最後に次のコマンドのヒントを表示する: `klaus run api/example.yaml -e local`

`AGENTS.md` には、エージェント実行環境向けの注意点として、`klaus ui` を安易に起動せずバックグラウンド実行+タイムアウト管理を行うべきこと、および OpenAI Codex CLI はサンドボックスのネットワークアクセスが既定で無効なため `klaus run` の HTTP リクエストが失敗する場合があること(`~/.codex/config.toml` の `[sandbox_workspace_write] network_access = true` で解除)も含まれる。

## klaus history

ブラウザ UI を起動せずに実行履歴(`.klaus/history/*.jsonl`)を CLI から参照する。エージェントが巨大なレスポンスボディに汚染されずに履歴を読めるよう、デフォルトではフィールドを絞って出力する。ファイル規則・スキーマの詳細は [実行履歴](history.md) を参照。

### 一覧(klaus history)

```
klaus history [options]
```

| オプション | 説明 | デフォルト |
|---|---|---|
| `--flow <name>` | フロー名で絞り込む(完全一致) | — |
| `--failed` | status が failed のエントリのみに絞り込む | — |
| `--last <n>` | 取得件数 | 20 |
| `--fields <csv>` | 出力するフィールド(カンマ区切り) | `startedAt,runId,flow,step,status,durationMs` |
| `--json` | TTY でも JSON 出力を強制する | — |

出力モードは `klaus run` と同じ TTY 判定規約: stdout が TTY なら簡潔なテキスト表(1行1エントリ)、非 TTY(パイプ / エージェント実行)または `--json` 指定時は compact な JSON 配列を出力する。`--fields` に `request` / `response` / `assertions` 等を明示指定すれば、デフォルトでは含まれないリクエスト/レスポンスボディも取得できる。

```
$ klaus history --last 5 --fields step,status,durationMs
step     status  durationMs
get-me   failed  3
login    passed  6
```

```
$ klaus history --json --failed
[{"startedAt":"2026-08-08T…","runId":"<uuid>","flow":"認証フロー","step":"get-me","status":"failed","durationMs":3}]
```

### 詳細表示(klaus history show)

```
klaus history show <runId> [--step <name>]
```

指定した `runId` に一致する履歴エントリを、保存されたままの形(シークレットはマスク済)ですべて JSON 出力する(TTY 判定はせず常に JSON)。`--step` を指定するとそのステップのみに絞り込む。該当エントリが無い場合は stderr にメッセージを出して exit 1。

```
$ klaus history show 3fa1c2e0-... --step get-me
[{"v":1,"runId":"3fa1c2e0-...","flow":"認証フロー","step":"get-me","status":"failed", …}]
```

`klaus history` の一覧出力に含まれる `runId` / `step` を使って、詳細が必要なエントリだけをこのコマンドで掘り下げる、という使い方を想定している。

## klaus diff

履歴に記録された2つの run をステップ単位で比較する。詳細(比較される内容、揮発する値の除外、JSON の形)は [run の比較](history.md#run-の比較)を参照。

```
klaus diff [runA] [runB] [options]
```

runId を2つ(完全一致)、または `latest` / `previous` と `--flow` の組み合わせで指定する。`--flow <name>` だけで runId を省略すると、`previous` と `latest` を比較する。

| オプション | 説明 | デフォルト |
|---|---|---|
| `--flow <name>` | フロー名。`latest` / `previous` には必須で、比較をそのフローに限定する | — |
| `--ignore-header <name>` | 比較から除外するレスポンスヘッダー(複数指定可、大文字小文字を区別しない)。既定の一覧に追加される | — |
| `--no-default-ignores` | 既定で除外される揮発性のレスポンスヘッダーを除外しない | — |
| `--ignore-path <jsonpath>` | ボディ比較から除外する JSON パス(複数指定可)。例: `$.id`、`$.items[*].createdAt`、`$..updatedAt` | — |
| `--duration-threshold <ms>` | 所要時間の変化がこのミリ秒を超えたステップを差分として報告する | 所要時間は無視 |
| `--max-differences <n>` | ステップ・セクションごとに保持する差分の件数。超過分は「and N more」として数える | 50 |
| `--max-value-length <n>` | 出力中の値を n 文字に切り詰める | text は 80、JSON は無制限 |
| `--json` | TTY でも JSON 出力を強制する | — |
| `--text` | 非 TTY でも text 出力を強制する | — |

出力は通常の TTY 判定に従う(stdout が TTY でなければ JSON)。`--json` と `--text` は併用できない。

| exit code | 意味 |
|---|---|
| 0 | 差分なし |
| 1 | 引数が不正(フラグの併用・不正な `--ignore-path`・`--flow` なしの `latest` / `previous` を含む)、runId が見つからない・該当する `latest` / `previous` が無い(`klaus history show` と同じ)、または予期しないエラー |
| 4 | 差分あり |

## klaus promote

履歴の記録から、観測したレスポンスをもとにアサーションを推論した、再実行可能なフロー YAML を生成する。詳細(リクエストの再構成、推論されるアサーション、値のチェイン)は [run のフロー化](history.md#run-のフロー化)を参照。

```
klaus promote <runId...> [options]
```

| オプション | 説明 | デフォルト |
|---|---|---|
| `-o, --out <path>` | 出力ファイル。カレントディレクトリからの相対パスで、配下に収まること | 1ステップなら `api/<name>.yaml`、複数なら `flows/<name>.yaml` |
| `--stdout` | ファイルを書かず YAML を stdout に出力する(サマリーは stderr) | — |
| `--force` | 出力ファイルが既にある場合に上書きする | — |
| `--assert <mode>` | 推論するアサーション: `status`、`schema`(status + content-type + bodySchema)、`values`(status + content-type + 安定したスカラー値の equals)、`all` | `schema` |
| `--base-url-var <name>` | すべての URL のオリジンを <code v-pre>{{name}}</code> に置き換え、環境ファイルに入れる値を出力する | — |
| `--no-chain` | ステップ間の capture 連鎖を推論しない | — |
| `--allow-template-literals` | 記録されたリクエスト値にリテラルの <code v-pre>{{</code> が含まれていても、拒否せずに出力する(フロー実行時にテンプレートとして展開されるため、1件ずつ確認すること) | — |
| `--name <name>` | フロー名 | 記録されたフロー名、またはホストから導出 |
| `--flow <name>` | run に複数のフローが含まれる場合に、対象とするフロー | — |
| `--json` | TTY でも JSON のサマリー出力を強制する | — |
| `--text` | 非 TTY でも text のサマリー出力を強制する | — |

複数の runId は指定した順に連結される。`--stdout` は `--out` / `--force` と、`--json` は `--text` と併用できない。

| exit code | 意味 |
|---|---|
| 0 | フローを生成した(`--stdout` でなければ書き出した) |
| 1 | 引数が不正、runId が見つからない、複数フローの run で `--flow` が無い(`klaus history show` と同じ)、または予期しないエラー |
| 2 | 出力ファイルが既に存在する、カレントディレクトリ外または安全でないシンボリックリンク経由の出力パス、フロー化できるステップが無い、記録値にリテラルの <code v-pre>{{</code> が含まれる(`--allow-template-literals` なし)、再現できないマスク値がある、または生成されたフローが不正 |

履歴にマスクされずに保存される秘密情報(環境ファイル・`--var`・capture 由来の値)は、秘密情報を示すキー・ヘッダーの下にある場合やトークンらしい値の場合に <code v-pre>{{env.TODO_*}}</code> のプレースホルダーに置き換えられ、コマンドは常に、コミット前に機微情報を確認するよう促す注意を出力する。

## klaus mock

`klaus run --record <dir>` で記録した応答を、ネットワークに出ずにローカル HTTP サーバーから返す。詳細(マッチング規則、応答、使用例)は[モックサーバー](record-replay.md#モックサーバー)を参照。

```
klaus mock <dir> [options]
```

| オプション | 説明 | デフォルト |
|---|---|---|
| `-p, --port <n>` | 待ち受けるポート(`0` で空きポートを自動選択) | 4885 |
| `-H, --host <host>` | バインドするアドレス(外部からの接続を許可するには `0.0.0.0`) | `127.0.0.1` |
| `--cors` | 寛容な CORS ヘッダーを付け、preflight に応答する | — |
| `--delay <ms>` | すべての応答に加える固定遅延 | — |
| `--ignore-query` | メソッドとパスのみでマッチする | — |
| `--sequence` | 同じリクエストの複数の記録を記録順に返す | — |
| `--origin <url>` | このオリジンで記録されたエントリだけを返す | — |
| `--allow-host <host>` | この `Host` ヘッダー名も許可する(複数指定可。DNS リバインディング対策の検証を緩める) | — |
| `--json` | 起動行(stdout)とリクエストログ(stderr)を JSON Lines にする | — |

サーバーは SIGINT / SIGTERM まで動き続け、停止すると exit 0 で終わる。終了コードは、カセットが無い・不正・空の場合、または `--origin` に該当する記録が無い場合が **2**。不正なオプション値(`--port 99999` や形式の誤った `--origin` など)、ポート使用中、その他の実行時エラーは **1**。

## klaus snapshot

履歴に記録された `assert.snapshot` の結果を確認し、受け入れる([snapshot](flow-definition.md#snapshot-基準との比較))。どちらのサブコマンドも履歴を読み、書き込むのは `accept` だけで、書くのもスナップショットファイルだけ。

```
klaus snapshot list [runId] [options]
klaus snapshot accept <runId> [options]
```

| サブコマンド | 説明 |
|---|---|
| `list [runId]` | run のスナップショットの不一致(基準が無く書き込まれなかったものを含む)を列挙する。`runId` を省略すると、履歴で最新の、snapshot アサーションを持つ run を使う。読み取り専用 |
| `accept <runId>` | run の承認待ちスナップショットを、履歴に保存されたマスク済みのレスポンスから、新しい基準として書き込む。`--step` がなければ、その run の承認待ちすべて |

| オプション | 説明 |
|---|---|
| `--step <name>` | このステップのスナップショットだけ(両サブコマンド) |
| `--json` | TTY でも JSON 出力を強制する |
| `--text` | stdout が TTY でなくても text 出力を強制する |

`accept` は、履歴の候補を基準のエントリと同じ形で検証し(形が不正なものは `corrupt` として拒否)、他のアサーションが失敗したステップから記録された候補は拒否する(`failed-step`)。run が実行されたときに履歴へ記録された候補を使う。API をもう一度呼ぶことはなく、基準はその run が見た内容と一致する。書き込むのは、カレントディレクトリ内の `<dir>/__snapshots__/<name>.snap.json` という名前のファイルだけで、シンボリックリンクは辿らず、ファイル内の他のキーには触れない。書き込み後は、スナップショットファイルの `git diff` を確認すること。

`list --json` は `{ "version": 1, "runId": "...", "mismatches": [{ "flow", "step", "iteration"?, "flowFile"?, "snapshotFile", "key", "state", "message", "differences", "differenceCount", "otherAssertionsFailed" }] }`。`otherAssertionsFailed` は、記録された実行でそのステップの他のアサーション(OpenAPI の検証を含む)が失敗していたときに true で、その候補は承認できない。`accept --json` は `{ "version": 1, "runId": "...", "accepted": [{ "key", "snapshotFile", "state": "written" | "updated" }], "failed": [{ "key", "snapshotFile", "kind", "message" }] }` を出力する。

| exit code | 意味 |
|---|---|
| 0 | 成功(`list` は常に、`accept` はすべて書き込めたとき) |
| 1 | 引数不正(`--json` と `--text` の併用を含む)、不明な run ID、snapshot アサーションを持つ run が無い(runId なしの `list`)、承認待ちが無い(`accept`)、または予期しないエラー |
| 2 | `accept`: スナップショットファイルまたは記録された候補が壊れている、安全に書き込めないパス(カレントディレクトリの外、`__snapshots__` の下でない、シンボリックリンク、隠しディレクトリ)、またはそのステップの他のアサーションが失敗していた(JSON では `kind: "failed-step"`) |
