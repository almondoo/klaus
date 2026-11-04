# 履歴ファイルの日付を startedAt 基準にする

## 背景(未対応だった 2 点)

1. 時計が 24 時間以上巻き戻ると、`getHistoryPage` の早期打ち切りでエントリがページングから漏れる。
2. JSON レポートの `historyRef.date` は startedAt の UTC 日付だが、実際の保存先は追記時刻の UTC 日付。UTC 0 時をまたぐステップで 1 日ずれる。

根本原因は共通で、`appendHistory`(src/core/history.ts)が保存先ファイルを「追記時刻」で決めていること。ファイル日付と startedAt の関係が時計に依存するため、読み手側(history-query.ts の上限、json.ts の historyRef)がそれぞれ別の前提を置いている。

## 調査結果

- 書き込み元は 2 か所(runner.ts の flow 用 sink と single request)。全エントリが必須の ISO 文字列 `startedAt` を持つ(`HistoryEntry` 型で必須)。
- 日付でファイルを探す利用箇所はない。`klaus history` / `show`、`GET /api/history`、UI は全ファイルを走査する。`historyRef.date` は情報表示のみ。
- ドキュメント(docs/guide/history.md:9 と ja 版)は「日付はローカル日付」と書いているが、実装は UTC で、現状すでに不正確。

## 案

### 案 A: 保存先を startedAt の UTC 日付で決める(推奨)

- `appendHistory` が `historyFilePath(cwd, new Date(entry.startedAt))` に追記する。
- ファイル D には startedAt が [D, D+1) のエントリだけが入る。時計の状態によらず構造的に成り立つため、1 と 2 が同時に解消する(`historyRef.date` は変更不要で正しくなる)。
- 早期打ち切りの上限は「ファイル日付 + 2 日」を維持する。旧仕様で書かれた既存ファイル(追記時刻基準)にも 24 時間未満のずれまでは安全なため。新仕様のファイルだけなら +1 日で足りるが、1 ファイル分の読み込みを節約するより既存データの安全を優先する。
- 変更範囲: history.ts(appendHistory と不変条件コメント)、tests/history.test.ts(固定 startedAt を使うテストの読み先)、midnight をまたぐケースのテスト追加、docs の history.md(ja/en)の日付説明を「startedAt の UTC 日付」に修正。
- 影響: UTC 0 時をまたぐエントリが前日のファイルに入るようになる。コードの利用者はいない。手で `cat` する人から見た保存先だけが変わる。
- 残るリスク: 旧仕様で書かれ、24 時間以上の巻き戻りを含む既存ファイル。発生はほぼ考えられず、新規データには起きない。

### 案 B: 読み手を追記時刻に合わせる

- `historyRef.date` を実際の追記日付にする(runner から保存先日付を StepResult に渡す必要がある)。
- 1 は解消しない。時計の巻き戻りに対しては上限の余裕を広げるしかなく、完全にはならない。
- 公開型(StepResult)への追加が必要で、変更範囲が A より大きい。

### 案 C: 早期打ち切りをやめ、全件読み込みに戻す

- 1 は完全に解消するが、今回のパフォーマンス改善を失う。2 は別途対応が必要。

## 推奨

案 A。1 行の書き込み先変更で 2 つの不具合の根本原因を同時に取り除け、公開 API の変更もない。
