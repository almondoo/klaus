# klaus ui — HTTP API と内部構成

利用者向けの使い方は [../guide/ui.md](../ja/guide/ui.md) を参照。

## HTTP API リファレンス

UI が使う API。すべて `X-Klaus-Token` ヘッダーが必要。

| メソッド / パス | パラメータ | 説明 |
|---|---|---|
| `GET /api/flows` | — | cwd 以下を再帰走査(node_modules / .git / dist / .klaus / ui / environments / tmp を除外)し、最上位に `steps` キーを持つ YAML を列挙。パース成功はフロー情報、失敗はエラー理由付き |
| `GET /api/flows/detail` | `path` | 1フローのパース済み定義(ステップ概要含む) |
| `GET /api/environments` | — | `environments/*.yaml` の環境名一覧(ディレクトリ無しは空配列) |
| `GET /api/environments/:name` | — | 1環境の内容を `{ name, values }` で返す。存在しない環境は 404、`:name` がパス区切り等を含む場合は 403 |
| `PUT /api/environments/:name` | body: `{ values }` | 1環境の内容を更新し、更新後の内容を `{ name, values }` で返す。`values` はキー・値とも文字列の Map であること。YAML 上の既存コメントは保持される。存在しない環境は 404 |
| `POST /api/environments/:name/capture` | body: `{ key, path, json }` | `json`(直近のレスポンスボディ等)から JSONPath(`path`)で値を1件抽出し、`key` として指定 env にマージ保存する(該当キー以外は変更しない)。更新後の内容を `{ name, values }` で返す。抽出結果が無い・オブジェクト/配列/null など非プリミティブな場合は 400、存在しない環境は 404 |
| `POST /api/runs` | body: `{ path, env? }` | フロー実行。レスポンスは SSE ストリーム(下記) |
| `POST /api/request` | body: `{ request, env? }` | フロー定義を介さず単一のリクエスト定義(`request` は requestSchema 準拠)を同期実行し、`{ result: StepResult }` を返す。`env` を指定すると `{{var}}` をその環境で展開する。`request` の検証エラーは 400、`env` 名が不正な場合は 403 |
| `GET /api/history` | `flow` / `limit`(デフォルト 50)/ `before`(ISO 日時カーソル) | 履歴を新しい順にページングして返す。未知の `v` の行はスキップ。snapshot アサーションの承認用の候補(`candidate`、応答全体のコピー)は返さない |
| `GET /api/history/events` | — | 履歴ディレクトリ(`.klaus/history/`)の変化を通知する SSE。通知は連番と変更のあった日付だけを含み、クライアントは受信後に `GET /api/history` を取り直す。同時購読は最大 16 本 |
| `GET /api/history/diff` | `a` / `b`(run ID。`flow` 指定時は `latest` / `previous` も可)/ `flow`(任意)/ `ignorePath`(JSONPath。繰り返し指定、最大 20 個) | 2 つの run の差分(core の `diffRuns` の結果。`klaus diff --json` から `version` を除いた形)。run ID の形式不正・解釈できない `ignorePath`・指定回数超過は 400、履歴に無い run は 404。履歴はマスク済みのまま比較する |
| `POST /api/history/promote` | body: `{ runIds, flow?, assert?, baseUrlVar?, chain?, name?, out?, dryRun? }` | 履歴の run から**新規の**フローを生成する(`klaus promote` 相当。`--force` と `--allow-template-literals` は無く、未知のキーは 400)。`dryRun: true` は YAML とサマリーだけ返し何も書かない。保存先は api/ / flows/ とその配下、または既にフローがあるディレクトリに限り、cwd 外・隠し要素・拡張子違い・設定ファイル名・バックスラッシュは 403、既存ファイルは 409(上書きしない)、履歴に無い run は 404、リテラルの `{{` を含む記録などは 422(`code: "template-literal"`) |
| `GET /api/snapshots/mismatches` | `runId` | run の承認待ちスナップショット(core の `listSnapshotMismatches`)を `{ runId, mismatches, acceptRefusal? }` で返す。保護環境の run などは `acceptRefusal` に理由が入る。run ID 不正は 400、履歴に無い run は 404 |
| `POST /api/snapshots/accept` | body: `{ runId, snapshotFile, key }` | 承認待ちの 1 件を基準としてスナップショットファイルに書き込む(core の `acceptSnapshot`)。`(snapshotFile, key)` は上の一覧に含まれる組に限る(含まれなければ 404、cwd 外・バックスラッシュを含むパスは 403)。保護環境(または判定不能な環境)の run は 403、core の `unsafe` は 403、壊れた既存ファイル(や不正な候補)は 422、同じステップの他のアサーションが失敗していた(`failed-step`)場合は 409 |

### POST /api/runs の SSE イベント

| イベント | ペイロード | タイミング |
|---|---|---|
| `step-start` | `{ flow, file, step }` | ステップ開始時 |
| `step-result` | `{ flow, file, result: StepResult }` | ステップ完了時(skipped 含む) |
| `run-result` | `{ flow: FlowResult, warnings?, openapi? }` | フロー完了時(最後に1回)。`warnings` は結果に影響しない警告、`openapi` はサーバーに `run.openapi` を設定したときのカバレッジ集計 |

### StepResult の errorCode

`status: "error"` のステップ結果は、自由文の `error`(英語)に加えて、原因が下記のものなら安定した `errorCode?: string` を持つ。`step-result` の `result`・`run-result` の `flow.steps[]`・`POST /api/request` の `result`・`GET /api/history` の `entries[]` にそのまま載る(UI はこれで日本語の説明を出し、元の `error` は詳細として残す)。コードを持たないエラーでは省略する(包括的なコードは無い)。

| `errorCode` | 原因 |
|---|---|
| `guard.allowed-hosts` | 送信先ホストが `guard.allowedHosts` に無い |
| `guard.protected` | 環境の `$protected: true` による拒否 |
| `guard.readonly` | `$protected: readonly` で読み取り系以外のメソッドを拒否 |
| `guard.method-override` | `$protected: readonly` でメソッド上書きヘッダーを拒否 |
| `guard.host-header` | Host ヘッダーが URL と違う、または不正 |
| `guard.proxy-header` | proxy 利用時のホップ間ヘッダー等の禁止ヘッダー |
| `guard.path` | cwd の外のファイル(送信ファイル・スナップショット)の参照 |
| `guard.redirect` | リダイレクトのホップが、コードを持たない安全柵に拒否された(ホップ自身の拒否が上のコードを持つなら、そちらを残す) |
| `response-too-large` | `http.maxResponseBytes` 超過(応答・SSE) |

履歴に残るのは安全柵の拒否だけなので、`GET /api/history` に現れるのは `guard.*` のみ。値は公開契約として固定。`GET /api/history` のクエリには status の絞り込みを追加していない(CLI の `klaus history --status` だけ)。

**クライアント切断時の挙動**: ブラウザを閉じる・リロードしても実行中のフローは**最後まで完走し、履歴も全ステップ分書き込まれる**。切断されるのは SSE 配信だけで、サーバーは後続リクエストに正常に応答し続ける。

## アーキテクチャ上の位置づけ

サーバー(Hono)は `src/core` の `runFlow` を呼び、`onStepStart` / `onStepComplete` コールバックを SSE にブリッジしているだけの薄い層。詳細は [アーキテクチャ](architecture.md)、設計意図は [ui-design.md](ui-design.md) / [ui-ux-design.md](ui-ux-design.md) を参照。
