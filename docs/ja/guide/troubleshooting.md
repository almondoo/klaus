# トラブルシューティング

klaus が実際に出力するエラーメッセージを発生元ごとにまとめ、それぞれの原因と対処を示す。exit code の体系については [CLI リファレンス](cli.md#exit-code) を参照。

## フロー / 環境ファイルの定義エラー

### 「klaus: parse error: \<file\>: schema validation failed: ...」

**症状**

```
klaus: parse error: flows/broken.yaml: schema validation failed: steps.0.request.method: request.method is required unless request.graphql is set
```

**原因**: フロー定義 YAML がスキーマ検証に失敗している。必須キーの欠落、排他的なキーの同時指定(`request`/`ws`、`body`/`graphql`)、未知キー(typo の可能性)などが該当する。

**対処**: `klaus validate` をそのファイルに対して実行する。`run` と違い最初の1件だけでなく全 issue を列挙し、主要なケースには1行の修正例ヒントを添え、text 出力では YAML の行番号も付与する。[klaus validate](cli.md#klaus-validate) を参照。

### 「klaus: parse error: \<file\>: YAML syntax error (line N, column M): ...」

**症状**

```
klaus: parse error: flows/broken.yaml: YAML syntax error (line 4, column 3): Unexpected scalar at node end
```

**原因**: ファイルが YAML として正しくない(インデント崩れ、閉じていないクォートなど)。スキーマ検証が走る前の段階で検知される。

**対処**: 報告された行・列を基に YAML の構文を直す。`klaus run` は、指定した複数ファイルのうち1件でもパースに失敗すると **どれも実行しない**(exit code 2)ため、直すまで何も実行されない。`klaus validate` は各ファイルを独立に検証してファイルごとの結果を報告する(1件でも失敗があれば exit code は 2)。

## `klaus run` 実行中のランタイムエラー(exit code 3)

これらは text 出力では `ERROR` 行、`--json` 出力ではステップの `"status": "error"` として現れ、同じ実行内にアサーション失敗(exit 4)が含まれていても常に優先される。

### 「template variable "X" could not be resolved (available: ...)」

**症状**

```
template variable "userId" could not be resolved (available: env: baseUrl, testEmail; captures: token)
```

**原因**: フロー中の <code v-pre>{{userId}}</code> というプレースホルダが、それまでのステップの `capture` 名にも、有効な環境ファイルのキーにも一致していない。typo、参照元より後のステップで capture している、あるいはそのステップがスキップされて capture が実行されなかった、などが典型的な原因。

**対処**: メッセージの `available` 一覧(env・capture の変数名のみで値は含まれないため、そのままバグ報告に貼ってよい)とスペルを照合する。capture がまだ実行されていないならステップの順序を見直し、環境ファイル側のキーが足りないなら追加する。

### 「OS environment variable "X" is not defined」

**症状**

```
OS environment variable "TEST_PASSWORD" is not defined
```

**原因**: <code v-pre>{{env.X}}</code> は常に OS のプロセス環境変数を参照する(環境 YAML ファイルの値ではない。そちらは素の <code v-pre>{{var}}</code> 形式で参照する)。`klaus run` を起動したシェルで `X` が未設定になっている。

**対処**: 実行前に変数を export する。例: `TEST_PASSWORD=xxx klaus run api/login.yaml -e local`。変数解決の優先順位全体は [テンプレート](flow-definition.md#テンプレート) を参照。

### 「capture "X": JSONPath "$.foo" matched no value (step "Y")」

**症状**

```
capture "userId": JSONPath "$.data.user.id" matched no value (step "login")
```

**原因**: ステップの `capture` の JSONPath がレスポンスボディの中で何にもマッチしなかった。想定していたレスポンス形が実際と違う(成功時ではなくエラーレスポンスが返ってきた、フィールド名が変わった、ネストが1段増えたなど)ことが多い。

**対処**: そのステップの実際のレスポンスボディを確認し(`klaus history show <runId> --step <step>`、または `--json` 出力の `response.body`)、JSONPath 式を修正する。

### 「environment "X" is protected (\$protected: true) and refuses execution by default. ...」

**症状**

```
environment "production" is protected ($protected: true) and refuses execution by default. Pass --allow-protected to run against this environment intentionally.
```

**原因**: 環境ファイルに `$protected: true` が設定されており、かつ実行時にそれを許可するオプションが指定されていない。本番相当の環境へ誤って実行してしまうことを防ぐための意図的なガードレール。

**対処**: この環境への実行が意図したものであれば、`klaus run` に `--allow-protected` を指定する。`klaus ui` / server API はこのフラグを一切受け付けないため、保護環境は常に拒否され、回避手段はない。[ファイル構造](flow-definition.md#ファイル構造) を参照。

`$protected: readonly` の環境では、フラグなしで許可されるのは `GET` / `HEAD` / `OPTIONS` のみ。それ以外のメソッドは次のメッセージで拒否される。

```
environment "production" is protected ($protected: readonly) and only allows GET, HEAD, and OPTIONS by default; refusing POST. Pass --allow-protected to run against this environment intentionally.
```

メソッド上書きヘッダー(`X-HTTP-Method-Override`・`X-HTTP-Method`・`X-Method-Override`)を付けた `GET` は次のメッセージで拒否される。

```
environment "production" is protected ($protected: readonly) and refuses requests carrying the x-http-method-override header, which can turn a read into a write. Pass --allow-protected to run against this environment intentionally.
```

対処は同じ(`--allow-protected`)か、ステップを安全なメソッドに変える。GraphQL ステップは既定で `POST` のため、これも拒否される。[保護環境](cli.md#保護環境-protected)を参照。

`klaus req` と `klaus ui` の単発リクエストには `--allow-protected` オプションがないため、拒否メッセージの末尾は `Pass --allow-protected ...` の代わりに次の案内になる。

```
Single requests (klaus req, klaus ui) cannot override environment protection; run a flow with `klaus run --allow-protected` instead.
```

### 「host "X" is not in guard.allowedHosts (klaus.config.yaml); refusing to send the request.」

**症状**

```
host "api.other.com" is not in guard.allowedHosts (klaus.config.yaml); refusing to send the request.
```

**原因**: `klaus.config.yaml` に `guard.allowedHosts` が設定されており、ステップの URL(テンプレート展開後)のホストがどのエントリにも一致しない。`*.example.com` は `example.com` 自身には一致せず、ポート付きのエントリはそのポートのみに一致する点に注意。

**対処**: そのホストが意図したものなら、`klaus.config.yaml` の `guard.allowedHosts` に追加する(`klaus ui` を起動中なら再起動する)。そうでなければ URL を直す。判定を回避する CLI フラグはない。[送信先ホストの許可リスト](config.md#送信先ホストの許可リスト-guard-allowedhosts)を参照。

### 「redirect hop N (after STATUS) refused: ...」

**症状**

```
redirect hop 1 (after 302) refused: host "other.example.com" is not in guard.allowedHosts (klaus.config.yaml); refusing to send the request.
```

**原因**: `http.followRedirects` が有効で、リダイレクト先が安全柵に拒否されるホストを指している。各ホップは通常のリクエストと同じ判定を通るため、リダイレクトで `guard.allowedHosts` の外へは出られない。

**対処**: 宛先が意図したものなら `guard.allowedHosts` に追加する。そうでなければサーバー側か URL を直す。[HTTP クライアント](config.md#http-クライアント-http)を参照。

### 「http.proxy and http.tls can only be set in klaus.config.yaml, not in a flow file ...」

**症状**

```
http.proxy and http.tls can only be set in klaus.config.yaml, not in a flow file (they decide where traffic goes and whom it trusts)
```

**原因**: フローファイルに `http.proxy` または `http.tls` がある。これらは通信の行き先と信頼先を決めるため、(エージェントが書き得る)フローからは設定できない。

**対処**: 設定を `klaus.config.yaml` の `http` セクションへ移す。[HTTP クライアント](config.md#http-クライアント-http)を参照。

## `--record` / `--replay` のエラー(exit code 3)

### 「no recorded response for "METHOD url" in replay mode. ...」/「failed to read cassette file ... for replay mode: ...」

**症状**

```
no recorded response for "GET http://localhost:3000/me" in replay mode. This request was not captured in the cassette (or the method/URL does not match exactly). Re-record this flow with --record <dir> to update the cassette.
```

```
failed to read cassette file "cassettes/login/cassette.jsonl" for replay mode: ENOENT: no such file or directory, open '...'. Record a cassette first with --record.
```

**原因**: カセットのディレクトリ・ファイルがまだ存在しない(一度も `--record` していないのに `--replay` した)か、そのリクエストの method + レンダリング済み URL が記録済みのどのエントリとも完全一致しない(record 時と replay 時で解決される secrets が異なり、マッチングに使うマスク済み URL がずれている、というケースが多い)。

**対処**: まず `klaus run <files> --record <dir>` で同じ env を使ってカセットを記録し、その後 `--replay <dir>` で再生する。特定のリクエストだけ見つからない場合は、同じ `--record <dir>` で再記録してカセットを更新する。[record / replay モード](record-replay.md#マッチング規則) を参照。

### 「step "X": SSE/WS steps are not supported in record/replay mode ...」

**症状**

```
step "subscribe": SSE/WS steps are not supported in record/replay mode (HTTP only, and GraphQL over HTTP). Remove --record/--replay, or exclude this step from the flow.
```

**原因**: フローに SSE または WebSocket のステップが含まれているが、現バージョンの `--record`/`--replay` は HTTP(GraphQL over HTTP を含む)のみに対応している。

**対処**: このフローは `--record`/`--replay` なしで実行するか、SSE/WS ステップを別のフローファイルに分けて通常どおり実行する。[SSE / WebSocket ステップは非対応](record-replay.md#sse-websocket-ステップは非対応) を参照。

## `klaus req` のエラー

### 「klaus: --body file resolves outside the current directory: "X"」

**症状**

```
klaus: --body file resolves outside the current directory: "../payload.json"
```

exit code 2 で終了し、何も送信しない。

**原因**: `--body @<file>` はカレントディレクトリの内側(シンボリックリンクを解決した後も)にあるファイルしか読まない。エージェントが任意のファイルを送信先ホストへ流せないようにするため。

**対処**: ファイルをカレントディレクトリへコピーする(またはそのファイルを含むディレクトリから `klaus req` を実行する)か、`--body '<json>'` でボディを直接渡す。[klaus req](cli.md#リクエストボディ-body)を参照。

## `klaus ui` のエラー

### 「Forbidden: environment "X" is protected and cannot be edited via this API (edit the file directly)」

**症状**: 環境エディタの保存、または「抽出した値を環境へ保存」が HTTP 403 と次のメッセージで失敗する。

```
Forbidden: environment "production" is protected and cannot be edited via this API (edit the file directly)
```

**原因**: 環境ファイルに `$protected: true` または `$protected: readonly` が設定されている。UI はエージェントが操作し得る経路のため、保護環境には書き込めない。

**対処**: `environments/<name>.yaml` をエディタで直接編集する。[ファイル構造](flow-definition.md#ファイル構造)を参照。

### 「... EADDRINUSE ... (port \<n\> is already in use; specify a different port with --port)」

**症状**

```
listen EADDRINUSE: address already in use 127.0.0.1:4884 (port 4884 is already in use; specify a different port with --port)
```

**原因**: `klaus ui` の既定ポート(`4884`)は固定で自動的には変わらないため、別の `klaus ui`(または他のプロセス)が既にそのポートを使っていると起動に失敗する。

**対処**: `klaus ui --port <n>` で別のポートを指定するか、既定ポートを使用中のプロセスを停止する。
