# 変更履歴

各リリースで何が変わったかと、**その背景にある判断・踏んだ落とし穴**を記録する。
API の現在の仕様は各リファレンス([CLI](../ja/guide/cli.md) / [フロー定義](../ja/guide/flow-definition.md) / [アーキテクチャ](architecture.md))が正で、ここは「なぜそうなったか」を残す場所。

0.2.0〜0.14.4 は git 履歴(`chore: vX.Y.Z` のバージョン更新コミットを境界に、直前の更新から当該コミットまでの変更をそのバージョンとして)から後追いで復元したもの。ユーザーに見える変更(feat / fix)だけを短くまとめ、内部リファクタ・テスト・依存更新の細部は省いている。

## 未リリース

バージョンは未確定(統合時に付け替える)。実装済みでまだコミットされていない機能。

### `klaus mock <dir>`

`klaus run --record <dir>` で記録したカセットを返すだけのローカル HTTP サーバーを起動する。ネットワークへは一切転送せず、未マッチは 404(`closest` に近い記録済みパスを返すが、記録済みボディは含めない)。マッチングは **メソッド + パス + クエリ**(記録時のホストは捨てる。ホストまで見る replay とはここが違う)。既定の bind は `127.0.0.1`、ポートは UI(4884)と衝突しない 4885。`--cors` / `--delay` / `--ignore-query` / `--sequence` / `--origin` / `--json` を備える。カセットが無い・不正・空なら exit 2。記録時にマスクされたシークレットは `***` のまま返し、復元しない。

### `--report html` / `--report github`

- `html`: 外部アセット・JavaScript を使わない自己完結の単一 HTML(既定 `klaus-report.html`)。失敗・エラーのステップは既定で展開する
- `github`: GitHub Actions 向け。ジョブサマリー(Markdown)を `--report-file`、なければ `GITHUB_STEP_SUMMARY` への追記、なければ `klaus-report.md` に書き、`GITHUB_ACTIONS=true` のときは失敗ステップごとに `::error` アノテーションを出す。stdout にはサマリーを書かない(`--json` の機械可読出力を壊さないため)

### `klaus diff`

履歴の2つの run をステップ単位で比較する(ステータス・ヘッダー・ボディの構造的な JSON 差分または行差分・リクエストの変化)。差分があれば **exit 4**(`run` のアサーション失敗と同じ「失敗」の意味合いで揃えた)、run が見つからない・引数不正は 2。`Date` などの揮発するヘッダーは既定で除外し、`--ignore-path` / `--ignore-header` で追加する。履歴のシークレットは `***` で保存されるため、シークレット値の変化は差分に現れない。

### `klaus promote`

履歴の run から、観測したレスポンスをもとにアサーションを推論した再実行可能なフロー YAML を生成する(`--assert status|schema|values|all`、既定は `schema`)。マスク値は復元できないため `{{env.TODO_*}}` のプレースホルダーに置き換えて一覧で示し、生成物に `***` が残る場合は書き込まない。既存ファイルは `--force` なしでは上書きせず、出力先はカレントディレクトリ配下に限る。書き込み前に生成物をスキーマ検証する。前のレスポンスの特徴的な値が後のリクエストに現れるときは `capture` として連鎖させる(`--no-chain` で無効化)。

## 0.19.0

実行単位の HTTP クライアントを追加した。

- フローの最上位 `http:` と `klaus.config.yaml` の `http:` に `followRedirects`(既定 `false`)/ `maxRedirects`(既定 10)/ `cookies`(既定 `false`)を追加。リダイレクトは core で1ホップずつ処理し、**各ホップで `guard.allowedHosts` と保護環境を再判定**する。別オリジンへ移るときは `Authorization` / `Cookie` / `Proxy-Authorization` を落とし、経由した URL を結果と履歴の `redirects` に記録する
- cookie jar はメモリ上のみで永続化しない。cookie 値はシークレットとしてマスクする。公開サフィックス一覧を持たないため、`Domain` 属性は保守的な規則で受け入れる
- `http.proxy` と `http.tls`(`ca` / `cert` / `key` / `insecure`)は通信の行き先・信頼先を決めるため、`klaus.config.yaml` でのみ指定できる。フローに書くと検証エラー(exit 2)。CLI フラグ・`klaus req` のオプション・UI パラメーターも設けていない。環境変数の proxy(`HTTP_PROXY` 等)や undici のグローバル設定は読まない
- SSE と WebSocket にも同じクライアント設定を適用する。`tls.insecure` は実行ごとに stderr へ警告を出す
- 利用者向けの `Dockerfile`(非 root)と、`klaus run` を実行してジョブサマリーを出す composite GitHub Action(`action.yml`)の定義をリポジトリに追加した。レジストリや Marketplace への公開はしていない

