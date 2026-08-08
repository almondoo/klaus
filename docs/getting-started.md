# klaus 入門

> [!summary] この文書の役割
> klaus を初めて使う人向けのチュートリアル。インストールからフロー作成・実行・結果の読み方までを最短で辿る。フィールドの網羅的なリファレンスは [flow-definition](flow-definition.md) を参照。

## インストール

```bash
npm install -g @almondoo/klaus
```

`package.json` の `engines` で Node.js `>=22.19.0` が要求される(`bin` は `klaus` コマンドとして `dist/cli.js` を指す)。

## 最小のフローを作る

klaus のフロー定義は「1 YAML ファイル = 1 フロー(複数ステップの順次実行)」という構造を持つ。プロジェクトの好きな場所に YAML ファイルを置く(慣習として `api/` 配下に置くことが多いが、`klaus run` はファイルパスを直接引数に取るのでどこに置いてもよい)。

```yaml
# api/hello.yaml
name: hello フロー
steps:
  - name: get-hello
    request:
      method: GET
      url: "http://localhost:3000/hello"
    assert:
      status: 200
```

## 実行する

```bash
klaus run api/hello.yaml
```

stdout が TTY(通常のターミナル)なら人間向けのテキスト出力になる。

```
hello フロー (api/hello.yaml)
  PASS get-hello (200, 12ms)

1 flow, 1 step: 1 passed (12ms)
```

- 成功したステップは `PASS <name> (<status>, <durationMs>ms)` の1行だけが出る
- 失敗(`FAIL`)・実行時エラー(`ERROR`)のときだけ詳細(失敗したアサーションのメッセージや、エラーメッセージ)が追加で表示される
- 最後にフロー数・ステップ数・内訳(passed / failed / error / skipped)を含むサマリー行が出る

パイプに繋いだ場合やエージェント(Claude Code の Bash 実行など)から呼んだ場合、stdout は TTY ではないため自動的に JSON 出力になる(`--json` を付けても同じ形式を強制できる)。JSON の構造・exit code の詳細は [cli](cli.md) を参照。

## 変数を使ったチェーン(login → me)

実運用でよくある「ログインしてトークンを取得し、後続リクエストの Authorization ヘッダーに使う」パターン:

```yaml
# api/auth-flow.yaml
name: 認証フロー
env: local          # environments/local.yaml を参照
steps:
  - name: login
    request:
      method: POST
      url: "{{baseUrl}}/login"
      headers:
        Content-Type: application/json
      body:
        email: "{{testEmail}}"
        password: "{{env.TEST_PASSWORD}}"   # OS 環境変数の参照
    capture:
      token: "$.token"                      # JSONPath でキャプチャ
    assert:
      status: 200
      body:
        - path: "$.token"
          exists: true

  - name: get-me
    request:
      method: GET
      url: "{{baseUrl}}/me"
      headers:
        Authorization: "Bearer {{token}}"   # 前ステップのキャプチャを参照
    assert:
      status: 200
      body:
        - path: "$.email"
          equals: "{{testEmail}}"
```

## environments/ ファイルを作る

`env: local` は、klaus の実行時カレントディレクトリ(`klaus run` を実行した cwd。フローファイル自身の場所ではない)を基準に `environments/local.yaml` を探して読み込む。

```yaml
# environments/local.yaml
baseUrl: http://localhost:3000
testEmail: test@example.com
```

環境ファイルの値はすべて文字列で、テンプレート変数(`{{...}}`)として `{{baseUrl}}` のように参照できる。シークレット(パスワードなど)は環境ファイルに直書きせず、`{{env.TEST_PASSWORD}}` の形で OS 環境変数を参照する(`TEST_PASSWORD=xxx klaus run ...` のように渡す)。

`env:` を指定しない、または `environments/<name>.yaml` が存在しない場合の挙動は次の通り:

- フロー定義に `env:` が無く `--env` も指定しなければ、環境変数なし(空オブジェクト)として実行される
- `env:` または `--env` で名前を指定したのに該当ファイルが読めない場合はパースエラー(exit code 2)になる

`--env <name>` で CLI からフロー定義の `env:` を上書きできる。

## 結果の読み方

- **PASS**: そのステップは成功。ステータスコードと所要時間だけが表示される
- **FAIL**: リクエスト自体は完了したが、アサーションのいずれかが不一致。失敗したアサーションのメッセージが `expected ... but got ...` 形式で表示される
- **ERROR**: 接続不能・タイムアウト・テンプレート変数の解決失敗・JSONPath キャプチャの失敗など、リクエストを完了できなかった場合
- **SKIP**: 同じフロー内で直前のステップが FAIL または ERROR になったため、後続ステップが実行されずスキップされた場合(`skipped because a previous step failed`)

失敗の詳細(リクエスト全文・レスポンス全文)はテキスト出力には出ない。フルの詳細は `--json` 出力、または `.klaus/history/*.jsonl` の実行履歴から確認する([history](history.md) 参照)。

## 次に読むべきページ

- [cli](cli.md) — `klaus run` / `klaus ui` の全オプションと exit code 体系
- [flow-definition](flow-definition.md) — フロー定義 YAML の全フィールド(SSE / WebSocket / GraphQL / アサーション種別を含む)リファレンス
- [history](history.md) — 実行履歴 JSONL のスキーマ
- [ui](ui.md) — `klaus ui` で起動する localhost Web UI
