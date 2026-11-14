# 実装計画: エージェント時代の API 検証基盤への拡張

作成日: 2026-11-15

## 目的

klaus を「エージェントに API を叩かせても安全で、証跡が残り、探索がそのまま回帰テストになる道具」にする。
競合調査で、送信先の制限・保護環境のロック・CLI でのスナップショット承認・OpenAPI カバレッジ・録画からのモックは、
どの競合も文書化された形では提供していないと確認した。

## 範囲と前提

- 5 段階すべてを順に実装する。
- ライセンス変更、フローファイルの命名規約、式言語(CEL)の導入は今回の範囲外。
- 既存の YAML・CLI・履歴との後方互換を保つ。新しい設定はすべて未指定時に現状と同じ挙動になる。
- 任意 JS のスクリプト実行、gRPC、負荷テスト、VS Code 拡張、クラウド同期は引き続き実装しない。
- 既存の非目標のうち、次は本計画で撤回する(`docs/dev/requirements.md` と `docs/dev/ui-design.md` を各段階で更新する)。
  - 「HTTP 層を再実装しない(TLS・リダイレクトは undici 任せ)」→ 実行単位の HTTP クライアントを導入する。
  - 「モックサーバーは当面実装しない」→ cassette からのモックを実装する。
  - 「UI からのフロー編集は対象外」→ 履歴からフローを新規保存する操作に限って許可する(既存フローの編集は引き続き対象外)。
  - 「record/replay は SSE/WS 非対応」→ 段階 4 で再検討する(本計画では必須としない)。

## 進め方

- 段階ごと、さらにその中の機能単位ごとに「設計確認 → 実装 → レビュー → 検証」を行う。
  段階 2 以降の詳細設計は、着手時にこのファイルへ追記して承認を得る。
- 検証は `docs/dev/verification.md` に従う。CLI 出力・UI に触れる単位は実動スモークまで行う。
- 機能単位ごとに `feat:` コミットと minor バンプを行う。コミットは指示を受けてから行う。
- ドキュメントは ja/en 両方を同じ単位で更新する。

## 段階の一覧

| 段階 | 機能単位 | 主な変更箇所 |
|---|---|---|
| 1. 安全柵 | 1-1 送信先ホストの許可リスト / 1-2 保護環境の読み取り専用モード / 1-3 保護環境への UI 書き込み拒否 / 1-4 履歴の監査項目 / 1-5 `--dry-run` / 1-6 `klaus req` | core(runner, schema, env, history)、cli、server |
| 2. HTTP 層 | 2-1 実行単位の HTTP クライアント(リダイレクト・proxy・TLS)/ 2-2 cookie jar / 2-3 認証ヘルパー(basic, bearer, OAuth2 client credentials)/ 2-4 form・multipart ボディ / 2-5 ヘッダー・cookie の capture、数値比較とステータス範囲のアサーション | core(http, runner, schema, assert) |
| 3. 証跡と資産化 | 3-1 スナップショット検証と `--update-snapshots` / 3-2 `klaus diff` / 3-3 `klaus promote` / 3-4 UI の差分表示・スナップショット承認・履歴からのフロー保存 / 3-5 UI のライブ更新 | core、cli、server、ui |
| 4. 仕様突合とモック | 4-1 `--openapi` による応答の自動照合 / 4-2 OpenAPI カバレッジ報告 / 4-3 `klaus mock`(cassette からのモック) | core、cli |
| 5. 配布とレポート | 5-1 HTML レポート / 5-2 GitHub 向け Markdown サマリーと注釈 / 5-3 Docker イメージ / 5-4 GitHub Action / 5-5 changelog の欠落補完と比較ページ | cli(reporters)、リポジトリ直下、docs |

段階 5 の 5-3、5-4 は公開物(レジストリ、Marketplace)を伴うため、ファイルの追加までを行い、公開操作は別途確認する。

## 段階 1 の設計

### 共通の決定

- 安全柵の判定は core に置く。CLI・UI・ライブラリ API のどの経路でも同じ判定を通すためである。
- core は設定ファイルを読まない(依存方向を保つ)。CLI と server が `klaus.config.yaml` を読み、`RunFlowOptions` / `ExecuteSingleRequestOptions` の新しい `guard` として渡す。
- 拒否は既存の保護環境拒否と同じ扱いにする: ステップは `error`、終了コード 3。

