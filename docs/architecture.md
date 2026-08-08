---
tags:
  - dev-tools/api-testing
  - documentation
  - architecture
created: 2026-08-08
source:
---

# アーキテクチャ

開発者向けの構成ガイド。設計の背景は [requirements.md](requirements.md)、UI の設計意図は [ui-design.md](ui-design.md) を参照。

## パッケージ構成と依存方向

単一 npm パッケージ(`@almondoo/klaus`)+ ビルド時専用の ui ワークスペース。

```
src/
  core/     # 実行エンジン(CLI 非依存ライブラリ)。他層への依存なし
  cli/      # commander の薄い皮。core を import
  server/   # klaus ui の API サーバー(Hono)。core を import
ui/         # Vite + React SPA(private ワークスペース)。core への runtime 依存なし
```

**守るべきルール**:

- 実行・アサーション・履歴の全ロジックは `src/core` に置く。cli / server はそれを呼ぶだけで、**再実装しない**
- core は commander・プロセス終了・stdout など CLI 的関心を持ち込まない
- ui(ブラウザ)は core を runtime import しない。server の HTTP API 経由のみ。型共有は `src/core/types.ts` からの **type-only import**(ビルド時に消える)
- HTTP / WebSocket レイヤーは undici に委譲する。リトライ・リダイレクト制御を自前実装しない

## src/core の内部構成

| モジュール | 責務 | 純粋 / I/O |
|---|---|---|
| `schema.ts` | zod スキーマ(フロー / 環境ファイル)、排他ルール検証 | 純粋 |
| `loader.ts` | YAML 読み込み → zod 検証 → ParseError | I/O |
| `env.ts` | environments/<name>.yaml の解決 | I/O |
| `template.ts` | `{{...}}` 展開・テンプレート関数 | 純粋 |
| `http.ts` | undici ラッパー(計測・JSON 判定・タイムアウト) | I/O |
| `sse.ts` | SSE 受信と上限打ち切り(eventsource-parser) | I/O |
| `ws.ts` | WebSocket 接続・送受信・上限打ち切り(undici WebSocket) | I/O |
| `assert.ts` | 全アサーション評価(例外を投げない) | 純粋 |
| `runner.ts` | ステップ順次実行・キャプチャ連鎖・skip 制御・status 集約 | orchestration |
| `history.ts` | 履歴 JSONL 追記(versioned スキーマ) | I/O |
| `errors.ts` | `KlausError` / `ParseError` / `RuntimeError` | 純粋 |
| `types.ts` | `RunResult` / `FlowResult` / `StepResult` 等の契約型 | 純粋 |

## core 公開 API(`src/core/index.ts`)

CLI・server・将来のツールが使う契約:

```ts
runFlow(filePath, options?): Promise<FlowResult>      // 1フロー実行
runFlows(filePaths, options?): Promise<RunResult>     // 複数フロー順次実行
executeFlow(flow, filePath, options?): Promise<FlowResult>  // パース済み Flow の実行

interface RunFlowOptions {
  cwd?: string;                 // 環境ファイル・履歴の基準ディレクトリ
  envNameOverride?: string;     // --env 相当
  runId?: string;
  history?: boolean | ((entry: HistoryEntry) => void | Promise<void>);  // false で無効化 / 関数でカスタム sink
  onStepStart?: (ctx: { flow, file, step }) => void | Promise<void>;
  onStepComplete?: (ctx: { flow, file, result: StepResult }) => void | Promise<void>;
  onWarning?: (message: string) => void;   // 履歴書き込み失敗等の非致命的警告
}
```

- `onStepStart` / `onStepComplete` は CLI のインクリメンタル text 出力と、server の SSE ライブ配信の両方が使う(skipped ステップにも発火する)
- エラー型と exit code の対応: `ParseError` → 2 / `RuntimeError` → 3(接続不能・タイムアウト・テンプレート未解決・キャプチャ失敗)。アサーション失敗は例外ではなく `StepResult` のデータで表現され CLI 層で 4 に変換される
- `runFlows` は `ParseError` を捕捉しない(呼び出し側が exit 2 にマップする契約)

## ビルド

- **tsup で3エントリ**: `dist/index.js`(ライブラリ、d.ts 付き)/ `dist/cli.js`(shebang 付き bin)/ `dist/server.js`(`klaus ui` 時に dynamic import される)
- **ui は Vite** で `dist/ui/` に出力(`ui/vite.config.ts` の outDir)
- `pnpm build:all` = `pnpm clean` → `pnpm build`(tsup)→ `pnpm build:ui`(Vite)
- **clean の役割分担**: tsup 側は `clean: false` にしてある。tsup の clean は outDir 全体を消すため、有効にすると Vite が出力した `dist/ui` まで巻き添えで消え、`pnpm build` / `pnpm test` の後に `klaus ui` が 503 になるからである。その代わり、エントリを削除・リネームした際に古い成果物が `dist/` に残り `files: ["dist"]` 経由で publish に同梱される危険があるため、**リリース用のフルビルド `build:all` では `scripts/clean.mjs` で `dist/` を空にしてから**ビルドし直す。開発時の `pnpm build` 単体は clean せず、`dist/ui` を保持する
- `src/cli/ui.ts` は server モジュールを実行時パス組み立てで dynamic import しており、`klaus run` の起動時間に server / Hono のロードコストが乗らない

## テスト構成

「テストは過不足なく」(仕様のふるまい単位でカバーし、実装詳細への張り付き・重複・水増しをしない)が方針。

**root(vitest、tests/、118件)**

| 種類 | 対象 |
|---|---|
| 純粋ユニット | schema / loader / template / assert / env |
| ローカルサーバー統合 | http / sse(node:http)、ws(ws パッケージ)、graphql、runner(キャプチャ連鎖・skip・進捗コールバック・履歴)|
| CLI ユニット | exit-code 決定 / text フォーマッタ / JUnit 生成 |
| CLI 統合 | ビルド済み `dist/cli.js` を spawn し、exit code 0/1/2/3/4・JSON 出力・JUnit 生成を検証 |
| server 統合 | 認証(401/403)・path traversal・SSE イベント列・履歴ページング・クライアント切断時の完走 |

**ui(vitest + jsdom、10件)**: SSE ストリームパーサー / API クライアントのトークン付与 / 履歴グルーピングの純関数

## 開発コマンド

```bash
pnpm install         # ワークスペース一括
pnpm build:all       # 全ビルド(dist/ + dist/ui)
pnpm test            # root テスト
pnpm --filter @almondoo/klaus-ui test   # ui テスト
pnpm typecheck / pnpm lint              # tsc / biome(リポジトリ全体)
VITE_KLAUS_MOCK=1 pnpm --filter @almondoo/klaus-ui dev   # UI をモックで開発
```
