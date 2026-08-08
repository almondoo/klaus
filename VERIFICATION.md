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

## 5. 片付け

```bash
# demo サーバーを Ctrl+C で停止した後
rm tmp/demo-server.mjs klaus-report.xml
rm -r api environments .klaus     # 検証用に作ったもの(不要なら)
```
