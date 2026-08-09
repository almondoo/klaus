# klaus 動作確認手順書

実装一式(CLI / core / localhost UI)を手元で確認するための手順。上から順に実行する。

## 1. ビルドとテスト(自動検証)

```bash
pnpm install
pnpm lint          # biome — エラー0
pnpm typecheck     # tsc — エラー0
pnpm test          # root: 16ファイル118テスト全pass
pnpm --filter @almondoo/klaus-ui test   # ui: 10テスト全pass
pnpm build:all     # dist/ に index.js / cli.js / server.js / ui/ が揃う
ls dist dist/ui    # 確認
```

## 2. CLI の確認(テスト用 API サーバーを使用)

### 2-1. ダミー API を起動(別ターミナル推奨)

```bash
cat > tmp/demo-server.mjs <<'EOF'
import { createServer } from "node:http";
createServer((req, res) => {
  if (req.url === "/login") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ token: "demo-token" }));
  } else if (req.url === "/me") {
    const ok = req.headers.authorization === "Bearer demo-token";
    res.statusCode = ok ? 200 : 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(ok ? { email: "test@example.com" } : { error: "unauthorized" }));
  } else { res.statusCode = 404; res.end(); }
}).listen(3000, "127.0.0.1", () => console.log("demo API on :3000"));
EOF
node tmp/demo-server.mjs
```

### 2-2. フローと環境ファイルを作成

```bash
mkdir -p api environments
cat > environments/local.yaml <<'EOF'
baseUrl: http://127.0.0.1:3000
testEmail: test@example.com
EOF
cat > api/auth-flow.yaml <<'EOF'
name: 認証フロー
env: local
steps:
  - name: login
    request:
      method: POST
      url: "{{baseUrl}}/login"
    capture:
      token: "$.token"
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
        Authorization: "Bearer {{token}}"
    assert:
      status: 200
      body:
        - path: "$.email"
          equals: "{{testEmail}}"
EOF
```

### 2-3. 実行して各挙動を確認

```bash
node dist/cli.js run api/auth-flow.yaml            # PASS×2 + サマリー、exit 0(echo $? で確認)
node dist/cli.js run api/auth-flow.yaml | head     # パイプ経由だと JSON になる(TTY 自動判定)
node dist/cli.js run api/auth-flow.yaml --report junit && cat klaus-report.xml   # JUnit XML 生成
cat .klaus/history/*.jsonl                          # v:1 の行が1ステップ1行で追記されている
```

### 2-4. exit code 体系の確認

それぞれ実行後に `echo $?` で確認する。

| 操作 | 期待 exit code |
|---|---|
| 上記の成功実行 | 0 |
| `assert.status` を 999 に変えて実行 | 4(アサーション失敗) |
| demo サーバーを止めて実行 | 3(実行時エラー) |
| YAML を壊して(例: `steps: [`)実行 | 2(パースエラー) |

## 3. localhost UI の確認

```bash
node dist/cli.js ui        # トークン付き URL が表示されブラウザが開く
```

チェック項目:

- [ ] フロー一覧に「認証フロー」が表示される
- [ ] 実行ボタン → ステップがライブで PASS になり「Step 2 / 2」が表示される
- [ ] 履歴タブに実行が run 単位で表示され、行クリックで詳細展開できる
- [ ] `?token=` なしの `http://127.0.0.1:<port>/` をシークレットウィンドウで開くと案内画面になる(認証が効いている)
- [ ] 実行中にブラウザを閉じても `.klaus/history/` に全ステップ分が書かれる(切断耐性)

## 4. SSE / WebSocket / GraphQL

対向サーバーが必要なため、簡易には自動テストが同じ経路を検証済み:

```bash
pnpm exec vitest run tests/sse.test.ts tests/ws.test.ts tests/graphql.test.ts
```

手動で確認したい場合は `docs/guide/flow-definition.md` の各セクションの YAML 例を使う。

## 4.5. Docker での publish 相当検証

上記 1〜4 は手元の pnpm ワークスペース上での確認であり、`pnpm exec` 経由の実行や
リポジトリの `node_modules` が前提になっている。しかし npm publish で実際にユーザーへ
届く内容(`npm pack` の `files` 選定結果)や `bin` 配線、依存バンドル漏れ(コンテナには
`dependencies` の zod しか入らず、tsup でバンドルしたはずの他 6 依存が本当に
`dist/*.js` に含まれているか)は、クリーンな Node 環境に tarball を
`npm install -g` して初めて検証できる。これを自動化したものが `verify/docker/` 一式。

- 目的:
  - files 指定の過不足(`.map` 等の除外漏れ・必須ファイルの欠落)を tarball ベースで確認する
  - `bin.klaus` の配線(`npm install -g` 後に `klaus` コマンドとして解決されるか)を確認する
  - バンドル漏れ(zod 以外の実行時依存が `node_modules` に現れず、`dist/*.js` 単体で動くか)を確認する
  - engines で指定した Node 22 系のクリーンな環境で実際に動くかを確認する

- 実行方法:

  ```bash
  make verify        # 構築 + 検証フロー実行(コンテナは起動したまま残る)
  make exec          # 常駐 klaus コンテナに bash で入り、klaus を自由に実行する
  make verify-down   # コンテナ・ネットワークの片付け
  ```

  `make verify` は内部(`verify/docker/run.sh`)で `pnpm build:all` → tarball 生成 →
  `docker compose build`(demo-api / klaus の 2 イメージ)→ demo-api / klaus 起動 →
  `klaus run flows/auth-flow.yaml` 実行 → exit code 表示、まで一気通貫で行う。
  demo API・フロー定義は上記 2-1/2-2 の認証フローと同内容(baseUrl のみコンテナ間
  名前解決の `http://demo-api:3000`)。

- 期待結果: 「認証フロー」が PASS×2 で `status: "passed"`、
  `== klaus run exit code: 0 ==` と表示される。Docker デーモンが利用できない環境では
  `docker compose build` の時点で失敗するため、事前に `docker version` で確認しておく。

## 5. 片付け

```bash
# demo サーバーを Ctrl+C で停止した後
rm tmp/demo-server.mjs klaus-report.xml
rm -r api environments .klaus     # 検証用に作ったもの(不要なら)
```
