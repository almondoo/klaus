# 実行履歴

klaus は全リクエスト / レスポンス / 所要時間をローカルの JSONL に追記する。CLI の text 出力が成功時1行要約に留まるのは、フル詳細をこちらに逃がしているため。localhost UI の履歴ブラウザもこのファイルを読む。

ブラウザ UI を使わずに CLI から直接参照したい場合は `klaus history`(一覧)/ `klaus history show <runId>`(詳細)を使う。オプションの詳細は [CLI リファレンス](cli.md#klaus-history) を参照。

## ファイル規則

- パス: `.klaus/history/<YYYY-MM-DD>.jsonl`(**cwd 基準**、日付はローカル日付)
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
  "status": "passed",           // "passed" | "failed" | "skipped"(旧エントリには無い場合がある。運用上の注意を参照)
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
  ]
}
```

### ステップ種別ごとの内容

| 種別 | request | response | events |
|---|---|---|---|
| HTTP / GraphQL | method / url / headers / body | status / headers / body | — |
| SSE | 通常どおり | status / headers、**body は undefined** | 受信イベント一覧(`{event?, id?, data}`) |
| WebSocket | method は `"WS"`、body は送信メッセージ配列 | status は `101` 固定、body は受信メッセージ(data 文字列)の配列 | — |
| skipped | 省略 | 省略 | — |

**skipped ステップも記録される**(`status: "skipped"`、request/response なし、assertions は空)。runtime エラーになったステップはエラー内容とともに記録される。

新規に書き込まれるエントリには常に `status` が設定される。`status` フィールドが無い旧エントリは、従来どおり `assertions` の内容から成否を導出して読み込める(後方互換)。

## バージョニング契約

履歴 JSONL は localhost UI(および将来のツール)が読む**契約**であり、以下のルールで進化する:

- `v` を変えない変更は**フィールド追加のみ**(additive)。既存フィールドの削除・意味変更・型変更はバージョンを上げる
- 読み手は未知のフィールドを無視し、未知の `v` の行はスキップする

## 運用上の注意

- **テンプレート解決済みの値が記録される**。ただし <code v-pre>{{env.X}}</code> で OS 環境変数から解決した値(長さ 4 文字以上)は、書き込み直前に request の url/headers/body・response の headers/body・assertions(expected/actual/message)・events(event/id/data)内で `***` にマスクされる。マスクは生の値だけでなく、その URL エンコード形(パーセントエンコード、および `URLSearchParams` が空白を `+` にする form-urlencoded 形)にも及ぶため、`request.query` に置いたシークレットもエンコード後の姿で記録されずに済む。マスクされるのはこの経路で解決した値のみで、`environments/*.yaml` 由来の値やライブ実行結果(実行中 UI・StepResult)はマスク対象外。詳細は [SECURITY.md](https://github.com/almondoo/klaus/blob/main/SECURITY.md) を参照
- マスクされない値(4文字未満のシークレットや environments ファイル由来の値など)を扱うプロジェクトでは、引き続き `.klaus/` を `.gitignore` に入れること(このリポジトリの scaffolding では最初から ignore 済み)
- テキストファイルなので、あえて git 管理して実行記録をチームで共有する運用も可能(マスクされない値が含まれないことを確認したうえで)
