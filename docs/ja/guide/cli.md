# CLI リファレンス

klaus のコマンドは `run`(フロー実行)・`ui`(localhost Web UI 起動)・`validate`(スキーマ検証)・`schema`(JSON Schema 出力)・`generate`(OpenAPI 仕様からのフロー生成。[OpenAPI からのフロー生成](./generate.md)を参照)・`init`(雛形生成)・`history`(実行履歴の参照)の7つ。

## --help

`klaus --help` および `klaus run --help` の末尾には、docs サイト(このサイト。英語版はサイトのルート、`/en/` 配下ではない)へのリンク・`klaus init` で雛形生成できる旨・exit code の一行要約が付与される。

## klaus run

```
klaus run <files...> [options]
```

複数ファイルを渡すと順次実行する(glob 展開はシェルに任せる)。

| オプション | 説明 | デフォルト |
|---|---|---|
| `--env <name>` | フロー定義の `env:` 指定を上書き | フローの `env:` |
| `--json` | TTY でも JSON 出力を強制 | — |
| `--text` | 非 TTY でも text 出力を強制(`--json` とは併用不可) | — |
| `--report junit` | JUnit XML レポートを生成 | — |
| `--report-file <path>` | レポートの出力先 | `klaus-report.xml` |
| `--no-history` | 履歴 JSONL への書き込みを無効化 | 履歴有効 |
| `--no-mask` | stdout(JSON/text 出力とも)へのシークレットマスキングを無効化 | マスク有効 |
| `--record <dir>` | record モード: 実際に HTTP リクエストを送信し、マスク済みの request/response ペアを `<dir>` のカセットに保存する | — |
| `--replay <dir>` | replay モード: 実ネットワークではなく `<dir>` のカセットから HTTP レスポンスを再生する(記録外リクエストは exit code 3 で失敗する)。`--record` とは併用不可 | — |
| `--allow-protected` | `$protected: true` の環境ファイルへの実行を許可する(未指定時は exit code 3 で拒否) | — |

`--report` に `junit` 以外の値を渡すと stderr にエラーを出して exit 1。`--json` と `--text` を同時に指定した場合も同様に stderr にエラーを出して exit 1(何も実行しない)。

`--env` / `--report` / `--report-file` / `--no-history` / `--no-mask` は `klaus.config.yaml` で既定値を設定できる。詳細は [CLI オプションの既定値](config.md) を参照。

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
- **historyRef**: 履歴記録が有効な実行(`--no-history` を付けていない)では、各ステップ(passed 含む)に `historyRef: { date, runId, step }` が付く。全文が必要な場合は `klaus history show <runId> --step <step>` で取得する(詳細は [klaus history](#klaus-history) / [実行履歴](history.md) を参照)。`--no-history` 実行時は `historyRef` を省略する
- SSE / WebSocket ステップでは `response.body` は無く、受信データは `events`(SSE)/ `wsMessages`(WS)フィールドに入る

### JUnit レポート

`--report junit` で flow = `<testsuite>`、step = `<testcase>` の XML を `--report-file` に書き出す。stdout の text / JSON 出力とは独立して併用できる。特殊文字は XML エスケープされる。

<code v-pre>{{env.X}}</code> 由来のシークレットは履歴 JSONL と同じ規則でマスクされる(URL エンコード形(encodeURIComponent 形・form-urlencoded 形・WHATWG URL 正規化に近い encodeURI 形)・JSON エスケープ形も対象。詳細は [実行履歴](history.md) を参照)。このマスクは stdout の text / JSON 出力(`--json` を含む)にも既定で適用される。`--no-mask` を付けると stdout 側のマスクだけを無効化できる — 履歴 JSONL・JUnit ファイル出力は常にマスクされ、`--no-mask` の影響を受けない。レスポンス本文由来の制御文字は XML 1.0 が許容するタブ・LF・CR 以外を可視エスケープ(`\xNN`)に変換したうえで書き出される。**この制御文字の可視エスケープは JUnit レポートと text 出力にのみ適用され、JSON 出力(`--json` を含む)には適用されない。**

## exit code

| code | 意味 |
|---|---|
| 0 | 全件成功 |
| 1 | 一般エラー(不正な CLI 引数・予期しない例外) |
| 2 | 定義ファイルのパースエラー |
| 3 | 実行時エラー(接続不能・タイムアウト・キャプチャ失敗等) |
| 4 | アサーション失敗 |

判定ルールの詳細:

1. **実行前に全ファイルをパース検証**する。1件でもパースエラーがあれば何も実行せず、stderr にファイル名と理由を出して exit 2
2. 実行中に環境ファイル(`environments/*.yaml`)のパースエラーが出た場合も exit 2
3. 実行後、runtime エラー(status "error")を含むフローがあれば **3**、なければアサーション失敗(status "failed")があれば **4**、全成功で **0**。3 と 4 が混在する場合は 3 を優先
4. 履歴 JSONL の書き込み失敗は stderr への警告のみで、ステップ結果・exit code には影響しない

エージェント(Claude Code 等)は exit code だけで故障箇所を判別できる: 2 なら定義を直す、3 なら対象 API の起動状態を見る、4 ならアサーション内容とレスポンスを比較する。

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
| `-t`, `--target <target>` | 出力するスキーマ。`flow`(フロー定義 YAML)、`run-report`(`run --json` の出力ペイロード)、`config`([klaus.config.yaml](config.md)) | `flow` |

JSON Schema(zod スキーマから生成、2スペース pretty print)を stdout に出力するだけで、ファイルへの書き出しはしない。

各スキーマは静的ファイルとしても公開されている: `https://almondoo.github.io/klaus/schema/flow.schema.json` / `https://almondoo.github.io/klaus/schema/run-report.schema.json` / `https://almondoo.github.io/klaus/schema/klaus-config.schema.json`。npm パッケージにも `node_modules/@almondoo/klaus/dist/schema/*.json` として同梱される。

`run --json` の `version` フィールドは package.json のバージョンとは独立した単なるリテラル値(現在は `2`)。このスキーマの後方互換を壊す変更(フィールド削除・型変更・意味変更)をする場合のみ値を上げる(オプショナルフィールドの追加のような後方互換な変更では上げない)。利用側は現在の形が不変とは仮定せず、`version` を見て分岐すること。

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