## 0.18.0

`klaus ui` の履歴をライブ更新するようにした。

- `GET /api/history/events`(SSE)で履歴ディレクトリの変化を通知し、UI は通知を受けて履歴を再取得する。CLI やエージェントが外から実行した結果が自動で反映され、別タブ表示中は新着バッジを出す
- 履歴一覧に実行者(`actor`)と環境(`env`)の列を追加した

## 0.17.0

`klaus run --dry-run` を追加した。

- 何も送信せずに、各ステップの展開後リクエスト(メソッド・URL・ヘッダー・ボディ)を出力する。前段の capture に依存する変数は `{{name}}` のまま残して `unresolved` に列挙し、capture でも環境でもない変数は実行時と同じエラーとして報告する
- `guard.allowedHosts` と保護環境の判定を実行時と同じ経路で行う。拒否されるステップがあれば **exit 3**、ホストが未解決なら `undetermined`。`if` 条件は評価せず `conditional` として示す
- 履歴・カセットには触れず、`--record` / `--replay` / `--report` との併用は exit 2
- `klaus schema --target dry-run-report` を追加した

## 0.16.0

`klaus req` を追加した。

- `klaus req <method> <url>` で、フローファイルなしの単発リクエストを送る。UI の `POST /api/request` と同じ経路(`executeSingleRequest`)を通るため、安全柵・シークレットマスク・履歴記録が `run` と同じように効く。エージェントが探索で `curl` を使うと安全柵を迂回してしまうので、その代わりに使う想定
- 出力は `run` と同じ規約(非 TTY は JSON、ボディは 500 文字で切り詰め、`historyRef` つき)。exit code は、応答を受け取れば 0(HTTP ステータスは問わない。アサーションがないため)、送信エラーと安全柵の拒否で 3、不正な入力で 2。`--allow-protected` は意図的に設けていない
- `--body @<file>` はカレントディレクトリ配下のファイルに限る
- `klaus schema --target req-report` を追加した

## 0.15.0

安全柵(guardrails)を追加した。人間だけでなくエージェントも klaus を使う前提で、誤った送信先・保護すべき環境への書き込みを機械的に止めるための仕組み。

### 送信先ホストの許可リスト(`guard.allowedHosts`)

`klaus.config.yaml` の `guard.allowedHosts` に列挙したホスト以外への送信を拒否する。拒否されたステップは `error` で終わり、run は exit code 3 になる。**CLI フラグでの上書きは意図的に設けていない**(エージェントが自分に課された制限を呼び出し時に外せてしまうため)。未設定なら従来どおり制限なし。

### 保護環境の読み取り専用モード(`$protected: readonly`)

環境ファイルの `$protected: readonly` で `GET` / `HEAD` / `OPTIONS` のみを許可する(それ以外のメソッドと WebSocket ステップは拒否)。メソッドオーバーライド系ヘッダ(`X-HTTP-Method-Override` など)を持つ読み取り系リクエストも拒否する。`--allow-protected` で解除できる。

### 挙動変更: UI からの保護環境への書き込みを 403 で拒否

保護環境(`$protected: true` / `readonly`)に対する `klaus ui` からの書き込み(環境の `PUT`、capture による保存)を **403 で拒否する**ようにした。UI 経由で保護環境の値を書き換えていた場合は、環境ファイルを直接編集すること。

### 履歴の監査項目と拒否の記録

履歴エントリに `env` / `file` / `actor`(`kind` は `human` / `agent` / `ci` を環境変数から判定)/ `git` を記録する。安全柵に拒否されたステップも、実際には送信していない(マスク済みの)リクエストと拒否理由つきで履歴に残す。`klaus history --fields env,file,actor,git` で参照できる。

### `run --actor <name>`

履歴の `actor.name` を指定するオプション。`actor.kind` は従来どおり環境から判定される。

## 0.14.4

