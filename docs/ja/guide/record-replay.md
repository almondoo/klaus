# record / replay モード

`klaus run` に `--record <dir>` または `--replay <dir>` を渡すと、HTTP リクエスト/レスポンスをファイル(カセット)経由でやり取りするモードになる。ネットワークが遮断されたサンドボックス内での検証や、破壊的な API(決済・送信系など)を毎回実際には叩かずに検証したい場合に使う。

- **record モード(`--record <dir>`)**: 実際にリクエストを送信しつつ、レスポンスを secrets でマスクしたうえで `<dir>` のカセットファイルに追記する。
- **replay モード(`--replay <dir>`)**: ネットワークへは一切出ず、`<dir>` のカセットから応答を再生する。

`--record` と `--replay` は同時指定できない(両方指定すると stderr にメッセージを出して exit code 1 になり、何も実行されない)。

## カセット形式

カセットは `<dir>/cassette.jsonl`(単一ファイルの JSON Lines)に固定される。1行 = 1リクエスト分のレスポンスで、スキーマは次のとおり(`v: 1`)。

```jsonc
{
  "v": 1,
  "method": "GET",              // 大文字化した HTTP メソッド
  "url": "http://…",            // レンダリング済み URL(マスク済み)
  "status": 200,
  "headers": { … },
  "bodyText": "…"                // レスポンス本文の生テキスト
}
```

- `url` は record 時点で secrets によりマスクされたうえで保存されるため、平文のシークレットはカセットファイルに残らない。マスク規則は[実行履歴](history.md)や `--report junit` と同じ(<code v-pre>{{env.X}}</code> で解決した値と、その URL エンコード形・form-urlencoded 形・JSON エスケープ形が対象)。
- `bodyText` も同様にマスクしてから保存する。
- `headers`(レスポンスヘッダー)も含め、エントリ全体に同じマスク処理(maskDeep)を適用するため、レスポンスヘッダーに含まれるシークレットも同様にマスクされる。
- replay 時は `bodyText` の Content-Type が `application/json` を含む場合のみ JSON としてパースし直す(それ以外はテキストのまま返す)。パースに失敗した場合もテキストのままフォールバックする。

## マッチング規則

replay 時は、実行中のステップの **method + マスク済み URL の完全一致** で、カセット中のエントリを検索する。

- record と replay は**同じ env / secrets** で行うことを前提にしている(URL のマスクは実行時に判明している secrets を使ってから比較するため、record と replay で解決される secrets が異なると一致しなくなる)。
- カセットに同一キー(method + URL)の行が複数あっても、**先に記録された行**が採用される。同じキーへの複数回のリクエストは常に同じ応答を返す(非消費型。呼び出し順で使い切られたりはしない)。
- カセットに一致するエントリが無いリクエストは、明確なエラーとしてステップが `error` になり、CLI の exit code は **3** になる。エラーメッセージには一致しなかったキー(マスク済み)と、`--record <dir>` で再記録する案内が含まれる。
- `--replay` 指定時にカセットファイル自体が読み込めない(存在しない・壊れている等)場合も、実際に最初の HTTP ステップが実行されたタイミングで同じ exit code 3 のエラーになる。

## SSE / WebSocket ステップは非対応

`--record` / `--replay` 指定時、SSE(Accept: text/event-stream または `sse` ブロックを持つステップ)や WebSocket(`ws` ブロックを持つステップ)が含まれるフローを実行すると、そのステップは明示的な `error` になる。黙って実ネットワークへ素通しすることはない。record/replay の対象は HTTP ステップのみ(GraphQL over HTTP を含む)。

## 実行履歴・その他出力への影響

record/replay モードでも、`.klaus/history/*.jsonl` への書き込みは(`--no-history` を付けない限り)従来どおり行われる。stdout の text/JSON 出力、`--report junit`、secrets のマスキング(`--no-mask`)といった他のオプションの挙動もモードの有無に関わらず変わらない。

## ユースケース

- **ネットワークを遮断したサンドボックスでの検証**: CI やエージェント実行環境がネットワークにアクセスできない場合でも、事前にローカルや別環境で record したカセットを使って `--replay` すれば、リクエスト/アサーションのロジックを検証できる。
- **破壊的な API の再実行防止**: 決済・メール送信・リソース削除など、実行のたびに副作用を伴う API を検証したい場合、一度だけ record し、以降は `--replay` で同じ応答を使い回すことで、副作用を伴う呼び出しを最小限に抑えられる。

## 使用例

```bash
# 1. 実際にリクエストを送りながらカセットを記録する
klaus run api/create-user.yaml --record ./cassettes

# 2. 以降はネットワークに出ずに同じ検証を再生する
klaus run api/create-user.yaml --replay ./cassettes
```
