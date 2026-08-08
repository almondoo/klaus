# CLI リファレンス

klaus のコマンドは `init`(雛形生成)・`run`(フロー実行)・`ui`(localhost Web UI 起動)の3つ。

## klaus init

```
klaus init
```

オプションはない。カレントディレクトリに最小構成を生成する。

| 生成されるファイル | 内容 |
|---|---|
| `flows/example.yaml` | `https://example.com` への GET 1件、ステータス200のアサーション(日本語コメント付き) |
| `environments/local.yaml` | `baseUrl` を持つ最小の環境ファイル |

既存ファイルは上書きせずスキップし、その旨を stdout に表示する。必要なディレクトリは自動で作成される。常に exit 0。1件以上生成した場合、最後に次のコマンドのヒントを表示する: `klaus run flows/example.yaml -e local`

## klaus run

```
klaus run <files...> [options]
```

複数ファイルを渡すと順次実行する(glob 展開はシェルに任せる)。

| オプション | 説明 | デフォルト |
|---|---|---|
| `--env <name>` | フロー定義の `env:` 指定を上書き | フローの `env:` |
| `--json` | TTY でも JSON 出力を強制 | — |
| `--report junit` | JUnit XML レポートを生成 | — |
| `--report-file <path>` | レポートの出力先 | `klaus-report.xml` |
| `--no-history` | 履歴 JSONL への書き込みを無効化 | 履歴有効 |

`--report` に `junit` 以外の値を渡すと stderr にエラーを出して exit 1。

## 出力モード

- **自動判定**: stdout が TTY なら text、非 TTY(パイプ / エージェント実行 / CI)なら JSON。`--json` で TTY でも JSON を強制できる
- **結果データは stdout、診断メッセージ(パースエラー・警告)は stderr** に分離される

### text 出力(人間向け)

ステップ完了ごとにインクリメンタルに出力される。成功は1行要約のみ、失敗時だけ詳細を出す(フル詳細は履歴 JSONL 側に残る)。

```
認証フロー (/path/to/auth-flow.yaml)
  PASS login (200, 6ms)
  FAIL get-me (200, 3ms)
    body $.email: expected "a@example.com" but got "b@example.com"
  SKIP logout (前ステップの失敗によりスキップ)

1 flow, 3 steps: 1 passed, 1 failed, 1 skipped (12ms)
```

- 行種別: `PASS` / `FAIL`(失敗アサーションの expected/actual、レスポンスボディは約500文字で切り詰め)/ `SKIP`(理由付き)/ `ERROR`(runtime エラーのメッセージ)
- TTY では ANSI 色付き(pass=緑 / fail=赤 / skip=黄)。非 TTY・`--json` 時は色なし

### JSON 出力(機械向け)

実行完了後に1個の JSON(2スペース pretty print)を stdout に出力する。逐次出力はしない。

```jsonc
{
  "version": 1,          // 出力スキーマのバージョン
  "runId": "<uuid>",
  "startedAt": "2026-08-08T…",
  "durationMs": 123,
  "status": "passed",    // "passed" | "failed" | "error"
  "flows": [
    {
      "name": "認証フロー",
      "file": "…",
      "status": "passed",
      "durationMs": 120,
      "steps": [
        {
          "name": "login",
          "status": "passed",   // "passed" | "failed" | "skipped" | "error"
          "durationMs": 6,
          "request": { "method": "POST", "url": "…", "headers": {}, "body": {} },
          "response": { "status": 200, "headers": {}, "body": {} },
          "assertions": [ { "ok": true, "kind": "status", "expected": 200, "actual": 200, "message": "…" } ]
        }
      ]
    }
  ]
}
```

SSE / WebSocket ステップでは `response.body` は undefined になり、受信データは `events`(SSE)/ `wsMessages`(WS)フィールドに入る。

### JUnit レポート

`--report junit` で flow = `<testsuite>`、step = `<testcase>` の XML を `--report-file` に書き出す。stdout の text / JSON 出力とは独立して併用できる。特殊文字は XML エスケープされる。

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
klaus ui [-p <n>] [--no-open]
```

| オプション | 説明 | デフォルト |
|---|---|---|
| `-p`, `--port <n>` | 待ち受けポート | 空きポート自動選択 |
| `--no-open` | ブラウザの自動起動を抑止 | 自動起動する |

起動するとトークン付き URL(`http://127.0.0.1:<port>/?token=…`)を stdout に表示し、デフォルトブラウザで開く。Ctrl+C で終了。サーバーの機能・セキュリティモデル・HTTP API は [localhost UI](ui.md) を参照。