開発環境の Node 26 / pnpm 12 への移行と依存の一括更新が中心。実行時の挙動が変わるのは次の JSONPath エンジンの更新のみ。

### JSONPath エンジン(jsonpath-plus)を v11 へ更新

jsonpath-plus を v10.4.0 から v11.2.2 に更新した。上流のバグ修正を含むため、**capture / assert で使う一部のまれな JSONPath 式の結果が変わる**。10.4.0 と 11.2.2 の差分テストで確認した変化は次のとおり。

| 式 | 更新前 | 更新後 |
|---|---|---|
| `$.data['a,b']`(カンマを含むキー) | 値そのもの | `[値]`(配列) |
| `$.data['a','b']` | `undefined` | 両方の値の配列 |
| `$.data.list[0:0]` | 配列全体 | `undefined` |
| `$.list[?(@.id ?? 0)]`(フィルタ内の `??`) | 例外 | 動作する |

`$.a.b` / `$['k']` / フィルタ / `..` / `*` / `.length` といった一般的な書き方の結果は変わらない。カンマを含むキーやスライス `[0:0]` を使っている場合だけ、capture / assert の期待値を見直すこと。

実行環境は Node.js `>=22.19.0`(`engines.node`)。CI は下限の 22.19.0 と最新の 26 の両方で検証する。

## 0.14.3

- 履歴エントリの保存先ファイルを、追記時刻ではなく `startedAt` の **UTC 日付**にした。時計の巻き戻りでエントリがページングから漏れる問題と、`historyRef.date` が UTC 0 時をまたぐステップで実ファイルとずれる問題を解消した(ドキュメントの「ローカル日付」の誤記も訂正)
- 履歴ページの読み込みを、新しいファイルから読んで早期に打ち切る方式にして高速化した

## 0.14.2

ユーザーに見える変更なし(biome 設定の `$schema` 更新のみ)。

## 0.14.1

- 実行履歴・カセットファイルを所有者限定のパーミッションで作成するようにした
- UI の capture API が予約キー `$protected` を上書きできてしまう問題を修正した(拒否する)

## 0.14.0

- UI の API 層を TanStack Query へ移行した(画面の見た目・機能の変更なし。capture 後の env 再取得などをキャッシュ無効化で行う内部構造の変更)

## 0.13.5

ユーザーに見える変更なし(CI の npm-package アーティファクトの保持期間を延長)。

## 0.13.4

- エージェント向けドキュメント(Agent Skill / `AGENTS.md` テンプレート)と実装のずれを修正し、ずれを検知するテストを追加した

## 0.13.3

- Agent Skill を v0.13 系の機能(`--tags` / `--jobs` / `--data` / TAP など)に追従させた

## 0.13.2

- TAP レポートのバックスラッシュのエスケープ漏れを修正した(CodeQL の指摘)。ユーザー指定の正規表現のコンパイルも1か所に集約した
- assert の regex がテンプレート展開される点をドキュメントに明記した
- 依存を更新した(eventsource-parser v4、nanoid の脆弱性修正)。`pnpm-workspace.yaml` に `minimumReleaseAge` を追加し、公開直後のバージョンを解決対象外にした

## 0.13.1

レビュー指摘の修正。

- 履歴クエリの順序を保証した
- UI の履歴表示で `--data` のイテレーション番号を表示するようにした
- `--report-file` の出力先の重複を検査するようにした
- `if` 条件の比較とクォートの検証を修正した
- `envFilePath` を cwd 基準で解決するようにした

## 0.13.0

- `klaus run --jobs <n>` を追加した。フロー(ファイル)単位で最大 32 並列に実行する。1フロー内のステップは常に逐次。`--record` とは併用不可

## 0.12.0

- TAP レポーターを追加した(`--report tap`)
- `--report` にカンマ区切りで複数フォーマットを同時指定できるようにした(例: `junit,tap`)。`--report-file` はフォーマットと同じ個数・順序で指定する

## 0.11.0

- フロー単位のタグ選択実行を追加した(`--tags` は OR、`--exclude-tags` は除外で優先)

## 0.10.0

- `klaus run --data <path>` を追加した。JSON / YAML のデータファイルの各行について全フローを1回ずつ実行する(データ駆動、イテレーション単位)

## 0.9.0

- ステップに `if` 条件を追加した。限定構文の条件式で、偽ならステップをスキップする

