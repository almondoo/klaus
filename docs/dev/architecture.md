# アーキテクチャ

開発者向けの構成ガイド。設計の背景は [requirements.md](requirements.md)、UI の設計意図は [ui-design.md](ui-design.md) を参照。

## パッケージ構成と依存方向

単一 npm パッケージ(`@almondoo/klaus`)+ ビルド時専用の ui ワークスペース。

```
src/
  core/     # 実行エンジン(CLI 非依存ライブラリ)。他層への依存なし
  cli/      # commander の薄い皮。core を import
  server/   # klaus ui の API サーバー(Hono)。core を import
  mcp/      # klaus mcp の MCP サーバー(stdio)。core を import。cli / server と並ぶ第三の利用層
ui/         # Vite + React SPA(private ワークスペース)。core への runtime 依存なし
```

**守るべきルール**:

- 実行・アサーション・履歴の全ロジックは `src/core` に置く。cli / server / mcp はそれを呼ぶだけで、**再実装しない**
- `src/mcp` は core に依存し、`src/core` は `src/mcp` を import しない。mcp は、`src/server` / `src/cli` にある **Hono・commander・stdout に依存しない**ヘルパー(`listFlows`・`listEnvironments`・`resolveWithinCwd`・`promoteHistoryToFile`・`acceptPendingSnapshot`・`loadCliConfig`・`detectActor` など)だけを import してよい。`klaus ui` と `klaus mcp` が共有する書き込みの規則(承認待ちの照合・保護環境の拒否・出力先の許可リスト・新規ファイルのみ)は、そうした Hono 非依存の関数に置き、ルート側(`src/server/routes/*`)は結果を HTTP の応答に写すだけにする
- MCP は CLI より厳しく、エージェントが操作する経路として扱う: `allowProtected` を渡さず(`EntryPoint` は `"mcp"`)、guard は `klaus.config.yaml` からのみ(ツール呼び出しごとに読み直す)、出力のマスクと履歴の記録は常にオン、`--no-mask` のような緩める手段を持たない。標準出力はプロトコル専用で、診断はすべて標準エラーへ出す
- core は commander・プロセス終了・stdout など CLI 的関心を持ち込まない
- ui(ブラウザ)は core を runtime import しない。server の HTTP API 経由のみ。型共有は `src/core/types.ts` からの **type-only import**(ビルド時に消える)
- HTTP / WebSocket の接続は undici に委譲する。リダイレクトは各ホップで安全柵を再判定する必要があるため core(`http-session.ts`)で 1 ホップずつ処理する。proxy・TLS は設定ファイル由来のオプションだけから設定する(フローからは設定できない)

## src/core の内部構成

