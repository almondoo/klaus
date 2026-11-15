# 変更履歴

各リリースで何が変わったかと、**その背景にある判断・踏んだ落とし穴**を記録する。
API の現在の仕様は各リファレンス([CLI](../ja/guide/cli.md) / [フロー定義](../ja/guide/flow-definition.md) / [アーキテクチャ](architecture.md))が正で、ここは「なぜそうなったか」を残す場所。

0.2.0〜0.14.4 は git 履歴(`chore: vX.Y.Z` のバージョン更新コミットを境界に、直前の更新から当該コミットまでの変更をそのバージョンとして)から後追いで復元したもの。ユーザーに見える変更(feat / fix)だけを短くまとめ、内部リファクタ・テスト・依存更新の細部は省いている。

0.15.0 以降は、各リリースのコミット範囲を `git log` で確認して書いている(更新コミットから次の更新コミットまでが後のバージョン)。ただし 0.23.0〜0.25.0 は、更新コミットが機能コミット(`99d8002` mock、`0a35c3e` レポート、`fac3194` diff / promote)より前に入っているため、機能の内容で 0.23.0 = `klaus mock`、0.24.0 = HTML / GitHub レポート、0.25.0 = `klaus diff` / `klaus promote` とした。

## 0.31.0

`klaus mcp`: klaus を MCP(Model Context Protocol)クライアント、つまり AI エージェントへツールとして提供する stdio サーバー。エージェントが `curl` の代わりに、klaus 自身の安全柵のもとで API を調べ、検証できるようにする。

