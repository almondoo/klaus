# 類似ツール調査 — klaus に追加すべき機能(要約)

調査日: 2026-08-20。klaus と同領域の API テスト/フロー実行ツール 15 種を 5 観点の Web 調査で比較した。候補機能 14 件それぞれに 3 票の敵対的検証(klaus に既存でないか / 出典が正確か / 設計スコープに適合するか)を行っている。詳細は [similar-tools-research.html](./similar-tools-research.html) を参照。

## 結論

まず着手すべきは次の 3 件。いずれも実装コスト S で、既存の runner・変数解決・ステータスモデルにほぼそのまま乗る。

1. **ステップの retry / poll-until-pass** — 非同期反映を待つ eventually-consistent な API の検証が現状表現不能。主要競合ほぼ全てが保有(Hurl / Step CI / runn ほか)
2. **`--var` / `--env-file` によるアドホック変数注入** — CI からのシークレット注入・一時的な値差し替えがワンライナーで完結する(Bruno CLI / venom)
3. **`continueOnError`(失敗後も続行)** — 独立エンドポイントの一括スモークで全体サマリーを取れるようになる(scenarigo)

## 推奨機能一覧

| 機能 | 優先度 | コスト | 持つツール例 |
|---|---|---|---|
| ステップの retry / poll-until-pass | 高 | S | Hurl, Step CI, runn, venom, Karate |
| `--var` / `--env-file` 変数注入 | 高 | S | Bruno CLI, venom |
| `continueOnError` | 高 | S | scenarigo |
| 条件付きステップ実行(`if:` 式) | 中 | M | runn |
| CSV/JSON データ駆動実行 | 中 | M | Newman, Insomnia, Bruno, Karate |
| タグによる選択実行 | 中 | S | Bruno CLI |
| フローファイル横断の並列実行 | 中 | M | Hurl, venom, Karate |
| レポーター拡張(TAP/HTML・複数同時出力) | 中 | M | Newman, Hurl |
| モックサーバー | 低 | L | Karate, Postman |
| OAuth2 トークンフローヘルパー | 低 | L | httpYac |
| OpenAPI スキーマ駆動ファズ/適合性テスト | 低 | L | Schemathesis, Dredd |
| DB ステップランナー | 低 | L | runn, venom |
| ネイティブ gRPC ステップ | 低 | L | scenarigo, runn |
| スクリプティングフック(pre/post) | 低 | L | Bruno, Postman ほか |

## 見送り・保留(検証で反対票が付いたもの)

- **ネイティブ gRPC ステップ**: docs/dev/requirements.md が「任意(当面実装しない)」と明記済みの意図的スコープ外。採用には要求定義の見直しが先
- **スクリプティングフック**: JS サンドボックス導入は宣言的・軽依存・セキュリティ重視の設計と衝突し攻撃面を広げる。retry / if / continueOnError の拡充で大半のユースケースが埋まる見込み
- **レポート形式追加**: 「レポーターが JUnit のみ」という前提が不正確(text/JUnit は既存)。新機能ではなく既存レポーター基盤の拡張として扱う