## 0.8.0

- ステップに `continueOnError` を追加した。失敗しても後続ステップを実行する

## 0.7.0

- `klaus run --var key=value`(アドホックなテンプレート変数。シークレットとしてはマスクされない)と `--env-file <path>`(任意パスの環境ファイル)を追加した

## 0.6.0

- ステップ単位の `retry` を追加した。failed / error を再試行し、試行回数(`attempts`)を履歴に記録する
- 端末制御シーケンスの注入と、シンボリックリンク経由のディレクトリ境界回避を修正した(セキュリティ)。text レポーターと `history` の表示でフロー名・ステップ名をサニタイズし、環境ファイル・`step.use`・server のパス解決で実体パスによる境界チェックを併用する。チェックと読み込みは別 syscall のため、実行中の差し替え(TOCTOU)は防げない既知の限界として docs に記載した

## 0.5.4

- `--port` / `--last` に不正な値を渡したときのエラー報告を `InvalidArgumentError` で整えた
- ドキュメント構成を再編した(troubleshooting を新設、sidebar のグループ化、README の圧縮)。`capture` のネスト・配列インデックスの JSONPath 例と、Agent Skill の記述を実装に合わせて修正した
- `examples/` と `make verify` を整備した(全フロー種別のサンプルと Docker 検証の一本化)

## 0.5.3

- 依存を更新し、脆弱な vite 5 系を排除した

## 0.5.2

ユーザーに見える変更なし(全レイヤーの重複処理を共通ヘルパーに集約した内部リファクタ)。

## 0.5.1

- ドキュメントと実装の不一致を修正し、サイトの既定ロケールを英語にした。CLI の `--help` の案内文言を docs 構成変更に合わせて更新した

## 0.5.0

大型リリース。実行エンジン・CLI・UI サーバーにまたがる機能追加。

- `use:` によるステップ参照を追加した。別ファイルの単発フローの request / assert を再利用する(assert は加算マージ、循環と cwd 境界を検査)
- `$protected` 環境を追加した。環境ファイルの `$protected: true` で保護環境を宣言し、`--allow-protected` なしでは送信を拒否する(exit code 3)。UI の環境 API は `$protected` を常に隔離する
- `assert.bodySchema` を追加した。ajv による JSON Schema 検証で、違反ごとにアサーション結果を返す
- record / replay を追加した。`--record <dir>` で実リクエストをマスク済みのカセットに保存し、`--replay <dir>` でネットワークなしに再生する(未記録のリクエストは exit code 3。SSE / WebSocket は非対応)
- `klaus generate`(OpenAPI からフロー雛形を生成)を追加した
- `klaus.config.yaml` で `run` / `ui` の既定値を設定できるようにした。優先順位は CLI 明示 > config > 組み込み既定。JSON Schema は `klaus schema --target config` で出力できる
- `klaus ui` に `-H, --host` と `--no-open` を追加し、既定ポートを 4884 にした。ループバック以外の host ではトークン認証と CSRF を常に強制する。opener が無い環境でのクラッシュを修正し、コンテナで使えるようにした
- `klaus run --text` を追加した(非 TTY でもテキスト出力を選べる。`--json` とは排他)
- `validate` の出力に YAML の行・列情報を含めるようにした
- シークレットマスキングを強化した(URL エンコード・JSON エスケープされた変種も検出。JSON 出力は直列化前にオブジェクトツリーをマスクする)
- klaus 操作ガイドの Agent Skill を追加した。`klaus init` の `AGENTS.md` テンプレートも更新した
- `examples/` を `api/`(単発チェック)と `flows/`(シナリオ)に再構成した

## 0.4.1

セキュリティ修正。

- URL エンコードされたシークレットが履歴のマスクをすり抜ける問題を修正した
- レポート出力でシークレットが漏れる問題と、制御文字の注入を修正した
- 信頼できない祖先ディレクトリ(他ユーザーが書き込める `/tmp/environments/` など)の環境ファイルを読み込まないようにした。cwd より上で見つかった候補の所有者と other-writable を検査し、信頼できなければ exit code 2 で拒否する(POSIX のみ。group-writable は許容)

## 0.4.0

