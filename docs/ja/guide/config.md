# klaus.config.yaml(CLI オプションの既定値)

`klaus run` / `klaus ui` でよく使うオプションは、`klaus.config.yaml` に既定値として書いておくことで、毎回コマンドライン引数として渡さなくて済む。

## ファイル名と探索規則

ファイル名は `klaus.config.yaml` 固定。cwd から上方探索で解決する(規則は[環境ファイル](flow-definition.md)の探索と同じ)。

- cwd から順に親ディレクトリへ辿り、各ディレクトリ直下の `klaus.config.yaml` の存在を確認する。見つかった時点でそのパスを使う。
- 探索の上限(境界)は「`.git` エントリを含む最初の祖先ディレクトリ(そのディレクトリ自身は含めて調べたうえで打ち切る)」または「ファイルシステムのルート」のいずれか先に到達した方。リポジトリルートを跨いで探索することはない。
- どの祖先ディレクトリにも見つからなかった場合は既定値を使わない(エラーにはならない)。

cwd より上の祖先ディレクトリで見つかった場合は、そのディレクトリとファイルの所有者・パーミッションを検査する(共有ホストで他ユーザーが仕込んだ config を黙って読み込まないようにするため)。所有者が自分以外、または other-writable(誰でも書き換え可能)と判定された場合はエラーで拒否する。cwd 自身に置いた `klaus.config.yaml` はこの検査の対象外。

## 優先順位

**CLI で明示指定したオプション > `klaus.config.yaml` > 組み込みの既定値**

コマンドライン引数で明示的に指定したオプションは常に `klaus.config.yaml` の値より優先される。CLI で指定しなかったオプションにのみ、`klaus.config.yaml` の値が(あれば)適用される。`--no-history` / `--no-mask` / `--no-open` のような否定フラグも同様に扱われる: CLI で明示的に `--no-xxx` を渡した場合はその値が優先され、何も指定しなかった場合にだけ `klaus.config.yaml` の値が効く。

## 設定可能なキー

```yaml
# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/klaus-config.schema.json
run:
  env: local
  report: junit
  reportFile: klaus-report.xml
  history: true
  mask: true
  jobs: 4
ui:
  port: 4884
  host: 127.0.0.1
  open: true
guard:
  allowedHosts:
    - api.example.com
    - "*.example.com"
    - localhost:3000
http:
  followRedirects: true
  cookies: true
  proxy: "{{env.KLAUS_PROXY}}"
  tls:
    ca: certs/internal-ca.pem
```