- **追加: `klaus mcp [--read-only]`**。stdio だけで話し(ネットワークのリスナーは持たない)、作業ディレクトリ(`process.cwd()`)をプロジェクトとして使う。ツールは 12 個(`klaus_list_flows` / `klaus_validate_flow` / `klaus_list_environments` / `klaus_dry_run` / `klaus_run_flow` / `klaus_request` / `klaus_history_list` / `klaus_history_show` / `klaus_diff_runs` / `klaus_snapshot_list` / `klaus_promote` / `klaus_snapshot_accept`)。`klaus.config.yaml`(`guard` / `http` / `run.openapi`)は呼び出しごとに読み直し、不正な設定のときは guard なしで送らずにエラーにする。標準出力はプロトコル専用で、診断はすべて標準エラーへ出し、標準入力の終了・SIGINT・SIGTERM で exit 0 で終わる。`--read-only` は書き込みツール(`klaus_promote` / `klaus_snapshot_accept`)を登録しない(実行ツールは引き続き履歴と、無かったスナップショットの基準を書く)
- **判断: MCP は CLI より厳しい、エージェントが操作する経路として扱う**。`--allow-protected` / `--no-mask` / guard を渡す手段を持たず(MCP からは安全柵を緩められない)、出力のマスクと履歴の記録は常にオン。スナップショットは `ci: false` / `update: false`(基準が無ければ書き、不一致は報告するだけで更新しない)。書き込みは CLI ではなく UI サーバーの規則に従う。そのため、`POST /api/history/promote` と `POST /api/snapshots/accept` の本体を Hono 非依存の関数(`promoteHistoryToFile` / `acceptPendingSnapshot`)として取り出し、UI のルートと MCP で共有した(ルートは結果を HTTP の応答に写すだけ。応答は変えていない)。フローのパスは cwd の中(リンク先も)の `.yaml` / `.yml` に限る
- **判断: エラー経由でファイルの内容が漏れないようにした**。YAML の構文エラーはソース行の抜粋を含むため、cwd 内の任意のファイルをフローとして渡すと、その内容がエラーメッセージに出る。MCP では、フローのパスを YAML の拡張子に限り、エラーメッセージは最初の段落だけを返し、絶対パスは相対パスにする
- **追加: core の `EntryPoint` に `"mcp"`**。保護環境の拒否の案内を「`klaus mcp` は上書きできず、利用者が端末から `klaus run --allow-protected` を実行する」にする(フロー実行・単発リクエスト・`--dry-run` のすべて)。`executeSingleRequest` も `entryPoint` を受け取る
- **判断: 履歴の actor**。kind は常に `agent`。name は「`initialize` で名乗ったクライアント名 > 環境変数のマーカー(`CLAUDECODE` / `AI_AGENT`)> `mcp`」の順で決める。クライアント名は自己申告なので、制御文字を除き長さを制限し、実行の可否には使わない
- **判断: 結果の形**。どのツールも整形した JSON のテキストを 1 つ返し、期待される失敗は `isError: true` と `{error, errorCode?, hint?}`。アサーションに失敗した、または拒否されたステップを含む run はツールの失敗にしない(`klaus_request` は 1 件だけなので、拒否・送信失敗を失敗にする)。結果は 256 KiB まで(巨大な文字列・`body` は印に置き換えて JSON を保つ)。リクエストを送るツールと書き込みツールは、プロセス内の直列キューで 1 つずつ実行する。ツールの注釈では、リクエストを送るツールを destructive / open-world、`klaus_promote` を non-destructive(上書きしない)、`klaus_snapshot_accept` を destructive とした
- **追加: devDependency `@modelcontextprotocol/server`(2.4.0 に固定)**。他の実行時依存と同じく `noExternal` で `dist/cli.js` にバンドルする(`zod/v4` のサブパスも含めるため `zod` の指定を正規表現にした)ので、利用者に実行時のインストールは要らない。`dist/cli.js` は約 3.8 MB から約 4.6 MB になるが、SDK は `klaus mcp` のときだけ dynamic import で初期化され、他のコマンドの起動時間は変わらない。dynamic import がコード分割で別チャンクのファイルになると `files`(`dist/cli.js` のみ)から欠けるため、cli のビルドは `splitting: false`
- ドキュメント: ガイド「AI エージェント向けの MCP サーバー」を追加し、CLI リファレンス・README・Agent Skill / `AGENTS.md` に `klaus mcp` を載せた
- **挙動の変更: 入れ子が 200 段を超える JSON はテキストのまま保持し、JSONPath は明示的に拒否する**。深い JSON のレスポンスで、マスクと結果の整形がスタックを使い果たすまで再帰していた(シークレットを登録した状態で深さ 5000 の配列を受けると run が、`klaus mcp` ではツールの呼び出しが落ちた)。`parseJsonBody`(`sendRequest` とカセットの再生で共有)は、反復で数える `exceedsDepth` が `MAX_JSON_BODY_DEPTH`(200。スナップショットの上限がすでに使っていた値)を超える入れ子を見つけたら、生のテキストを返す。以降の段は深い構造を見ない。同じ規則を `klaus req --body`、`path` アサーションでの SSE イベント・WebSocket メッセージの JSON、`klaus_request` の body 引数(文字列で送るよう案内して拒否)にも適用する。最初の版は、その文字列に JSONPath を当てていた。文字列では `$[0]` が先頭の文字になるため、`capture: v: "$[0]...[0]"` は黙って `"["` を捕まえて次へ送り、`exists` のアサーションは通ってしまった。応答には `bodyTooDeep`(内部のレスポンスと、記録される `response`)を持たせ、JSONPath の capture・`body` の path アサーション・`bodySchema` は 1 つのメッセージ(`response body is nested deeper than 200 levels and is kept as text; JSONPath and schema checks cannot be applied`。capture の失敗はステップを `error` にする)で失敗する。`bodyText` のアサーションと `regex` の capture は引き続き使え、カセットの再生も同じ。深い SSE/WS の `data` に `path` を使うと一致せず、理由が分かる。`klaus mcp` の `serializeOutcome` は、ハンドラと同じ try の中で実行する
- **挙動の変更: レスポンスを受け取った後に失敗したステップを履歴に記録する**。`error` のステップで履歴に残るのは安全柵の拒否だけで、capture が失敗してもエントリが残らず、原因を説明するレスポンスが失われていた。リクエストを送ってレスポンス(ステータス・ヘッダー・本文)を受け取り、その後に `error` で終わったステップ(capture の失敗、上の深すぎるエラー、レスポンスの検査中のエラー)は、`status: "error"`、リクエスト、レスポンス、`error` のメッセージ、あれば `errorCode` を持つエントリとして書く。CLI・UI・MCP のすべてに適用される。従来どおり記録しないのは、タイムアウト、接続エラー、本文の途中でのネットワークエラー、大きすぎるレスポンス、送信前に展開できないテンプレート。`klaus history --failed` は従来どおりアサーションの失敗だけを指し、`--status error` はこれらのエントリも含むようになる。`klaus promote` は通知つきでスキップし(error のステップからはアサーションを作らない)、`klaus diff` は他のステップと同じように比較し、error のステップは OpenAPI の検証済みにも、スナップショットの基準にもならない(どちらも capture の後に評価するため)。UI は、レスポンスつきの `error` の行をもともと表示できる
- **挙動の変更: `historyRef` は実際に記録されたステップにだけ付く**。`klaus run --json` は履歴が有効なとき全ステップに `historyRef` を付けていたが、レスポンスを受け取る前、または使えるレスポンスが無いままエラーで終わったステップは履歴のエントリを残さず、ポインタの行き先が無かった。`StepResult` に、エントリを書き込めた後にだけ立てる `historyRecorded` を足し、レポーター(と、記録されたステップごとに `historyRef: { runId, step }` を返すようにした `klaus_run_flow`)がそれに従う。そのため capture が失敗したステップにも付く。`klaus_run_flow` の説明・ガイド・JSON スキーマの説明に、どのステップが記録されるかを書いた
- **修正: クライアントの切断後も、待機中の `klaus mcp` の呼び出しが送信し得た**。直列キューに `close()` を足し、stdin が閉じたとき・SIGINT / SIGTERM でこれを閉じる。まだ開始していない呼び出しは拒否される。すでに送信中のリクエストは中断も待機もしない(終了までの 3 秒の猶予は変えない)ので、履歴のエントリなしに相手のサーバーへ届き得る。これはガイドに書いた
- **追加: `klaus_history_show` の `path`・`offset`・`length`**。切り詰めの印は、同じように切り詰められる `step` 指定の `klaus_history_show` を指していた。`path` は選んだステップのエントリの値を 1 つ返し、`offset` / `length` は単一の文字列の値の窓を読む(既定 32768、最大 40000 文字。すべての文字が JSON のエスケープで 6 バイトに膨らんでも、窓が 256 KiB の上限に収まる大きさ)。`totalLength` と `nextOffset` が付く。印の文言はこれをそのとおりに説明する。マスクは保存されたとおり
- **判断: `path` は JSONPath ではなく、厳格な 4 つの形だけにした**。最初の版は引数に jsonpath-plus を使っていた。保存された深さ 200 のオブジェクトに `$..a..a..a..a` を当てるとサーバーがヒープを使い果たして落ち(SIGABRT)、`$..a..a..a` はイベントループを 10 秒止め、不正な `$[` はエントリ全体を返し、フィルター・スクリプト式はライブラリの既定の safe な評価に頼っていた。小さなパーサーとウォーカー(`src/mcp/history-path.ts`)が `$`・`.name`・`['name']` / `["name"]`・`[n]` だけを受け付け、継承されたプロパティには到達せず、0 個か 1 個の値を返す。それ以外(再帰下降・ワイルドカード・スライス・和集合・フィルター・スクリプト)は、受け付ける形を示す `invalid path` のエラーにする
- **挙動の変更(MCP のみ): 保護された環境の値をマスクする**。最初の版は、保護された環境でも `klaus_dry_run` に環境ファイルの値を出していたため、`klaus_dry_run {env: "ro"}` で、拒否が守るはずの URL と資格情報が見えていた。ツールの呼び出しが `$protected` が `true` または `"readonly"` の環境を読み込むと、そのファイルのすべての変数の値(文字列と数値。真偽値と null は秘密にならず、`$protected` 自身は除く。スキーマが将来許したときのために、入れ子の値も辿る)を、新しい core のオプション `maskProtectedEnvironmentValues`(`runLoadedFlows`・`executeSingleRequest`・`dryRunLoadedFlows`)でその呼び出しのシークレットとして登録する。登録先は run がすでに使っているシークレットの集合で、マスクの仕組みを二重に持たない。dry-run のリクエスト(ホストも。安全柵の判定と `errorCode` は残る)、run・request の結果、エラーや拒否のメッセージ、それらの呼び出しが書く履歴で `***` になる。`klaus_history_show` / `klaus_history_list` / `klaus_diff_runs` / `klaus_snapshot_list` は、以前に記録されたエントリに含まれる、現在保護されているすべての環境の値を隠し(path を当てる前、差分を取る前)、`klaus_promote` は保護された環境に対して記録された run を拒否し、それ以外の run ではその値を隠す。CLI と UI は変わらない。4 文字未満の値はマスクされず(シークレットの既存の下限。隠すとテキストが壊れるため)、キーの名前は見えたまま
- **追加: 履歴エントリの `envProtection`。** 保護された環境を読み込んで書いたすべてのエントリに、core が `"protected"` または `"readonly"` を記録する(名前でも `--env-file` でも、CLI・UI・`klaus mcp` のどこからでも、拒否のエントリを含む)。それ以外では付かない。最初のマスクは列挙できた環境の値としか照合しなかったので、`environments/` の外の保護されたファイル(`--env-file secrets/vault.yaml`)に対して CLI が書いたエントリは、生の値のまま返っていた。書いた時点で事実を記録しておけば、読む側は後から再構成せず、失敗を閉じる扱いにできる。
- **修正: 記録名が名前付き環境のように見える `--env-file` の run が、別のファイルの値でマスクされていた。** `env` はファイルのベース名で記録されるため、`--env-file secrets/ro`(拡張子なし)は `ro` と記録され、`klaus mcp` はこれを `environments/ro.yaml` として解決してそのファイルの値でマスクし、`secrets/ro` の本物の秘密を返していた。core は、環境を env ファイルのパスから読み込んだときに(どの入口でも。`env` が `ro.yaml` のままになる `--env-file environments/ro.yaml` も含む)`envSource: "file"` を記録する。`klaus mcp` はこのエントリを名前で解決しない: `envProtection` があれば中身を出さず `klaus_promote` も拒否し、無ければ(保護されていない環境ファイル)通常どおりマスクして返す。このフィールドが導入される前のエントリは `env` だけで判断する。
- **挙動の変更(MCP のみ): 値を得られないエントリは中身を出さない。** `envProtection` があるのに、その環境が `environments/` にある現在保護されたファイルでないエントリと、環境が読めない・`--env-file` の名前である古いエントリについて、`klaus_history_show` / `klaus_history_list` / `klaus_diff_runs` / `klaus_snapshot_list` はメタデータと `withheld` の説明だけを返す(差分は `notComparable` と `status: "partial"`)。`klaus_promote` はその run と、`envProtection` のあるすべての run を拒否する。UI のスナップショット承認も `envProtection` のある run を拒否する。
- **挙動の変更(MCP のみ): マスクの範囲を広げた。** 送信するツールは、読み込んだ環境だけでなく、`environments/` にある現在保護されたすべての環境の値を登録し、絶対 URL の値はそのホスト・ホスト名・オリジンも登録する(値に `localhost` があると、その呼び出しの出力のあらゆる場所の `localhost` が隠れる)。ガイドには残る露出を明記した: 部分文字列のマスクは変形されたエコーを捕まえられない・正規表現の `capture` で値の一部を再利用できる・4 文字未満の値は決してマスクされない・ありふれた短い語は無関係な文面まで隠しうる。
- **追加: `klaus_dry_run` の `variables`**(`klaus_run_flow` と同じ形)と、`klaus_request` の `env` 専用の説明
- **修正: `klaus_promote` と UI の promote は、小文字の `.yaml` / `.yml` だけを受け付ける**。フローの探索と同じ規則(`x.YAML` は書けるのに探索されなかった)
- **ドキュメント: 保護が何をするかの言い過ぎをやめた**。「安全柵は上書きできない」はオプションについては正しかったが、結果の約束のように読めた。ガイド・ツールの説明・`AGENTS.md`・Agent Skill で、`$protected` はその環境を選ぶ run を止めるもので(環境の名前に結び付き、ホストには結び付かない)、`env` なしの `klaus_request` は `guard.allowedHosts` が許すすべてのホストへ届き、`klaus mcp` プロセスのどの OS 環境変数も <code v-pre>{{env.NAME}}</code> で参照して許可されたホストへ送れる、と書いた。そのためエージェントの送信先を限るのは `guard.allowedHosts` で、ガイドに「推奨する設定」と、保護された環境についてエージェントがなお知り得るもの(名前・保護モード・変数名・リクエストが拒否されたこと・4 文字未満の値)を足した。スキーマ段階の引数エラーは、JSON のエラー本文ではなく SDK の平文で返ることも書いた
- **ビルド: `THIRD_PARTY_LICENSES.md` に `@modelcontextprotocol/core`・`@modelcontextprotocol/server`(Apache-2.0、2.4.0。同梱の LICENSE の全文。どちらにも NOTICE ファイルは無い)と、server パッケージが取り込んでいる MIT の `content-type` を載せた**