- フロー YAML の未知キー・typo を検証エラー(exit code 2)にした(全スキーマを strict 化)
- フロー / run-report の JSON Schema を生成して npm パッケージと docs サイトで公開した。`run --json` の出力(v2)も zod スキーマ化し、`klaus schema --target run-report` で出力できる
- CLI の出力を英語に統一し、`--help` の末尾に docs URL・`klaus init`・exit code の要約を追加した。テンプレートの未解決エラーに、解決可能な変数名(キー名のみ)の一覧を付けた
- テストカバレッジの計測を導入し、lines 90% を CI で強制するようにした

## 0.3.0

エージェントと UI からの単発実行を意識した機能追加。

- UI: 単発 API 実行モードを既定画面として追加した(method / url / headers / query / body の編集と結果表示)。`request` に `query` フィールドを追加した
- UI: 環境の閲覧・編集(YAML のコメントを保持)と key-value エディタを追加した。CSRF 検査を POST / PUT / DELETE に拡張した
- UI: レスポンス値を JSONPath で抽出して環境へ保存する capture エンドポイントと、事後保存 UI を追加した
- CLI: `run --json` の出力を v2 にした(compact・failure-focused・500 文字で truncate・全文取得用の `historyRef` を付与)
- CLI: `klaus history` / `klaus history show` を追加した
- CLI: `klaus init` が `AGENTS.md`(エージェント向けガイド)を生成するようにした
- CLI: `klaus validate`(修正ヒント付き検証)と `klaus schema`(JSON Schema 出力)を追加した
- 履歴一覧の所要時間が全ステップの合計である旨を列ヘッダに補足した
- publish 対象を正パターン列挙にし、sourcemap を npm パッケージから除外した

## 0.2.0

- SSE イベントと skipped ステップを履歴に記録し、シークレット値をマスクするようにした
- `environments/` を cwd からの上方探索で解決するようにした
- `klaus init` を追加した(雛形の生成)
- 実行時依存を `dist` にバンドルし、公開時点で供給網を固定した

## 0.1.1

機能差分はない。npm への公開経路を、手動公開から GitHub Actions の Trusted Publishing (OIDC) 経由へ切り替えた最初のリリース。

### 公開経路を OIDC パイプラインへ移行

0.1.0 はパイプライン成立前に手動公開したため provenance(属性証明)を持たない。このリリースから `v*` タグの push で build → 承認 → OIDC 公開が走り、npm が provenance を自動付与する。

**なぜ初回を手動にしたか**: npm の Trusted Publisher は未登録のパッケージには設定できない(パッケージが存在しないと設定画面に到達できない)ため、初回だけはローカルで 2FA 対話認証による公開が必須だった。トークンは一切作成していない。

**公開前検証で見つかった罠**:

- `bin` のパスに `./` を付けると npm 11 が無効と判断し、**警告のみで `bin` エントリを削除して公開する**。インストールしてもコマンドが生成されない壊れたパッケージになるところだった
- `exports` に `default`(または `require`)条件が無いと、CommonJS の `require()` が `ERR_PACKAGE_PATH_NOT_EXPORTED` で失敗する。Node 24 の `require(esm)` 対応は関係なく、ファイル読み込み以前の解決段階で落ちる
- これらは静的解析では見つからず、tarball を実際に隔離インストールして `klaus --version` と `require()` / `import()` を実行して初めて確認できた

### ライセンスを Elastic License 2.0 に変更(`773e8d6`)

MIT から ELv2 へ変更した。利用・改変・再配布は自由だが、**本ソフトウェアをホスティング/マネージドサービスとして第三者に提供することを禁止**する。OSI 定義のオープンソースではなくなる点はトレードオフとして受容した。MIT 版は一度も公開・コミットしていないため、切り替えはクリーン。

### リリースワークフローのセキュリティ設計(`5667a99`)

敵対的検証(攻撃レンズ2本・正当性レンズ1本)を通して確定した構成。