| キー | 対応する CLI オプション | 型 |
|---|---|---|
| `run.env` | `klaus run --env <name>` | string |
| `run.report` | `klaus run --report <list>` | `"junit"` / `"tap"` / `"html"` / `"github"` のカンマ区切りリスト(例: `"junit,html"`) |
| `run.reportFile` | `klaus run --report-file <path>` | string |
| `run.history` | `klaus run --no-history`(`false` で無効化に相当) | boolean |
| `run.mask` | `klaus run --no-mask`(`false` で無効化に相当) | boolean |
| `run.jobs` | `klaus run --jobs <n>` | number(1〜32) |
| `run.openapi` | `klaus run --openapi <path>` | 文字列、または文字列のリスト(下記参照) |
| `ui.port` | `klaus ui --port <n>` | number(1〜65535) |
| `ui.host` | `klaus ui --host <host>` | string |
| `ui.open` | `klaus ui --no-open`(`false` で無効化に相当) | boolean |
| `guard.allowedHosts` | なし(config 専用。[送信先ホストの許可リスト](#送信先ホストの許可リスト-guard-allowedhosts)を参照) | 文字列の配列 |
| `http.followRedirects` / `http.maxRedirects` / `http.cookies` / `http.auth` | なし(フローのトップレベル `http:` が上書きする。[HTTP クライアント](#http-クライアント-http)を参照) | boolean / 数値(0-100) / boolean / 認証ヘルパー |
| `http.proxy` | なし(config 専用) | 文字列(proxy の URL) |
| `http.tls.ca` / `http.tls.cert` / `http.tls.key` / `http.tls.insecure` | なし(config 専用) | ファイルパス / boolean |

`run.*` のキーは `klaus run` にのみ適用される。`klaus req` がこのファイルから読むのは `guard` と `http` のセクションだけ。いずれのキーも省略可能。未知のキーを含む場合はスキーマ検証エラーになる([実行結果](#エラー時の扱い)を参照)。

`run.openapi` には OpenAPI 文書 1 つ、またはそのリストを書く(`klaus run --openapi`。[OpenAPI の検証](cli.md#openapi-の検証-openapi)を参照)。相対パスは、カレントディレクトリではなく `klaus.config.yaml` のあるディレクトリから解決する。コマンドラインの `--openapi` は、設定ファイルのリストに加えるのではなく置き換える。ほかの OpenAPI オプション(`--openapi-base-url`・`--openapi-strict`・`--openapi-coverage-min`)は設定できない。実行が失敗する条件を変えるものなので、呼び出しごとに選ぶ。

`run.reportFile` は単一値のみ対応する(CLI の繰り返し指定可能な `--report-file` とは異なる)。`run.report` に複数フォーマット(例: `junit,tap`)を指定した状態で `run.reportFile` も設定した場合、それは「N フォーマットに対して `--report-file` を1個指定した」ことになり、CLI で `--report-file` の指定回数が足りないときと同じ個数不一致エラーになる([CLI リファレンス](cli.md#klaus-run)参照)。複数フォーマットの `run.report` に対してフォーマットごとの出力先を指定したい場合は、コマンドラインで `--report-file` を渡すこと(前述の優先順位のとおり CLI の値が `klaus.config.yaml` より常に優先される)。

## 送信先ホストの許可リスト (guard.allowedHosts)

`guard.allowedHosts` は、リクエストの送信先として許可するホストを制限する。フロー(や `klaus req`・`klaus ui` の単発リクエスト)が意図しないサーバーへ送信してしまう事故を防ぐガードレール。

```yaml
guard:
  allowedHosts:
    - api.example.com
    - "*.example.com"
    - localhost:3000
    - "[::1]:3000"
```

| エントリの書式 | 一致するホスト |
|---|---|
| `api.example.com` | そのホストのみ(完全一致) |
| `*.example.com` | 任意の深さのサブドメイン(`a.example.com`、`a.b.example.com`)。基底ドメイン `example.com` 自身には一致しない |
| `localhost:3000` / `[::1]:3000` | そのホストの、そのポートのみ。ポートを省略したエントリは任意のポートに一致する。IPv6 リテラルは角括弧で書く |

- 大文字小文字は区別しない。
- エントリは厳密に検証される。次は検証エラー(exit code 2)になる: `*.` の後ろが 2 ラベル未満(`*.com`、`*.localhost`)、空ラベル(`a..b`、末尾のドット)、パーセントエンコードされたホスト、通常のドット区切り IPv4 以外の数値ホスト(`0`、`2130706433`、`0x7f.1`、8進表記)。`127.0.0.1` のような通常の IPv4、角括弧つき IPv6、`localhost`、`backend` のような単一ラベルの内部名は有効。リクエスト側の URL は URL の正規化後に照合するため、`http://2130706433/` は `127.0.0.1` として扱われる。
- `guard.allowedHosts` を書かなければ制限なし。空配列や書式不正のエントリは検証エラー(exit code 2、[エラー時の扱い](#エラー時の扱い)を参照)。
- 送信直前に、テンプレート展開後の URL に対して判定する。対象は HTTP / SSE / WebSocket ステップと、`klaus req` および `klaus ui` からの単発リクエスト。`--replay` では判定しない(実送信がないため)。`--record` では判定する。
- 拒否されたステップは `error` になり、実行は exit code 3 で終わる。[トラブルシューティング](troubleshooting.md#「host-x-is-not-in-guard-allowedhosts-klaus-config-yaml-refusing-to-send-the-request-」)を参照。
- CLI フラグで上書きする手段は意図的に設けていない。`klaus ui` は起動時に config を読むため、リストを変更したら再起動すること。

## HTTP クライアント (http)

`http` は、実行単位(フロー 1 回の実行、または `klaus req` / `klaus ui` の単発リクエスト 1 回)の全ステップで共有する HTTP クライアントを設定する。何も指定しなければ従来どおり(リダイレクトを追わない、cookie を保持しない、proxy なし)。

| キー | 意味 |
|---|---|
| `followRedirects` | `301` / `302` / `303` / `307` / `308` を 1 ホップずつ追う(既定 `false`)。各ホップは通常のリクエストと同じ `guard.allowedHosts` と `$protected` の判定を通り、拒否されたホップはステップを `error` にする。`POST` への `301` / `302` と `303` はボディなしの `GET` に変わり、`307` / `308` はメソッドとボディを保つ。別オリジン(スキーム・ホスト・ポートのいずれかが違う。https から http への格下げも含む)へ移るときは、`Authorization`・`Cookie`・`Proxy-Authorization` と、登録済みの秘密値を値に含むヘッダーをすべて落とし、それ以外のヘッダーは転送する。経由した URL と落としたヘッダー名(名前のみ)は結果と履歴に `redirects` / `droppedHeaders` として残る |
| `maxRedirects` | 最大ホップ数(既定 `10`)。超えると `error` |
| `cookies` | `Set-Cookie` を実行中メモリ上に保持し、以降の条件に合うリクエストに付ける(既定 `false`)。保存はしない。cookie の値は秘密値として履歴・出力でマスクされる。`Secure` cookie は `http://` に送らない。cookie は常にホスト限定で保存し、リクエストホストまたはその親を指す `Domain` 属性は受け付けるが範囲は広がらず、他のサブドメインとは共有しない(公開サフィックス一覧は持たない) |
| `auth` | 全 HTTP / SSE ステップの既定の[認証ヘルパー](flow-definition.md#auth認証ヘルパー)。フローの `http.auth` やステップの `request.auth` が上書きする。秘密値には <code v-pre>{{env.X}}</code> を使う |
| `proxy` | HTTP(S) proxy の URL。userinfo は秘密値としてマスクされる。`HTTP_PROXY` などの環境変数は読まない |
| `tls.ca` / `tls.cert` / `tls.key` | PEM ファイルのパス。この設定ファイルからの相対パスで解決する。`cert` と `key` は同時に指定する。内容は出力に出ない |
| `tls.insecure` | `true` で証明書検証を無効にし、実行のたびに警告を出す(stderr と、JSON・text・HTML・GitHub レポートの `warnings`) |

`proxy` と `tls` は通信の行き先と信頼先を決めるため、ここにだけ書ける。フローファイルに `http.proxy` や `http.tls` を書くと検証エラー(終了コード 2)になる。CLI フラグ、`klaus req` のオプション、UI のパラメーターからも設定できない。フローのトップレベル `http:` で指定できるのは `followRedirects`・`maxRedirects`・`cookies`・`auth` だけで、このセクションをキー単位で上書きする([フロー定義リファレンス](flow-definition.md#http-http-クライアント設定)を参照)。

- proxy の URL には <code v-pre>{{env.X}}</code>(OS 環境変数)をテンプレートとして使える。フローの変数や capture は参照できない。
- proxy ホスト自体は信頼する設定として扱い、`guard.allowedHosts` では判定しない。リクエストの最終的な宛先(リダイレクトの各ホップを含む)は、proxy 経由の平文 HTTP でも `CONNECT` トンネルでも判定され、拒否されたリクエストは proxy に届かない。
- `tls.insecure` の警告は stderr に `klaus: warning:` 行として出るほか、[JSON 出力](cli.md#json-出力機械向け)のトップレベル `warnings` 配列にも載る。機械可読な出力は stderr を取得していなくても警告を受け取れる。

## 意図的に設定不可なキー

以下のオプションは `klaus.config.yaml` では設定できない(スキーマにフィールドがなく、指定すると未知キーとしてエラーになる)。

| オプション | 理由 |
|---|---|
| `--allow-protected` | `$protected: true` の環境への実行を拒否するガードレールを、config で既定 true にすることで形骸化させないため |
| `--allow-hosts`(そのようなオプションは存在しない) | `guard.allowedHosts` は `klaus.config.yaml` の編集でのみ変更できる。呼び出しごとのフラグにすると、制限される側のエージェントが制限を外せてしまうため |
| `--dry-run` | 送信せずに展開後のリクエストを出力するのは、`--record` / `--replay` と同じく実行の性質を大きく変えるため、呼び出しごとに明示させる |
| `--update-snapshots` / `-u` | スナップショットの基準の書き換えは、変わったレスポンスを受け入れる明示的な操作である。恒久的な既定値にすると、毎回の実行が API の返す内容をそのまま受け入れてしまう |
| `--record` / `--replay` | record/replay モードは副作用(実際のネットワークアクセスの有無)が大きく変わる実行モードのため、呼び出しごとに明示させる |
| `--json` / `--text` | 出力モードは呼び出し元(人が読むか、エージェントやスクリプトが読むか)に依存するため、コマンドラインで都度明示させる |
| `--var` / `--env-file` / `--data` | いずれも本質的にその場限り・呼び出しごとの上書き(単発の変数、単発の環境ファイルパス、単発のデータ駆動実行用データファイル)であり、config に恒久的な既定値を持たせると本来の用途に反する |
| `--tags` / `--exclude-tags` | こちらも今回の実行で何を対象にするかというその場限りの選択であり、config に恒久的な既定値を持たせると、気づかないまま毎回一部のフローが除外され続ける事故につながりかねない |

## エラー時の扱い

`klaus.config.yaml` が YAML として不正、またはスキーマ違反(未知キーを含む)の場合、`klaus run` / `klaus ui` はファイルパスと理由を stderr に出力して **exit code 2** で終了する(フロー定義・環境ファイルのパースエラーと同じ扱い)。

## JSON Schema

`klaus.config.yaml` のスキーマも JSON Schema として公開している。

- 公開 URL: `https://almondoo.github.io/klaus/schema/klaus-config.schema.json`
- npm パッケージ同梱パス: `node_modules/@almondoo/klaus/dist/schema/klaus-config.schema.json`
- `klaus schema --target config` でも同じ内容を stdout に出力できる([CLI リファレンス](cli.md#klaus-schema)参照)

YAML ファイルの先頭に `# yaml-language-server: $schema=` コメントを書くと、対応エディタ(VS Code の YAML 拡張など)で補完・検証が効くようになる。

```yaml
# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/klaus-config.schema.json
run:
  env: local
```