## 0.30.0

`klaus history` の絞り込みの拡張、`error` ステップの安定したエラーコード、UI の説明表示、カセットの構造的ヘッダーの絞り込み。

- **追加: `klaus history --status <statuses>`**。status(`passed` / `failed` / `skipped` / `error`)のカンマ区切りで一覧を絞る。`--failed` は assertion の失敗だけを返し、送信エラー・安全柵の拒否(`error`)は出ないため、`error` を含めて見る手段が無かった。`--failed` は変えない。未知の値は有効な値の一覧つきで、`--failed` との併用は引数の衝突として、どちらも exit 1(`--failed` は `--status failed` と同じ意味なので併用に意味が無く、黙ってどちらかを優先するより拒否するほうが驚きが少ない)。UI サーバーの `GET /api/history` には同じ絞り込みを足していない
- **追加: `error` ステップの `errorCode`**。自由文(英語)の `error` だけでは機械的に扱えなかったため、原因を識別する安定したコードを、エラーを作る箇所(`GuardRefusalError` と応答サイズ超過)で付ける(メッセージの文字列照合はしない)。`guard.allowed-hosts` / `guard.protected` / `guard.readonly` / `guard.method-override` / `guard.host-header` / `guard.proxy-header` / `guard.redirect` / `response-too-large`、そして送信ファイル・スナップショットが cwd の外を指す拒否のための `guard.path`。それ以外のエラーには付けない(包括的なコードは作らない)。履歴エントリ、`run --json` / `req --json` の `error` と並ぶ位置、`--dry-run` の `guard.errorCode`、UI サーバーの SSE(`step-result` / `run-result`)・`POST /api/request`・`GET /api/history` に載る。サマリーだけの出力には付けない。リダイレクトのホップが拒否されたときは、ホップ自身の拒否が持つ具体的なコードを残し、コードを持たない拒否のときだけ `guard.redirect` にする(現在の安全柵はすべてコードを持つため、`guard.redirect` は将来の拒否のための予備)。履歴に残るのは安全柵の拒否だけなので、履歴に現れるのは `guard.*` のみ
- **修正: カセットの構造的ヘッダーが、env・認証トークンなどの秘密値を含んでいてもマスクされていなかった**(0.29.2 の指摘)。`content-type` などを記録した値のまま書く例外は、`ct=application/json` のような cookie 値で replay が壊れるのを防ぐためだったが、cookie 由来ではない秘密値を含むヘッダーまで平文になった。秘密値の収集先が cookie 由来の登録を区別して覚えるようにし(`SecretSet`)、構造的ヘッダーは、cookie 由来ではない秘密値でマスクしても値が変わらない場合に限り元の値へ戻す
- UI: ガードによる拒否とよくあるエラーに日本語の説明を表示する(`errorCode` に基づく。元のメッセージは詳細として残す)
- UI: 履歴テーブルのレイアウトを、狭い画面向けに調整した

