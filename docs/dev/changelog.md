# 変更履歴

各リリースで何が変わったかと、**その背景にある判断・踏んだ落とし穴**を記録する。
API の現在の仕様は各リファレンス([CLI](../guide/cli.md) / [フロー定義](../guide/flow-definition.md) / [アーキテクチャ](architecture.md))が正で、ここは「なぜそうなったか」を残す場所。

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

未指定時は従来どおり空きポートを自動選択する。詳細は [CLI リファレンス](../guide/cli.md)。

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
