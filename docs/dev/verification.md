# 実装後の検証ガイド

実装(機能追加・修正)を終えるたびに、このガイドの順で検証する。上から順に軽い検証から重い検証へ進み、途中で失敗したらそこで修正に戻る。

## 1. 基本フロー(全変更共通)

| 順 | コマンド | 対象 |
|---|---|---|
| 1 | `pnpm typecheck` | root(src/ + tests/)の型検査 |
| 2 | `pnpm --filter @almondoo/klaus-ui typecheck` | ui/ を変更した場合 |
| 3 | `pnpm lint` | biome。リポジトリ直下に git worktree(`.claude/worktrees/` 等)がある間は nested root エラーになるため `./node_modules/.bin/biome check src tests ui docs` とパス指定で代替する |
| 4 | `pnpm test` | root の vitest 全件。`tests/cli/integration.test.ts` が内部で `pnpm build` を実行するため dist も同時に検証される |
| 5 | `pnpm --filter @almondoo/klaus-ui test` | ui/ を変更した場合 |
| 6 | `pnpm --filter @almondoo/klaus-ui build` | ui/ を変更した場合(tsc --noEmit + vite build → dist/ui) |

完了条件: 全コマンド成功に加え、変更に対応するテストが存在すること(過不足なく — 水増しも不足も不可)、`package.json` / `pnpm-lock.yaml` に意図しない差分がないこと(`git status --short -- package.json pnpm-lock.yaml ui/package.json`)。

## 2. レイヤー別の追加検証

- **core(src/core/)**: 対応する `tests/<module>.test.ts` を変更・追加する。外部 API に依存するテストは `node:http` のローカル fixture サーバーを使う(`tests/runner.test.ts` の方式)。一時ファイルは OS の /tmp ではなくリポジトリ直下 `tmp/` に `mkdtemp` で作る。
- **server(src/server/)**: `tests/server/server.test.ts` の統合方式(`startServer` + 実 fetch)に追記する。新規エンドポイントは正常系に加えて 400(検証エラー)/ 401(トークン)/ 403(CSRF・path traversal・名前 regex)/ 404 の拒否系を必ず検証する。書き込み系(POST/PUT/DELETE)は CSRF Cookie 要求のテストを含める。
- **cli(src/cli/)**: `tests/cli/` のユニットテスト(コマンド関数直呼び + stdout 捕捉、`init.test.ts` の方式)に加え、exit code・stdout の JSON 形状が変わる変更は `integration.test.ts`(ビルド済み dist/cli.js を spawn)でも検証する。
- **ui(ui/src/)**: vitest はロジック層のみ(コンポーネントテストの慣習なし)。そのため画面の変更は静的検証だけでは不十分で、後述 3 のブラウザ実地確認まで行って完了とする。

## 3. 実動スモーク(画面・CLI 出力に触れる変更、およびリリース前)

ユニット・統合テストが通っていても、ビルド済み成果物の実動確認を行う。

- **CLI**: `tmp/cli-smoke/` 等の作業ディレクトリで、ビルド済み `dist/cli.js` に対して実際のコマンド一連(init → validate → run → history)を実行し、非 TTY での JSON 出力と exit code を確認する。`cd` が使えない実行環境では Node スクリプトから `execFileSync(process.execPath, [cliPath, ...args], { cwd })` で作業ディレクトリを指定する。
- **UI**: 対象ディレクトリを cwd にして `node dist/cli.js ui --port <n> --no-open` を起動し、標準出力のトークン付き URL を Playwright で開いて実地確認する。確認観点: 変更した画面の主要操作が通ること、ブラウザコンソールに error が出ていないこと。
- **fixture**: 外部ネットワークに依存しない。必要な API は `node:http` のローカル fixture(スクリプトは `tmp/` 配下)を起動して使い、終了時に停止する。

## 4. 環境の落とし穴(この repo で実際に踏んだもの)

- 非対話シェルで pnpm が依存状態チェックの確認プロンプトで中断する(`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`)→ `CI=true` を付けて実行する。
- `.claude/worktrees/` が存在する間、`biome check .` は worktree 側の biome.json を nested root として検出し失敗する → パス指定で回避(上記 1-3)。
- 並列作業中の共有 node_modules は pnpm の自動再インストールで壊れることがある → 壊れたら `CI=true pnpm install --frozen-lockfile` で復旧し、lockfile 差分がないことを確認する。