## 0.29.2

0.29.1 の最終レビューで見つかった 3 点を直した。

- **修正: Host の文法に `_` を許可した**。Docker のネットワーク名(`my_service:8080`)は URL と同じ値でも拒否されていた(`guard.allowedHosts` は受け付ける名前)。`# / ? @ % \`・空白・制御文字は引き続き拒否する(ゾーン ID つき IPv6 の `%` も拒否のまま)。文法違反による拒否は「URL と違う」ではなく「使えない文字を含む」というメッセージにした(同じ安全柵の拒否経路で、`--dry-run` の `guard.reason` も同じ文言)
- **修正: 値が普通の内容と同じ長い cookie 値で replay が壊れていた**。`Set-Cookie: ct=application/json`(16 文字)が秘密値として登録され、`--record` が `content-type` を `***` で記録し、`--replay` が本文を JSON として読めなくなった。カセットの書き込みで、replay・mock の動作が値に依存するヘッダー(`content-type`・`content-encoding`・`content-length`・`transfer-encoding`)は部分一致マスクの対象外にして、記録した値のまま書く。`location` は秘密値を運び得るので対象外にしない。履歴・スナップショットでの表示のマスクは従来どおり(比較は同じ側同士なので壊れない)
- **修正: capture した `Set-Cookie` を別の場所に埋め込むと漏れていた**。jar なしで `capture: { sc: { header: set-cookie } }` をクエリ・ヘッダー・ボディに入れると、履歴・カセット・レポート・`promote` の出力に値が残った。16 文字以上の `Set-Cookie` の値は、jar の有無によらず受信時に秘密値として登録するようにした(受信時の登録に一本化するほうが、capture 側で個別に登録するより単純で、capture 以外の経路・jar 有効時も同じ規則で覆える)。変数そのものは生のままリクエストに使える。レスポンスの `Cookie` ヘッダー(通常は存在しない)の capture は対象にしていない
- ドキュメント: cookie 例外(キャプチャした値はマスクされない、の例外)、`--no-mask` でも `cookie` / `set-cookie` の失敗アサーションのメッセージはマスクされること

## 0.29.1

0.28.2 で入れた `Set-Cookie` のマスクの退行と、cookie 値の秘密値登録、Host ヘッダー・スナップショットのロック・`$ref` のメッセージを直した(敵対的レビューの裁定を受けた修正)。

- **修正: `Set-Cookie` は実行時には生の値、マスクは出力するときだけ**。0.28.2 はレスポンスの受信時点でヘッダーをマスクしていたため、`capture: { x: { header: set-cookie } }`・`set-cookie` のヘッダーアサーション・replay 時の jar への取り込みが `sid=***` を見ていた。受信時のマスクをやめ、出力側(履歴・カセット・スナップショットの基準と候補・UI へ送るライブ結果・レポート・stdout)で、秘密値の登録に関わらず `Cookie` / `Set-Cookie` ヘッダーの値を位置でマスクする。失敗したアサーションの `message` / `actual` は自由文字列で `maskDeep` から見えないため、`cookie` / `set-cookie` ヘッダーに対しては評価した時点でマスク済みの値を載せる(比較は生の値)。そのため `--no-mask` でもこの 2 ヘッダーのアサーションメッセージは `***` のまま。replay ではカセットのマスク済み `Set-Cookie` がそのまま再生される(jar には `***` が入るが、動作は変わらない)
- **修正: jar が受け取った 16 文字以上の cookie 値を、秘密値として再び登録する**。0.28.2 の変更で、ボディや他のヘッダーにエコーされたセッション ID が履歴・基準・カセット・レポートに平文で残るようになっていた。以前の規則(全体の最小長 4)は `json` や `true` のような短い値で出力を壊したため、cookie 専用の最小長 16(`MIN_COOKIE_SECRET_LENGTH`)を設け、全体の最小長は変えない。短い値は Cookie / Set-Cookie ヘッダー内の位置マスクだけ。`capture: { x: { cookie: name } }` にも同じ規則を適用する(これまでは 4 文字以上を登録していた)
- **修正: `Host` ヘッダーの文法を厳密にした**。`guard.allowedHosts` か proxy を設定しているときの比較の前に、生の値が `^[A-Za-z0-9.-]+(:\d{1,5})?# 変更履歴