| モジュール | 責務 | 純粋 / I/O |
|---|---|---|
| `schema.ts` | zod スキーマ(フロー / 環境ファイル)、排他ルール検証 | 純粋 |
| `loader.ts` | YAML 読み込み → zod 検証 → ParseError | I/O |
| `env.ts` | `environments/<name>.yaml` の解決 | I/O |
| `template.ts` | <code v-pre>{{...}}</code> 展開・テンプレート関数 | 純粋 |
| `http.ts` | undici ラッパー(計測・JSON 判定・タイムアウト) | I/O |
| `http-session.ts` / `cookie-jar.ts` | 実行単位の HTTP クライアント(proxy・TLS・リダイレクトのホップ処理・cookie jar) | I/O |
| `sse.ts` | SSE 受信と上限打ち切り(eventsource-parser) | I/O |
| `ws.ts` | WebSocket 接続・送受信・上限打ち切り(undici WebSocket) | I/O |
| `assert.ts` | 全アサーション評価(例外を投げない) | 純粋 |
| `runner.ts` | ステップ順次実行・キャプチャ連鎖・skip 制御・status 集約 | orchestration |
| `history.ts` | 履歴 JSONL 追記(versioned スキーマ) | I/O |
| `cassette.ts` | record/replay モードのカセット記録・照合 | I/O |
| `discovery.ts` | フロー定義 YAML の探索(server と CLI の共通ロジック) | I/O |
| `history-query.ts` | 履歴の読み出し・フィルタ・ページング(server と CLI が共用) | I/O |
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
  allowProtected?: boolean;     // $protected: true な環境への実行を許可するか(既定 false)
  runId?: string;
  history?: boolean | ((entry: HistoryEntry) => void | Promise<void>);  // false で無効化 / 関数でカスタム sink
  onStepStart?: (ctx: { flow, file, step }) => void | Promise<void>;
  onStepComplete?: (ctx: { flow, file, result: StepResult }) => void | Promise<void>;
  onWarning?: (message: string) => void;   // 履歴書き込み失敗等の非致命的警告
  onSecrets?: (secrets: readonly string[]) => void;  // ステップが新規に解決した secrets の通知(履歴マスクとは別経路)
  recording?: { mode: "record" | "replay"; dir: string };  // record/replay モードのカセット設定
}
```

- `onStepStart` / `onStepComplete` は CLI のインクリメンタル text 出力と、server の SSE ライブ配信の両方が使う(skipped ステップにも発火する)
- エラー型と exit code の対応: `ParseError` → 2 / `RuntimeError` → 3(接続不能・タイムアウト・テンプレート未解決・キャプチャ失敗)。アサーション失敗は例外ではなく `StepResult` のデータで表現され CLI 層で 4 に変換される
- `runFlows` は `ParseError` を捕捉しない(呼び出し側が exit 2 にマップする契約)

## src/mcp の内部構成

| ファイル | 責務 |
|---|---|
| `tools.ts` | 12 個のツールの定義(名前・説明・zod の入力スキーマ・注釈・ハンドラ)。MCP の SDK に依存せず、`(args, ctx) => ToolOutcome` の純粋な非同期関数として単体でテストできる。ctx は `{ cwd, readOnly, clientName? }` |
| `result.ts` | `ToolOutcome` / `ToolError` と、結果の JSON への直列化。256 KiB を超える場合は巨大な文字列・`body` を、`klaus_history_show` の `step` / `path` / `offset` / `length` での読み方を示す印に置き換えて、有効な JSON のまま収める |
| `queue.ts` | 送信・書き込みを伴うツール(`klaus_run_flow` / `klaus_request` / `klaus_promote` / `klaus_snapshot_accept`)を 1 つずつ実行する、プロセス内の直列キュー。終了時は `close()` で、まだ開始していない呼び出しを拒否する(実行中の呼び出しは中断も待機もしない) |
| `server.ts` | SDK(`McpServer` + `StdioServerTransport`)への登録、`isError` への写し替え、予期しない例外の標準エラーへの出力、接続が閉じるまでの待機 |

`src/cli/mcp.ts` の `registerMcpCommand` が `klaus mcp [--read-only]` を登録する。`--read-only` では書き込みツール(`klaus_promote` / `klaus_snapshot_accept`)を登録しない。履歴の actor は、kind を常に `agent` とし、name を「`initialize` のクライアント名 > 環境変数のマーカー(`CLAUDECODE` / `AI_AGENT`)> `mcp`」の順で決める。

## ビルド

- **tsup で5エントリ**: `dist/index.js`(ライブラリ、d.ts 付き)/ `dist/cli.js`(shebang 付き bin)/ `dist/server.js`(`klaus ui` 時に dynamic import される)/ `dist/openapi-worker.js`(OpenAPI のスキーマ検証をワーカースレッドで行う。`files` に含める)/ `dist/schema-gen.js`(スキーマ JSON 生成用のビルド時専用。`files` には含めない)
- **ui は Vite** で `dist/ui/` に出力(`ui/vite.config.ts` の outDir)
- `pnpm build:all` = `pnpm clean` → `pnpm build`(tsup)→ `pnpm build:ui`(Vite)
- **clean の役割分担**: tsup 側は `clean: false` にしてある。tsup の clean は outDir 全体を消すため、有効にすると Vite が出力した `dist/ui` まで巻き添えで消え、`pnpm build` / `pnpm test` の後に `klaus ui` が 503 になるからである。その代わり、エントリを削除・リネームした際に古い成果物が `dist/` に残り `files: ["dist"]` 経由で publish に同梱される危険があるため、**リリース用のフルビルド `build:all` では `scripts/clean.mjs` で `dist/` を空にしてから**ビルドし直す。開発時の `pnpm build` 単体は clean せず、`dist/ui` を保持する
- `src/cli/ui.ts` は server モジュールを実行時パス組み立てで dynamic import しており、`klaus run` の起動時間に server / Hono のロードコストが乗らない
- `klaus mcp` の SDK(`@modelcontextprotocol/server` と `@modelcontextprotocol/core`。devDependency)は、他の実行時依存と同じく `noExternal` で `dist/cli.js` にバンドルし、利用者に実行時のインストールを要求しない。`src/cli/mcp.ts` が `../mcp/server.js` を dynamic import するので、SDK のモジュールは `klaus mcp` のときだけ初期化され、他のコマンドの起動時間に影響しない。dynamic import をコード分割で別チャンクのファイルにすると `files`(`dist/cli.js` のみ)から欠けるため、cli のビルドは `splitting: false` で 1 ファイルに収める

## テスト構成

「テストは過不足なく」(仕様のふるまい単位でカバーし、実装詳細への張り付き・重複・水増しをしない)が方針。

**root(vitest、tests/、71ファイル1564件)**

| 種類 | 対象 |
|---|---|
| 純粋ユニット | schema / loader / template / assert / env |
| ローカルサーバー統合 | http / sse(node:http)、ws(ws パッケージ)、graphql、runner(キャプチャ連鎖・skip・進捗コールバック・履歴)|
| CLI ユニット | exit-code 決定 / text フォーマッタ / JUnit 生成 |
| CLI 統合 | ビルド済み `dist/cli.js` を spawn し、exit code 0/1/2/3/4・JSON 出力・JUnit 生成を検証 |
| server 統合 | 認証(401/403)・path traversal・SSE イベント列・履歴ページング・クライアント切断時の完走 |
| MCP ツール | `tests/mcp/`: ローカル fixture に対する各ツールのハンドラ(安全柵の拒否・マスク・書き込みの規則・サイズ上限)。プロトコルは `tests/cli/integration.test.ts` がビルド済みの `dist/cli.js mcp` に JSON-RPC を話して検証する |

**ui(vitest + jsdom、16ファイル97件)**: SSE ストリームパーサー / API クライアントのトークン付与 / フック / 履歴グルーピングなどのロジック層

## 開発コマンド

```bash
pnpm install         # ワークスペース一括
pnpm build:all       # 全ビルド(dist/ + dist/ui)
pnpm test            # root テスト
pnpm --filter @almondoo/klaus-ui test   # ui テスト
pnpm typecheck / pnpm lint              # tsc / biome(リポジトリ全体)
VITE_KLAUS_MOCK=1 pnpm --filter @almondoo/klaus-ui dev   # UI をモックで開発
```