### 1-1 送信先ホストの許可リスト

- `klaus.config.yaml` に `guard.allowedHosts: string[]` を追加する。未指定なら制限なし。
- 要素はホスト名の完全一致、または先頭 `*.` のワイルドカード。ポート指定(`host:port`)も受け付ける。
- 判定箇所は HTTP・SSE・WebSocket・単発リクエストの送信直前。テンプレート展開後の URL で判定する。
- CLI フラグでの上書きは設けない。設定ファイルは所有者チェック済みのため、エージェントが引数で外せないことを優先する。
- `--replay` 時は実送信がないため判定しない。

採用しなかった案: 環境ファイルごとに `$allowedHosts` を持たせる案。環境単位で細かく絞れるが、環境ファイルは UI から書き換えられるため、柵そのものを UI 経由で緩められてしまう。

### 1-2 保護環境の読み取り専用モード

- 環境ファイルの `$protected` に `readonly` を追加する(`true | "readonly"`)。
- `readonly` では GET / HEAD / OPTIONS のみ `--allow-protected` なしで送信できる。それ以外のメソッドと WebSocket は従来どおり拒否する。
- `true` の挙動は変えない。単発リクエストも `readonly` の環境では安全なメソッドに限り許可する。

### 1-3 保護環境への UI 書き込み拒否

- `PUT /api/environments/:name` と `POST /api/environments/:name/capture` は、対象が保護環境なら 403 を返す。
- 挙動の変更になる。保護環境の値はファイルを直接編集する運用とし、ドキュメントに明記する。

### 1-4 履歴の監査項目

- 履歴エントリに任意項目を追加する: `env`(環境名)、`file`(cwd からの相対パス)、`actor`(`{ kind: "human" | "agent" | "ci", name? }`)、`git`(`{ commit, dirty }`)。
- `actor` は CLI が環境変数から推定する(`CI`、`CLAUDECODE` など)。`--actor <name>` で明示できる。UI 起点の実行は `human`。
- `git` は CLI が `git rev-parse` を短いタイムアウトで実行して取得し、失敗時は項目を省く。
- 既存エントリとの互換を保つため、すべて省略可能とし履歴のバージョンは上げない。`klaus history` の一覧と `--fields` で参照できるようにする。

### 1-5 `--dry-run`

- `klaus run --dry-run` は送信せず、各ステップの展開後リクエスト(メソッド、URL、ヘッダー、ボディ)を出力する。
- 前段の capture に依存する変数は未解決のまま `{{name}}` として表示し、未解決であることを明示する。
- 許可リストと保護環境の判定は実行時と同じように行い、拒否されるステップを事前に確認できるようにする。
- 履歴には書かない。終了コードは、拒否されるステップがあれば 3、なければ 0。

### 1-6 `klaus req`

- `klaus req <method> <url>` を追加する。コアの `executeSingleRequest` を CLI から呼ぶ。
- オプション: `-H, --header <k:v>`(複数可)、`--query <k=v>`(複数可)、`--body <json>` または `--body @<file>`、`-e, --env`、`--env-file`、`--var`、`--no-history`、`--no-mask`、`--json` / `--text`。
- 出力は `run` のステップと同じ形(非 TTY では JSON、ボディは 500 文字で切り詰め、`historyRef` つき)。履歴には `source: "single"` で残る。
- 終了コードは `run` と同じ規約(送信エラーは 3)。アサーションは持たない。
- Agent Skill と `AGENTS.md` テンプレートに「curl の代わりに `klaus req` を使う」と追記する。

### 段階 1 のテスト

- core: 許可リストの一致規則、読み取り専用モードのメソッド判定、dry-run の展開結果、履歴の新項目(`tests/` の該当モジュール)。
- server: 保護環境への PUT / capture の 403、UI 起点の実行にも許可リストが効くこと(`tests/server/server.test.ts`)。
- cli: `req` と `--dry-run` のユニットテスト、および exit code と JSON 形状の統合テスト(`tests/cli/integration.test.ts`)。
- 実動スモーク: ローカル fixture に対して `req` → `history` → 許可リストによる拒否 → `--dry-run` を確認する。
