# klaus 動作確認チェックリスト

klaus の実装一式(CLI / core / localhost UI)を `examples/` を使って手元・Docker コンテナの
両方で確認するためのチェックリスト(旧 `VERIFICATION.md` の内容を統合)。コマンドの背景説明は
[../examples/README.md](../examples/README.md) を参照。

このファイル自体は `verify/` 配下に置いているが、記載しているコマンドの実行場所(カレント
ディレクトリ)は従来どおり `examples/` である点に注意(ファイルの置き場所と実行場所は別)。

実行場所の前提:

- 0 章(ビルドとテスト)だけはリポジトリ root で実行する。
- それ以外のコマンドは `examples/` をカレントディレクトリにして実行する
  (ホストは `cd examples`、コンテナは `make exec` で最初から `/work/examples` に入る)。
- `examples/klaus.config.yaml` が `run.env: local` を既定にしているため、ホストでは表のコマンドに
  `-e local` を付けなくてよい。コンテナ内(`make verify` / `make exec`)では
  `verify/docker/klaus.config.yaml`(`run.env: docker`)がこのファイルを上書きするため
  (`verify/README.md` 参照)、同様に `-e` を付けずに表のコマンドをそのまま実行できる。
  CLI で `-e` を明示すればどちらの config よりも優先される(例: `--env development` はホスト用の
  設定なので、コンテナ内で明示すると接続エラーになる。config が上書きされていることの確認にもなる)。
- `klaus` コマンドが解決できる前提で書いてある。ホストで見つからない場合は、リポジトリ root で
  `pnpm build && npm link` して bin を通すか、`klaus` を `node ../dist/cli.js` に読み替える。

## 0. ビルドとテスト(自動検証)

- [ ] `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @almondoo/klaus-ui test && pnpm build:all && ls dist dist/ui` → 全コマンド exit 0(lint/typecheck エラー0、test 全pass、dist/ dist/ui/ が揃う)
- [ ] `pnpm exec vitest run tests/sse.test.ts tests/ws.test.ts tests/graphql.test.ts` → SSE / WebSocket / GraphQL の経路は自動テストでも検証済み

## 1. ダミー API(mock-server)の起動

ホストでは別ターミナル推奨。コンテナでは `mock-api` サービスが起動済みのため不要。

- [ ] `node mock-server.mjs &` → `mock API on http://127.0.0.1:3000` と表示される

`examples/klaus.config.yaml` に `run.env: local` の既定値サンプルが置いてある(その他のキーはコメントアウト
の記入例)。`klaus validate` は run/ui コマンド専用のこの設定を参照しない(下記参照)。

## 2. klaus validate

| command | やっていること |
|---|---|
| `klaus validate api/*.yaml flows/*.yaml` | 全サンプルの構文チェック(ネットワークアクセスなし)。全ファイル valid、exit 0 |
| `klaus validate api/*.yaml flows/*.yaml --json` | 同上を JSON 出力で(CI 連携向け) |

## 3. klaus run

単発チェック 5 本(api/)+ シナリオ 2 本(flows/)。`run` はディレクトリを渡せないため、
グロブ展開(`api/*.yaml` 等)でファイル一覧に変換して渡す。

| command | やっていること |
|---|---|
| `klaus run api/*.yaml flows/*.yaml` | 全サンプルの一括実行。7 flow / 10 step passed、exit 0 |
| `klaus run api/login-check.yaml` | 単発 HTTP チェック(POST /login、`$.token` の存在確認) |
| `klaus run api/users-check.yaml` | query / headers / body(JSONPath)/ bodySchema アサーションの見本 |
| `klaus run api/graphql-check.yaml` | GraphQL リクエスト(`request.graphql` + variables 埋め込み) |
| `klaus run api/sse-events-check.yaml` | SSE 受信(`sse:` 併用、eventCount / events で検証) |
| `klaus run api/ws-echo-check.yaml` | WebSocket エコー(`ws:` ステップ、messageCount / messages で検証) |
| `klaus run flows/auth-flow.yaml` | login → get-me の 2 step シナリオ(capture + `use:` 再利用) |
| `klaus run flows/users-crud-flow.yaml` | POST → GET → DELETE の 3 step シナリオ(capture 連鎖) |

代表オプション:

| command | やっていること |
|---|---|
| `klaus run flows/auth-flow.yaml --env development` | 環境切り替え(`environments/development.yaml`。testEmail が変わり結果も連動する。`--env` は config の `run.env` より優先される) |
| `klaus run api/login-check.yaml --json` | JSON 出力の強制(パイプ経由なら TTY 自動判定で JSON になる) |
| `mkdir -p ../tmp && klaus run api/login-check.yaml --report junit --report-file ../tmp/klaus-report.xml` | JUnit XML レポートの生成(`<testsuite ... failures="0">`。出力先ディレクトリは自動作成されないため先に mkdir する) |
| `klaus run api/login-check.yaml && tail -n1 .klaus/history/*.jsonl` | 実行履歴が1ステップ1行で追記されることを確認(`.klaus/` は gitignore 済み。config の `run.history: false` で無効化できる) |

exit code 体系(実行後に `echo $?` で確認。examples のファイルは変更しない):

| command | 期待 exit code |
|---|---|
| `klaus run api/login-check.yaml`(mock-server 起動中) | 0 |
| `klaus run does-not-exist.yaml` | 2(パースエラー) |
| `klaus run api/login-check.yaml`(mock-server 停止中) | 3(実行時エラー: 接続不可) |
| `klaus run ../tmp/bad-assert-check.yaml`(下記の一時フロー) | 4(アサーション失敗) |

