---
tags:
  - dev-tools/api-testing
  - documentation
  - reference
created: 2026-08-08
source:
---

# 実行履歴

klaus は全リクエスト / レスポンス / 所要時間をローカルの JSONL に追記する。CLI の text 出力が成功時1行要約に留まるのは、フル詳細をこちらに逃がしているため。localhost UI の履歴ブラウザもこのファイルを読む。

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
  "request": {
    "method": "POST",
    "url": "http://…",          // テンプレート解決済み
    "headers": { … },           // テンプレート解決済み
    "body": { … }
  },
  "response": {
    "status": 200,
    "headers": { … },
    "body": { … }               // JSON ならパース済みの値、それ以外はテキスト
  },
  "assertions": [
    { "ok": true, "kind": "status", "expected": 200, "actual": 200, "message": "…" }
  ]
}
```

### ステップ種別ごとの内容

| 種別 | request | response |
|---|---|---|
| HTTP / GraphQL | method / url / headers / body | status / headers / body |
| SSE | 通常どおり | status / headers、**body は undefined**(受信イベントは履歴に永続化されない — 既知の制限) |
| WebSocket | method は `"WS"`、body は送信メッセージ配列 | status は `101` 固定、body は受信メッセージ(data 文字列)の配列 |

**skipped ステップは記録されない**(実行されていないため)。runtime エラーになったステップはエラー内容とともに記録される。

## バージョニング契約

履歴 JSONL は localhost UI(および将来のツール)が読む**契約**であり、以下のルールで進化する:

- `v` を変えない変更は**フィールド追加のみ**(additive)。既存フィールドの削除・意味変更・型変更はバージョンを上げる
- 読み手は未知のフィールドを無視し、未知の `v` の行はスキップする

## 運用上の注意

- **テンプレート解決済みの値がそのまま記録される**。`{{env.TEST_PASSWORD}}` で参照したシークレットも解決後の生の値で残るため、シークレットを扱うプロジェクトでは `.klaus/` を `.gitignore` に入れること(このリポジトリの scaffolding では最初から ignore 済み)
- テキストファイルなので、あえて git 管理して実行記録をチームで共有する運用も可能(シークレットが含まれない場合に限る)