- 全 action をコミット SHA でピン留め。pnpm も正確なバージョンに固定(`version: 11` だと実行時に最新 11.x を取得してしまう)
- `permissions: {}` を起点にジョブ単位で最小権限を付与
- 依存コードを実行する build ジョブと OIDC トークンを持つ publish ジョブを分離。publish 側は checkout も依存インストールも行わず、検証済み tarball のみ公開する(`npm publish <tarball>` はライフサイクルスクリプトを実行しない)
- `setup-node` の `registry-url` は指定しない。指定すると `NODE_AUTH_TOKEN` のプレースホルダが `.npmrc` に書き込まれ OIDC と競合し得る(actions/setup-node#1440, #1551)

**YAML の外で必須の設定**: Actions はタグが指すコミット時点のワークフローを実行するため、タグを作れる者は改ざん版ワークフローごと実行できる。これはリポジトリの ruleset(`v*` タグの作成/更新/削除を制限)でしか塞げない。environment `npm-publish` も事前作成が必要で、未作成だと保護なしで自動作成され承認ゲートが静かに不在になる。

## 0.1.0

### UI を shadcn/ui へ移行(`df9de3d`)

手書きの CSS + 独自コンポーネントから、shadcn/ui(style: new-york)+ Radix プリミティブ + Tailwind CSS v4 へ全面的に置き換えた。

- 導入したコンポーネント11種: `badge` / `button` / `card` / `collapsible` / `progress` / `scroll-area` / `select` / `separator` / `skeleton` / `table` / `tooltip`
- 依存は Radix パッケージ7種 + `class-variance-authority` / `clsx` / `tailwind-merge`(`cn()`)、アイコンは `lucide-react`
- Tailwind v4 は CSS-first 構成のため `tailwind.config.js` は持たず、トークンは `@theme` ブロックで定義する
- 実装トークンの正は [ui/docs/design-system.md](https://github.com/almondoo/klaus/blob/main/ui/docs/design-system.md)、コンポーネント構成の正は [ui/docs/components.md](https://github.com/almondoo/klaus/blob/main/ui/docs/components.md)

移行の意図・デザイン方針は [ui-ux-design.md](ui-ux-design.md) を参照。

### フロー選択中に環境(env)を変更できない不具合を修正

**症状**: フローを選択した状態で env セレクタを切り替えても、即座に元の値へ戻ってしまい変更できない。

**原因**: `ui/src/App.tsx` で env を初期化する `useEffect` の依存配列に `selectedEnv` 自身が入っており、ユーザーが選択を変えるたびに同じ effect が再発火して初期値へ巻き戻していた。

**修正**: `initializedEnvForPathRef` を用いて「フローを切り替えたときだけ初期化する」ようにし、ユーザーの選択を上書きしないようにした。

**検証**: 実ブラウザで `development` を選択し、値が保持されること、かつ実際に送信される HTTP リクエストが `development` の値(`dev@example.com`)になることを、SSE の生レスポンス・実行ビュー・履歴の3箇所で確認した。

### フォーカスリングが表示されない問題を修正(a11y)

shadcn 移行の過程で混入した退行。**Tailwind CSS v4 の仕様に起因するため、今後 `outline-none` を書くときは同じ罠を踏みうる。**

- v4 の `outline-none` は `--tw-outline-style: none` を**無条件で**設定する
- 一方 `focus-visible:outline-2` は太さを指定するだけでその変数を読むため、`outline-none` と併用すると**フォーカス時も何も描画されない**
- 対処として `focus-visible:outline-solid` を追加し、フォーカス時にスタイルを復帰させる

`button` / `select` で修正したのち、同種の記述を横展開で探索して `scroll-area` にも同じ不具合があることを発見・修正した。フォーカス時／非フォーカス時のスクリーンショット比較で視認を確認している。

### 依存パッケージの更新とセキュリティ対応

- Node.js の下限を **`>=22.19.0`** へ引き上げ(従来 `>=20`)
- commander 15 / undici 8 / zod 4 / vite 8 / vitest 4 / biome 2 へ更新。メジャー更新に伴うコード修正は**発生しなかった**
- `pnpm audit` が検出した esbuild の脆弱性を `pnpm-workspace.yaml` の `overrides` で解消

**落とし穴**: この override は**バージョンを固定値で書く必要がある**。

- 範囲指定(`">=0.28.1"`)は**警告なしに無視される**
- `package.json` の `pnpm.overrides` は pnpm 11 では読まれず、`[WARN] The "pnpm" field in package.json is no longer read by pnpm` が出る

```yaml
# pnpm-workspace.yaml
overrides:
  esbuild: 0.28.1   # 範囲指定では効かない
```

コード側のセキュリティレビューでは確信度80%以上の指摘はゼロ。UI の `dangerouslySetInnerHTML` によるエスケープ処理は、実際に攻撃ペイロードを流して無害化されることを確認済み。

### tsconfig の厳格化

`exactOptionalPropertyTypes` を含む strict 系フラグを全面適用した。これにより 19 箇所で型エラーが出たが、`!`(non-null assertion)や `as` によるごまかしは使わず、型定義の拡張と実際のガード追加で解消している。

### `klaus ui` にポート指定オプションを追加

```bash
klaus ui -p 4400        # または --port 4400
```

未指定時は従来どおり空きポートを自動選択する。詳細は [CLI リファレンス](../ja/guide/cli.md)。

### ビルド構成の見直し

`pnpm build` が `dist/ui` を巻き添えで削除し、`klaus ui` が 503 になる事故を3回踏んだため、tsup 側の `clean` を無効化し、リリース用のフルビルドでのみ `scripts/clean.mjs` が `dist/` を空にする構成へ変更した。

- glob 配列(`clean: ["dist/*.js", ...]`)を指定しても outDir 全体が消えることは実測で確認済み
- 役割分担の詳細は [architecture.md](architecture.md) の「ビルド」節を参照

### ドキュメント整備

- UI の設計資料を `ui/docs/`(README / design-system / components)に配置。記述はすべてコードで裏取りし、その過程で既存ドキュメントとの食い違い7件(アイコンライブラリ、フォーカスリング色など)を検出して、**実装を正としてドキュメント側を修正**した
- [改善提案](improvement-proposals.md) を追加。実際に発生した事象のみを根拠とし、各項目に判定(推奨 / 条件付き / 見送り)とコスト見積もりを付けている

### 検証結果

| 項目 | 結果 |
|---|---|
| clean フルビルド(`pnpm build:all`) | 成功(`dist/ui/index.html` の生成を確認) |
| root テスト(vitest) | 121 passed / 121 |
| ui テスト(vitest + jsdom) | 10 passed / 10 |
| 型チェック(`pnpm typecheck`) | OK |
| Lint(`pnpm lint`) | 102 ファイル、修正なし |
| `pnpm audit` | No known vulnerabilities found |
| CLI スモーク | `--version` / `ui --help`(`-p` 短縮形を含む)動作確認 |

**未検証**: `npm pack --dry-run` は実行できなかったため、publish 同梱物は `dist/` の内容を直接確認して代替している(clean ビルド直後のため古い成果物は残っていない)。npm 公開の準備時にはこの確認を実行すること。

## 初回実装(`4cc0495`)

要件定義([requirements.md](requirements.md))の M1〜M3 を実装。core 実行エンジン、exit code 体系を備えた CLI、localhost UI サーバー(Hono)と SPA、GraphQL / WebSocket / SSE 対応、実行履歴 JSONL、および各ドキュメント。

実装中に検出・修正した主な不具合:

- **履歴書き込みの失敗がステップ結果を破壊していた** — `historySink` の呼び出しがメインの try/catch 内にあり、ディスクエラーで成功済みステップが `status: "error"` に化けて capture が失われていた。履歴書き込みを try/catch の外へ出し、失敗は `onWarning` 経由で stderr へ報告する形に変更
- **capture 失敗が `"undefined"` の文字列として伝播していた** — JSONPath が一致しない場合に値が `undefined` となり、テンプレート展開で文字列 `"undefined"` になって `Authorization: Bearer undefined` を送信していた。`RuntimeError`(exit 3)を投げるよう修正(正当な `null` は従来どおり成功扱い)
- **クライアント切断で SSE 実行が永久に停止していた** — 破棄済みレスポンスへの `res.write()` が `false` を返し `'drain'` が発火しないためデッドロックしていた。`'close'` / `'error'` と競合させ、以降の SSE 書き込みは no-op にしつつ、**履歴を残すためフロー自体は最後まで実行する**
- **WebSocket のソケットリーク** — 送信失敗時に `fail()` がソケットを閉じていなかった。共通の `cleanup()` に集約
- **`env` 経由のパストラバーサル**(セキュリティ) — `POST /api/runs` が `path` は検証していたが `env` は未検証だった。core 側の境界チェックと server 側の 403 の2層で対処
- **アサーションの期待値がテンプレート展開されていなかった** — 手動 E2E で発覚(<code v-pre>equals: "{{testEmail}}"</code> が展開されず失敗)。`assert` ブロックにも `renderDeep` を適用し、回帰テストを追加
