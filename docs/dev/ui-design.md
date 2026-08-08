# klaus localhost UI(M4)設計

> [!summary] この文書の役割
> `klaus ui` コマンドで起動する localhost Web UI の先行設計。M4 実装セッションへの引き継ぎ用。M1〜M3(core / CLI)の実装が本設計の前提を壊さないようにするための「守るべき契約」も含む。要件は [[requirements]](requirements.md)を参照。

## 目的とスコープ

- `klaus ui` でローカルサーバーを起動し、ブラウザで UI を開く
- UI の役割は **ランナー + ビューア**。フロー定義の編集はスコープ外(git-native 思想: YAML の編集はエディタで行う。UI からの編集は将来候補に留める)
- クラウド同期・アカウント機構は永久に作らない(要件どおり)

## アーキテクチャ

```
src/
  core/      # 既存。実行・アサーション・履歴の全ロジック(変更なし)
  cli/       # 既存。`klaus ui` サブコマンドを追加(サーバー起動+ブラウザ起動のみ)
  server/    # 新規。HTTP API + 静的配信(core を import する薄い層)
ui/          # 新規。Vite + React SPA(ビルド成果物を dist/ui に出力)
```

- **server は core の再利用のみ**で実装する。実行ロジック・アサーション・履歴読み書きを server に再実装してはならない
- **ブラウザ側(ui/)は core を runtime import しない**。server の HTTP API 経由でのみ通信する。型の共有は `src/core/types.ts` からの type-only import(ビルド時に消える)で行い、ランタイム結合はゼロにする
- サーバーフレームワークは **Hono** を採用(TypeScript ファースト・依存ほぼゼロ・軽量。グローバルインストールされる CLI の依存を重くしない)。Express は CJS 前提で重く不採用、素の node:http はルーティング・ミドルウェアの自前実装コストで不採用
- `klaus ui` 起動時のみ server モジュールを dynamic import し、通常の CLI 実行パスの起動時間に影響させない

## ビルド・配布

- `ui/` は Vite + React。`pnpm build:ui` で `dist/ui/` に静的ファイルを出力し、server が同一オリジンで配信する
- tsup のエントリに `src/server/index.ts` を追加。npm パッケージの `files` に `dist/ui` を含める
- 開発時は Vite dev server(proxy で API を server に転送)、配布時は静的配信の同一オリジン構成

## HTTP API 設計

ベースパス `/api`。全レスポンス JSON。core の型をそのまま返す(型契約は `src/core/types.ts`)。

| メソッド / パス | 役割 |
|---|---|
| `GET /api/flows` | cwd 配下のフロー YAML 一覧(パス・name・ステップ数。パースエラーはエラー印付きで返す) |
| `GET /api/flows/detail?path=` | 1フローのパース済み定義 |
| `GET /api/environments` | `environments/*.yaml` の環境名一覧 |
| `POST /api/runs` | フロー実行。body: `{ path, env? }`。レスポンスは **SSE ストリーム**でステップ単位の進捗(`step-start` / `step-result`)と最終結果(`run-result`)を配信 |
| `GET /api/history?flow=&limit=&before=` | 履歴 JSONL の読み出し(新しい順・ページング) |

- 実行進捗を SSE で流すため、core の `runner` は**ステップ完了ごとのコールバック(または AsyncIterator)を公開しておく**こと(M1〜M3 実装への要求。CLI のプログレス表示にも使える)
- シークレット保護: API レスポンス・履歴読み出しで `{{env.X}}` 解決後の値をそのまま返す(履歴 JSONL の記録内容と同等)。履歴に残したくない値のマスキングは将来課題として UI では対応しない

## セキュリティ(要件の制約の具体化)

1. **バインドは 127.0.0.1 限定**(`0.0.0.0` は設定でも許可しない)
2. **起動時トークン**: サーバー起動時に `crypto.randomBytes` でトークンを生成し、`http://127.0.0.1:<port>/?token=<t>` をブラウザで開く。初回アクセスでトークンを検証して `SameSite=Strict` の Cookie に格納し、以降の API リクエストは Cookie + カスタムヘッダー(`X-Klaus-Token`)の二重チェック
3. **DNS rebinding 対策**: 全リクエストで `Host` ヘッダーが `127.0.0.1:<port>` / `localhost:<port>` であることを検証。不一致は 403
4. **CSRF 対策**: 状態変更 API(`POST /api/runs`)はカスタムヘッダー必須(単純リクエストでは送れないため、同一オリジン以外からの送信を遮断)。`Origin` ヘッダーが存在する場合は同一オリジンのみ許可
5. UI はサーバーと同一オリジンで配信(要件どおり)。CORS ヘッダーは一切付けない

## 履歴 JSONL 契約(M1〜M3 実装が守ること)

UI は履歴 JSONL を読む消費者になるため、以下をスキーマ契約とする:

- 各行に `v`(スキーマバージョン、現行 `1`)を必ず含める
- **v を変えない変更はフィールド追加のみ**(additive)。既存フィールドの削除・意味変更・型変更はバージョンを上げる
- UI・server は未知のフィールドを無視し、未知の `v` の行はスキップして警告表示する
- 1行 = 1ステップ実行。`runId` で同一実行のステップをグルーピングできること

## 画面構成(ラフ)

1. **フロー一覧**: フローファイルのリスト + 環境セレクタ + 実行ボタン
2. **実行ビュー**: ステップごとの進捗(SSE でライブ更新)、アサーション結果の pass/fail、失敗時のリクエスト/レスポンス詳細
3. **履歴ブラウザ**: 過去実行の一覧(フロー・日時でフィルタ)→ ステップ詳細のドリルダウン

状態管理はまず React 標準(useState / useReducer + fetch)で開始し、複雑化した時点で外部ライブラリを検討する(初期から導入しない)。

## `klaus ui` コマンド仕様

```
klaus ui [--port <n>] [--no-open]
```

- ポート未指定時はエフェメラルポート(空きポート自動選択)
- 起動後、トークン付き URL を stdout に表示し、`--no-open` でなければデフォルトブラウザを開く
- Ctrl+C で終了(サーバーのみ。実行中のフローは中断)

## M1〜M3 実装への先行要求(まとめ)

M4 で手戻りしないために、現行フェーズで守るべきもの:

1. 実行・アサーション・履歴ロジックは `src/core` に置き、CLI からは import のみ(要件どおり)
2. 履歴 JSONL は上記のスキーマ契約(`v` / additive 変更 / `runId`)に従う
3. `runner` はステップ単位の進捗通知(コールバックまたは AsyncIterator)を公開 API に含める
4. core は Node 専用でよい(ブラウザ対応は不要)が、CLI(commander・プロセス終了・stdout)への依存を持ち込まない