```bash
mkdir -p ../tmp && cat > ../tmp/bad-assert-check.yaml <<'EOF'
name: bad-assert-check
env: local
steps:
  - name: broken
    request: { method: GET, url: "{{baseUrl}}/users" }
    assert: { status: 999 }
EOF
klaus run ../tmp/bad-assert-check.yaml; echo "exit: $?"
```

## 4. klaus generate(OpenAPI walkthrough)

生成 → validate → 実行までの一連の流れ。

| command | やっていること |
|---|---|
| `klaus generate openapi/users-api.yaml --out-dir generated` | OpenAPI 3.x 定義から骨組みフローを生成。`generated/` に 6 ファイル(login / get-current-user / list-users / create-user / get-user / delete-user)、exit 0 |
| `klaus validate generated/*.yaml` | 生成物の構文確認。6 ファイル全て valid、exit 0 |
| `klaus run generated/login.yaml generated/list-users.yaml generated/create-user.yaml` | パスパラメータを含まない 3 本の実行。全て passed、exit 0 |

- 生成物は骨組み(request + `assert.status` のみ)。パスパラメータや認証ヘッダーを含む
  operation(`get-user` / `delete-user` / `get-current-user`)は手直しが前提(README.md 参照)。
- `generated/` は `examples/.gitignore` で無視される。再実行する場合は生成物を削除してから
  (既存ファイルはスキップされ上書きされない)。

## 5. klaus ui

`examples/klaus.config.yaml` の `ui.port` / `ui.host` が既定値(`4884` / `127.0.0.1`)を与えるため、
ホストでは `klaus ui` を素のまま実行すれば `http://127.0.0.1:4884/?token=...` が表示される
(`ui.open` は既定どおり `true` なのでブラウザも自動で開く)。CLI で明示すれば config より優先される。

| command | やっていること |
|---|---|
| `klaus ui` | localhost UI の起動。トークン付き URL が表示されブラウザが開く(config の port/host/open を使用) |
| `klaus ui --port 4885 --no-open` | ポート指定 + ブラウザ自動起動なし(config より明示指定が優先される代表オプション) |

チェック項目:

- [ ] フロー一覧に「認証フロー」が表示される
- [ ] 実行ボタン → ステップがライブで PASS になり「Step 2 / 2」が表示される(`flows/auth-flow.yaml` は login + get-me の2ステップ)
- [ ] 履歴タブに実行が run 単位で表示され、行クリックで詳細展開できる
- [ ] `?token=` なしの `http://127.0.0.1:<port>/` をシークレットウィンドウで開くと案内画面になる(認証が効いている)
- [ ] 実行中にブラウザを閉じても `examples/.klaus/history/` に全ステップ分が書かれる(切断耐性)

コンテナ内(`make exec` / cwd `/work/examples`)で `klaus ui` を実行する場合は、config オーバーレイ
(`verify/docker/klaus.config.yaml`)により `ui.host: 0.0.0.0`・`ui.open: false` が既定になる
(コンテナの 127.0.0.1 バインドはホストから届かず、コンテナにはブラウザも無いため)。表示される
トークン付き URL のホスト部だけ `127.0.0.1` に読み替えれば、ホストのブラウザから
`http://127.0.0.1:4884/?token=...` としてそのまま開ける(compose.yaml の `127.0.0.1:4884:4884`
ポートマッピング経由)。

## 6. make verify のコンテナで実行する場合

`verify/docker/` 一式の目的(npm publish 相当検証)や構成、`make verify` が内部で何を自動検証
しているかは [verify/README.md](./README.md) を参照。ここでは手順だけをまとめる。

- [ ] `docker version` → Docker デーモンが利用できることを確認(利用できない環境では次の
      `docker compose build` の時点で失敗する)
- [ ] `make verify` → auth-flow スモーク(1本、`-e` なし)が PASS、examples 一式スモークが
      7 flow / 10 step passed、generate 一連スモークが 6 ファイル生成 → 全 valid → 3 本 run
      passed、klaus.config.yaml オーバーレイの確認(`-e` なしの素の table コマンドが通ることと、
      `--env development` の明示指定が接続エラーで失敗すること)が OK になり、集約 exit code が
      0 になる
- [ ] `make exec` → 常駐 klaus コンテナの `/work/examples` に bash で入る(`cd` 不要)
- [ ] コンテナ内で 2〜4 章の table を**そのまま**(`-e` を付けずに)実行できる。config オーバーレイ
      (`verify/README.md` 参照)によりコンテナ内では `run.env: docker` が既定になっているため
      (`environments/docker.yaml` を使い、`baseUrl` / `wsUrl` がコンテナ間名前解決の `mock-api` を
      指す)、mock-server の手動起動も `-e docker` の読み替えも不要
- [ ] `make verify-down` → コンテナ・ネットワークを片付ける

補足:

- 履歴はマウント経由でホスト側 `examples/.klaus/history/` に書かれるが、`.klaus/` は gitignore 済みのため
  `git status` は汚れない。
- `make verify` が実行する `klaus generate` の出力先はコンテナ内 `/tmp/generated`(examples/ マウント外)
  のため、ホスト側 `examples/generated/` に残骸は残らない。
- フロー・環境ファイル・mock-server は `examples/` をマウントで共有しているだけで、`verify/` 配下に
  複製は無い(config だけ `verify/docker/klaus.config.yaml` をオーバーレイしている。詳細は
  `verify/README.md`)。

## 7. 片付け

- [ ] mock-server.mjs を停止する(フォアグラウンドは Ctrl+C、バックグラウンドは `kill %1` 等)。コンテナは `exit` で抜けて `make verify-down`
- [ ] `examples/generated/` を削除する(4 章をホストで手動実行した場合のみ)
- [ ] `tmp/bad-assert-check.yaml` と `tmp/klaus-report.xml` を削除する(`tmp/` は gitignore 済み)