各リリースで何が変わったかと、**その背景にある判断・踏んだ落とし穴**を記録する。
API の現在の仕様は各リファレンス([CLI](../ja/guide/cli.md) / [フロー定義](../ja/guide/flow-definition.md) / [アーキテクチャ](architecture.md))が正で、ここは「なぜそうなったか」を残す場所。

0.2.0〜0.14.4 は git 履歴(`chore: vX.Y.Z` のバージョン更新コミットを境界に、直前の更新から当該コミットまでの変更をそのバージョンとして)から後追いで復元したもの。ユーザーに見える変更(feat / fix)だけを短くまとめ、内部リファクタ・テスト・依存更新の細部は省いている。

0.15.0 以降は、各リリースのコミット範囲を `git log` で確認して書いている(更新コミットから次の更新コミットまでが後のバージョン)。ただし 0.23.0〜0.25.0 は、更新コミットが機能コミット(`99d8002` mock、`0a35c3e` レポート、`fac3194` diff / promote)より前に入っているため、機能の内容で 0.23.0 = `klaus mock`、0.24.0 = HTML / GitHub レポート、0.25.0 = `klaus diff` / `klaus promote` とした。

 か角括弧つき IPv6 に合うことを要求する(URL パーサーは `host#x`・`host/..`・`@host`・パーセントエスケープ・バックスラッシュ・タブを寛容に受け付けていた)。非 ASCII の IDN は、禁止文字(`# / ? @ % \`・空白・制御文字)を含まない限り、URL のホストと一致する場合に限って通す。キーの大文字小文字だけが違う二重指定は undici が拒否する(テストで固定)
- スナップショットのロック: タイムアウト(10 秒 → 35 秒)を stale の閾値(30 秒)より長くし、クラッシュで残ったロックは必ず待ち切って引き継げるようにした。タイムアウトのエラーにロックファイルのパスと、他に書いている実行が無ければ削除してよい旨を載せる
- OpenAPI の `$ref` が解決できないときのメッセージに、対処(参照先を文書のあるディレクトリの下に置く、または文書を 1 ファイルにまとめる)を足した。存在しない・外にある・リンクのどれでも同じ文面で、パスは出さない点は変えていない
- ドキュメント: cookie の節にリダイレクトでの `http://` → `https://` で cookie が送られないこと(実効ポートが違う)と 16 文字の規則、スナップショット・record/replay に短いセッション値がボディにエコーされるとマスクされない旨を追記した

## 0.29.0

出力のマスクと、UI・CLI の細部を整えた(最終確認での修正と、ドキュメントの整合)。

- **挙動変更: Cookie ヘッダーの値は、登録済みシークレットが無くても出力で常に `***` になる**。`klaus run` / `klaus req` / `--dry-run` の stdout(JSON・text)と `--report html` / `--report github` が対象で、フローや `klaus req -H` に書いた `Cookie` ヘッダーもマスクされる。これまでは登録済みのシークレットが 1 つも無い実行で、出力側のマスクを丸ごと飛ばしていた。`--no-mask` の意味は変わらない(stdout だけが生のまま。履歴とレポートファイルは常にマスク)。`klaus run` のテキスト出力も、整形の前にステップ結果をマスクする
- **挙動変更: `klaus history`(一覧)は、スナップショットの `candidate`(マスク済みのレスポンス全体のコピー)を出さない**。`--fields assertions` を指定しても出ない。`klaus history show <runId>` も、run 全体を出すときは省き、`--step` で 1 ステップに絞ったときだけ含める。大きな応答が一覧や run 全体の出力に混ざり、エージェントのコンテキストを圧迫するのを避けるため
- 保護環境の拒否メッセージの案内を、core の `RunFlowOptions.entryPoint`(`"cli"` / `"ui"` / `"library"`。未指定は `"cli"` と同じ)で切り替えるようにした。UI から起動した実行は UI 向けの案内(`--allow-protected` を UI から渡せない旨)になり、**履歴にも利用者が実際に見た文言が残る**。これまで server が配信する結果の文字列だけを置き換えていたため、履歴の文言とずれていた。置き換え用のモジュール(`src/server/protection-hint.ts`)は削除した
- ドキュメント: CLI リファレンスのコマンド数と `klaus snapshot` の追記、README・AGENTS.md の雛形・エージェント用スキルを最終的な挙動に合わせた。要件・アーキテクチャ・改善提案の、実装で覆った記述(HTTP の関心事を undici に任せる、モックサーバーは予定しない、UI でのフロー編集は対象外、並列実行は見送り)を現状に直した。実装計画に実装結果の節を追加した

## 0.28.2

UI の承認不可スナップショットの扱いと、HTTP 層の敵対的レビュー指摘への対応。

- UI: 他のアサーションが失敗したステップのスナップショットは承認不可とし、理由を表示する(承認 API は 409)。`POST /api/runs` の終了時に、OpenAPI 検証用のワーカーを必ず閉じる
- **挙動変更: 別オリジンへリダイレクトするとき、転送するのは `accept` 系と `user-agent`(ボディを保つなら `content-type` 系)だけ**。それ以外のユーザー指定ヘッダーは、値に関わらず落とす(以前は資格情報と秘密値を含むヘッダーだけを落としていた)。落としたヘッダー名は結果と履歴の `droppedHeaders` に残る。`Location` の userinfo は拒否し、フラグメントは落とす
- **挙動変更: cookie はホストに加えてポートでも限定する**(`localhost:3000` の cookie は `localhost:4000` に送らない)。`Domain` 属性は引き続き host-only として保存し、サブドメイン間では共有しない
- cookie の値と proxy のユーザー名を、部分一致の秘密値として登録するのをやめた。代わりに `Cookie` / `Set-Cookie` ヘッダーの値を位置で `***` にする(短い cookie 値が、出力の他の文字列を壊さないように)。履歴・カセット・出力のすべてで同じ関数を通す
- `guard.allowedHosts` か proxy を設定しているときは、URL と違う `Host` ヘッダーを拒否する。proxy を設定しているときはホップ間ヘッダーも拒否する(許可リスト外の仮想ホストへ到達させないため)
- ファイル入力(`bodyFile` / multipart の `file` / `--body @file`)は `O_NOFOLLOW` で開いたディスクリプタを検証して読み、サイズに上限を設けた。レスポンスボディと SSE にも上限(`http.maxResponseBytes`、既定 100 MiB)を設けた。超えたステップは `error` になる
- OAuth2 の `token_type` と `access_token` に制御文字があれば拒否する。ヘッダー比較マッチャー(`gt` など)は 10 進表記だけを数値とみなす

## 0.28.1

スナップショットと OpenAPI の検証を堅牢にした(敵対的レビューの指摘への対応)。あわせて、UI にスナップショットの承認と新しい実行結果の表示を追加した。

- UI: スナップショットの承認(`GET /api/snapshots/mismatches` / `POST /api/snapshots/accept`。保護環境の run は拒否)と、スナップショット・OpenAPI の判定、警告、リダイレクト経路をランナーと履歴に表示する。`klaus.config.yaml` の `run.openapi` を UI 起点の実行にも適用する。`GET /api/history` の応答からは承認用の候補(`candidate`)を除き、承認 API はバックスラッシュを含むパスを拒否する
- **挙動変更: UI の「フローとして保存」の保存先は許可リスト方式**。`api/` と `flows/` の配下、または既にフローがあるディレクトリに限る(大文字小文字・Unicode の違いによる迂回を防ぐ)。それ以外は拒否する

- スナップショット: OpenAPI の検証を先に行い、失敗したレスポンスは基準として記録しない。同じステップの他のアサーションが失敗していれば、`-u` も `klaus snapshot accept`(新しい失敗種別 `failed-step`)も記録しない。`snapshot list --json` の項目に `otherAssertionsFailed` を足した。履歴の候補は基準と同じ形で検証し(`corrupt`)、200 階層より深い基準・レスポンスはクラッシュさせず、基準は exit 2、レスポンスは snapshot アサーションの失敗にする
- スナップショットのキーを曖昧にしない: `assert.snapshot` を持つステップの名前は ` :: ` を含まず ` #<数字>` で終わらない(定義エラー、exit 2)。キーの重複も定義エラー
- ファイルの安全: 基準が名前付きパイプやデバイスでも実行を止めない(lstat・通常ファイルの確認・非ブロッキング open)。フローのディレクトリから基準までのシンボリックリンクは、読み書きとも拒否し、`.git/` など隠しディレクトリの下の `__snapshots__` も拒否する。エラーメッセージにカレントディレクトリ外の絶対パスを出さない
- 並行書き込み: 基準の書き込みはロックファイルの下で、書く直前に読み直して行う。同じファイルの別のキーを同時に書く実行が、互いのキーを失わない。UI から起動した実行は `CI` を読まない(`klaus run` だけが読む)ことを明記した
- OpenAPI: スキーマの検証をワーカースレッドで、レスポンス 1 件あたり 3 秒の上限つきで行う(`^(a+)+$` のような `pattern` で止まらない。超えたら警告つき `skipped`、`--openapi-strict` では失敗)。ワーカーは `dist/openapi-worker.js` として同梱する(`files` に追加、新しい依存なし)。`OpenApiValidator.check()` は非同期になり、`close()` と `validationTimeoutMs` を足した
- OpenAPI: YAML は警告を出さずに読む(警告に参照先の行が載るため。リポジトリ全体の `yaml` の読み込みも同様)。`$ref` の行き先は文書のあるディレクトリの中に限り(実パスで判定)、存在しない場合と禁止の場合を区別しない同一のメッセージで拒否する。解決できない `$ref`・実体のない循環・`$dynamicRef` を含むスキーマは `valid` ではなく `skipped`(`--openapi-strict` では失敗)
- OpenAPI: 既定値が `/` を含むサーバー変数は複数セグメントに一致する。YAML のマージキー、`allOf` の分岐にある必須の `writeOnly`、3.1 の `nullable`、宣言された本文が空で返る場合、`.` / `..` セグメント、再帰スキーマに対する深い本文(`RangeError` にしない)を正しく扱う。`--openapi-coverage-min` は 10 進数の 0-100 だけを受け付ける(`0x10` などは拒否)
- 判断した点: (1) 時間の上限は同梱の Ajv をワーカーに置いて実現する(同期の正規表現は中断できないため)。タイムアウトしたスキーマはその実行で二度と評価しない。(2) ロックは 10 秒で諦め、30 秒より古いものは無視する。(3) 3.1 の `nullable` は変換せず警告にする(3.1 のキーワードではないため)

## 0.28.0

OpenAPI によるレスポンスの検証とカバレッジ(`klaus run --openapi`)を追加した。フローを変えずに、すべての HTTP レスポンスを OpenAPI 3.0 / 3.1 の文書に照らして検証し、実行がどのオペレーションを呼んだかを報告する。

- 文書は YAML / JSON のローカルファイルだけを読む(複数指定可。`klaus.config.yaml` の `run.openapi` が既定値で、相対パスは設定ファイルの場所から解決する)。ローカルファイルへの `$ref` は解決し(拡張子は `.yaml` / `.yml` / `.json` のみ、1 ファイル 8 MiB・合計 32 MiB・100 ファイルまで)、リモートの `$ref` は拒否する。循環参照は訪問済みの管理で止め、すべての `$ref` を実行前に確認する。読めない・不正な文書は exit 2 で何も実行せず、エラーに参照先ファイルの内容は載せない
- リクエストは、サーバー URL(変数つき。`--openapi-base-url` で追加)の接頭辞、パステンプレート、メソッドでオペレーションに照合する。具体的なパスをテンプレートより優先する。照合できないリクエストは `unmatched` として報告するだけで、既定では失敗にしない。`--openapi-strict` で、照合できないリクエスト・文書に無いステータス・検証できないレスポンスを失敗にする
- 照合できたレスポンスは、ステータス(完全一致 → `2XX` → `default`)、必須ヘッダー、content-type、本文(同梱の Ajv の 2020-12 で JSON スキーマ検証)を検証する。違反は `kind: "openapi"` のアサーションとして、場所と JSON Pointer つきで最大 20 件を載せ、ステップを失敗(exit 4)にする。レスポンスの値は違反に載せない
- 3.0 のスキーマは `nullable` と真偽値の `exclusiveMinimum` / `exclusiveMaximum` を変換する。`format` は検証しない(未知の format で失敗しない)。`writeOnly` のプロパティはレスポンスで必須にしない。`discriminator` / `xml` / `externalDocs` / `example` は注釈として無視し、`$dynamicRef` / `$recursiveRef` は警告を出して無視する。コンパイルできないスキーマは警告にして、そのレスポンスは検証しない。スキーマのコンパイルは実行ごとに 1 回、オペレーション単位で遅延して行う
- カバレッジ(`openapi` の集計)は、オペレーションの総数と照合できた数、観測したステータスコード、未カバーのオペレーション、照合できなかったリクエスト、検証の対象外にしたステップ(SSE / WebSocket / リダイレクトを追ったもの)を、JSON・text・HTML・GitHub のサマリーに出す。`--tags` で一部のフローだけを実行したときは `partial` と明記する。`--openapi-coverage-min <percent>` を下回ると、全ステップが成功していても実行を失敗(exit 4)にする
- `--jobs`・`--data`・`--replay` と併用できる。`--dry-run` では何も検証せず、展開後の URL を照合した「計画」のカバレッジだけを出す(`--openapi-strict` / `--openapi-coverage-min` は併用不可)。リクエスト側の検証(パラメーター・リクエストボディ)は行わない。照合と検証は分けてあり、後から足せる
- 判断した点: (1) 文書の読み込みは `@apidevtools/swagger-parser` を使わず自前で行う。`$ref` の行き先(拡張子・ファイル数・サイズ)の制限、エラーに内容を載せないこと、3.0 から 2020-12 への変換を制御するため。(2) 照合できないリクエストと文書に無いステータスは、既定では失敗にしない(仕様が実装より遅れていることが多く、導入を妨げないため)。(3) リダイレクトを追ったステップは、レスポンスが最初のリクエストのものではないので検証せず、対象外として報告する。(4) カバレッジの下限を下回ったときは実行の status を failed にする(JSON の `status` と exit code を食い違わせないため)

## 0.27.0

スナップショットアサーション(`assert.snapshot`)を追加した。レスポンスを基準として保存し、以降の実行で比較する。

- 基準はフローファイルの隣の `__snapshots__/<フローファイル名>.snap.json` に、キー順ソートの整形 JSON で保存する(git の差分で読むため)。キーはステップ名に `--data` の反復番号と `name` を足したもの。比較は構造的な JSON 差分(`klaus diff` と同じ差分エンジン)で、`ignore` は `klaus diff --ignore-path` と同じ文法。一致した値は固定値 `"[ignored]"` に置き換えて保存し、基準が揺れないようにする
- **秘密値**は履歴と同じマスクを通した後の値を保存・比較する。コミットするファイルに宣言済みの秘密値を残さないため。`--no-mask` はスナップショットには効かない。宣言されていない値(ボディ中の個人情報など)は保存されるので、`ignore` とコミット前の確認が必要
- 基準が無い場合はローカルの実行では書き込んで成功にし、**CI(環境変数 `CI` が真、または `--ci`)では書かずに失敗**にする(Jest・insta と同じ方針で、CI が黙って記録しないため)。不一致は構造差分つきの失敗(exit 4)。`-u` / `--update-snapshots` で書き換え・追記・古いエントリの削除を行う。`-u` は `klaus.config.yaml` から設定できず、`--dry-run`・`--replay`・`--ci` と併用できない
- 判断した点: (1) 基準の書き込みは実行の終了時に一度だけ行う。`--jobs` と `--data` の反復が同じファイルを触るため、競合と中途半端な書き込みを避ける。(2) `--replay` は比較するが書き込まない(再生した応答は実際の API の現在の姿ではないため)。(3) 保護環境($protected)への実行では、`-u` なしの新規書き込みを拒否する(本番のデータがコミット対象のファイルに入るのを防ぐ)。(4) 他のアサーションが失敗したステップの応答は、暗黙には基準にしない。(5) 古いエントリは、フローの全ステップが実行された場合にだけ判定する(失敗で途中終了した実行が基準を消さないため)。(6) 壊れたスナップショットファイルは exit 2 で何も実行せず、内容は出力しない(意図しないファイルが参照先でも内容が漏れないため)
- 書き込み先は cwd 内の `__snapshots__` ディレクトリに限り、`findUnsafeSymlinkInWritePath` と O_NOFOLLOW で、シンボリックリンクを辿らない(`klaus promote` と同じ方針)。一時ファイルへ書いてから rename する
- 履歴の snapshot アサーションに、承認用の候補(マスク済み)を残す。core の `listSnapshotMismatches` / `acceptSnapshot` と CLI の `klaus snapshot list|accept` は、この候補を基準に書く(API を再度呼ばない)。UI からの承認は後続の変更で、これらの関数を呼ぶ
- UI に実行の比較(`GET /api/history/diff` と履歴タブの比較パネル。除外パスを指定できる)と「フローとして保存」(`POST /api/history/promote`。新規ファイルのみで、上書きしない)を追加した。`klaus.config.yaml` の `http` を UI 起点の実行にも適用する
- JSON 出力のトップレベルに `snapshots`(集計と書き込んだファイル)を追加し、snapshot アサーションに `state` / `snapshotKey` / `snapshotFile` / `differences` / `differenceCount` を載せる。承認用の候補は JSON 出力に載せない(応答全体のコピーのため)

## 0.26.0

実行レポートの追補(HTTP クライアント関連)。

- ステップ結果の `redirects` と `droppedHeaders` を、JSON 出力のステップにも載せた(成否に関わらず、持つステップだけ)。text 出力では `FAIL` / `ERROR` の詳細行に、HTML レポートではステップの詳細(成功したステップは折りたたみ)に出す
- JSON 出力のトップレベルに `warnings`(1 件以上あるときだけ)を追加した。`tls.insecure` の警告は従来 stderr にしか出ず、stdout の JSON だけを取り込む CI では見えなかったため。stderr への出力は変えず、text はサマリーの前の `warning:` 行、HTML は警告欄、GitHub サマリーは引用行として出す。警告は実行全体で重複を除く
- `klaus mock` に `Host` ヘッダーの検証を追加した(DNS リバインディング対策)。loopback で待ち受けるときは `127.0.0.1` / `localhost` / `[::1]` と待受ポートの組だけを受け付け、`--allow-host` で追加のホスト名を許可できる
- `klaus schema` のフロー定義スキーマの注記で、リクエストボディの排他が `body` / `graphql` だけの記述になっていたのを `form` / `multipart` / `bodyFile` まで広げた(0.21.0 で排他の対象を増やした際の書き漏れ)

## 0.25.0

`klaus diff` と `klaus promote` を追加した。

### `klaus diff`

履歴の2つの run をステップ単位で比較する(ステータス・ヘッダー・ボディの構造的な JSON 差分または行差分・リクエストの変化)。差分があれば **exit 4**(`run` のアサーション失敗と同じ「失敗」の意味合いで揃えた)、run が見つからない・引数不正は 2。`Date` などの揮発するヘッダーは既定で除外し、`--ignore-path` / `--ignore-header` で追加する。履歴のシークレットは `***` で保存されるため、シークレット値の変化は差分に現れない。

### `klaus promote`

履歴の run から、観測したレスポンスをもとにアサーションを推論した再実行可能なフロー YAML を生成する(`--assert status|schema|values|all`、既定は `schema`)。マスク値は復元できないため `{{env.TODO_*}}` のプレースホルダーに置き換えて一覧で示し、生成物に `***` が残る場合は書き込まない。既存ファイルは `--force` なしでは上書きせず、出力先はカレントディレクトリ配下に限る。書き込み前に生成物をスキーマ検証する。前のレスポンスの特徴的な値が後のリクエストに現れるときは `capture` として連鎖させる(`--no-chain` で無効化)。

## 0.24.0

`--report html` と `--report github` を追加した。

- `html`: 外部アセット・JavaScript を使わない自己完結の単一 HTML(既定 `klaus-report.html`)。失敗・エラーのステップは既定で展開する
- `github`: GitHub Actions 向け。ジョブサマリー(Markdown)を `--report-file`、なければ `GITHUB_STEP_SUMMARY` への追記、なければ `klaus-report.md` に書き、`GITHUB_ACTIONS=true` のときは失敗ステップごとに `::error` アノテーションを出す。stdout にはサマリーを書かない(`--json` の機械可読出力を壊さないため)

## 0.23.0

`klaus mock <dir>` を追加した。

`klaus run --record <dir>` で記録したカセットを返すだけのローカル HTTP サーバーを起動する。ネットワークへは一切転送せず、未マッチは 404(`closest` に近い記録済みパスを返すが、記録済みボディは含めない)。マッチングは **メソッド + パス + クエリ**(記録時のホストは捨てる。ホストまで見る replay とはここが違う)。既定の bind は `127.0.0.1`、ポートは UI(4884)と衝突しない 4885。`--cors` / `--delay` / `--ignore-query` / `--sequence` / `--origin` / `--json` を備える。カセットが無い・不正・空なら exit 2。記録時にマスクされたシークレットは `***` のまま返し、復元しない。

## 0.22.0

capture とアサーションを拡張した。

- capture に `{header}`・`{cookie}`・`{regex, group?}`・`{status: true}` を追加した(文字列は従来どおり JSONPath)。cookie capture は最終ホップの URL で cookie jar から引き、jar が無い場合は案内つきの `error` にする。capture の `error` メッセージには取得した値や本文を含めない(秘密を含み得るため)
- header と body のアサーションに `gt` / `gte` / `lt` / `lte` / `length` / `type` / `oneOf` を追加した
- `assert.status` に数値の配列と `"2xx"` 形式を追加した

## 0.21.0

リクエストボディの形式を追加した。

- `request.form`(`application/x-www-form-urlencoded`)、`request.multipart`(テキストとファイルのパート)、`request.bodyFile`(ファイルの内容をそのまま送る)
- 入力ファイルは cwd 配下(シンボリックリンク解決後も)に限る。境界外は安全柵の拒否として履歴に残す。エージェントが書いたフローで任意のファイルを送らせないため
- 履歴と dry-run にはファイルの内容を残さず、ファイル名とサイズだけを記録する
- `body` / `graphql` / `form` / `multipart` / `bodyFile` は同時に指定できない

## 0.20.0

認証ヘルパーを追加した。

- `request.auth` とフロー共通の `http.auth`(`klaus.config.yaml` の `http.auth` も可)。ステップ側が優先し、`auth: none` で無効化できる。`basic` / `bearer` / `oauth2`(client credentials)
- OAuth2 のトークンは実行単位でキャッシュし、`expires_in` を過ぎたら取り直す。トークン取得も通常のリクエストと同じ安全柵・proxy・TLS・record/replay を通り、リダイレクトは追わない
- パスワード・トークン・クライアントシークレット・取得したアクセストークン・Basic の base64 形を秘密値として登録し、履歴・出力・dry-run でマスクする。`--dry-run` は `Authorization` をマスクして表示し、トークンは取得しない
- `Authorization` ヘッダーを自分で指定したステップとの併用はエラー

## 0.19.1

`klaus req` と `--dry-run` のレビュー指摘を修正した。

- `--dry-run` が `query:` と前段 capture 由来のホストを併用するとクラッシュする問題を修正し、未解決の `{{name}}` をパーセントエンコードせず保つようにした。未解決変数のエラーは実行時と同じメッセージにし、`undetermined` はホスト名そのものが未解決のときだけにした
- `query` のマージで、URL に書かれたクエリを組み直さず書かれたままの文字列で保つようにした(`&` `+` `=` `/` を含む秘密値が壊れ、マスクが部分的になる問題)
- 保護環境の拒否メッセージの案内を入口で切り替え、`klaus req` と UI の単発リクエストでは `--allow-protected` を案内しない
- 引数の組み合わせエラー(`--dry-run` と `--record` など、`req` の `--json` と `--text`)を `run` と同じ exit 1 に揃えた
- リダイレクトで別オリジンへ移るとき、資格情報に加えて秘密値を含むヘッダーも落とし、落としたヘッダー名を結果と履歴に残すようにした
- cookie の `Domain` 属性は常に host-only として保存し、サブドメイン間で共有しない

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
