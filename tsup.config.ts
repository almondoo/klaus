import { defineConfig } from "tsup";

// サプライチェーン対策として実行時依存(9 パッケージ)を dist にバンドルする。
// これにより公開物(npm tarball)が依存パッケージのその後の改変や取り下げの影響を受けなくなる。
// hono はサブパスインポート(hono/streaming)、ajv はサブパスインポート(ajv/dist/2020)が
// あるため正規表現で配下を含めてマッチさせる。
// Node 組み込みモジュールは対象外(esbuild が自動的に external 扱いする)。
const noExternal: (string | RegExp)[] = [
  /^@apidevtools\/swagger-parser$/,
  /^ajv(\/.*)?$/,
  "commander",
  "eventsource-parser",
  /^hono(\/.*)?$/,
  "jsonpath-plus",
  "undici",
  "yaml",
  "zod",
];

// yaml の CJS 実体(dist/index.js が package.json の "node" exports 条件で選ばれる)は
// 内部で require("process") のように Node 組み込みモジュールを CJS require で読み込む。
// ESM 出力ではグローバル require が存在しないため、esbuild が生成する
// フォールバック require シムがそのまま動くとランタイムで
// `Dynamic require of "process" is not supported` になる。
// createRequire ベースの本物の require を banner でモジュール先頭に用意することで解決する。
const requireShim = [
  'import { createRequire } from "module";',
  "const require = createRequire(import.meta.url);",
].join("\n");

export default defineConfig([
  {
    entry: { index: "src/core/index.ts" },
    format: ["esm"],
    // 本来は zod も dependencies から外し dts の resolve オプションで型を
    // インライン化したかったが、実際に試すと生成された .d.ts が
    // `import * as z from './v4/classic/external.cjs'` のように
    // dist 配下に存在しない zod 内部の相対パスを指すだけの壊れた出力になった
    // (rollup-plugin-dts が zod v4 の内部構造を正しくフラット化できていない)。
    // そのため zod だけは package.json の dependencies に残し、
    // 型は素直に "zod" パッケージから解決させる(JS 本体は noExternal で bundle 済み)。
    dts: true,
    sourcemap: true,
    // clean は無効にする。tsup の clean は(配列でグロブを指定しても)outDir 全体を消すため、
    // Vite が出力した dist/ui まで巻き添えで消え、`pnpm build` / `pnpm test` の後に
    // `klaus ui` が 503(静的ファイルなし)になる事故が起きる。
    // tsup の出力(index.js / cli.js / server.js とそのマップ・型定義)は毎回上書きされるので
    // clean 無しでも成果物は正しく更新される。
    clean: false,
    // engines.node を >=22.19.0 に引き上げたのに合わせてビルドターゲットも node22 にする
    target: "node22",
    outDir: "dist",
    noExternal,
    // undici など bundle 対象パッケージが __dirname / __filename を参照するケースに備えたシム。
    shims: true,
    banner: {
      js: requireShim,
    },
  },
  {
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    target: "node22",
    outDir: "dist",
    noExternal,
    shims: true,
    // shebang は Node がファイル先頭 1 行目として認識する必要があるため、
    // require シムより前(banner 文字列の先頭)に置く。
    banner: {
      js: `#!/usr/bin/env node\n${requireShim}`,
    },
  },
  {
    // klaus ui が dynamic import する localhost UI サーバー本体。
    // dist/cli.js から見て同じ dist/ 直下に dist/server.js として出力する(src/cli/ui.ts 参照)。
    entry: { server: "src/server/index.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    target: "node22",
    outDir: "dist",
    noExternal,
    shims: true,
    banner: {
      js: requireShim,
    },
  },
  {
    // `node dist/schema-gen.js` として実行するビルド時専用スクリプト。
    // JSON Schema (dist/schema/*.json、--docs 指定時は docs/public/schema/*.json も)を書き出す
    // (package.json の build:schema スクリプト参照)。ユーザー向け CLI サブコマンドではないため
    // shebang は不要。
    entry: { "schema-gen": "src/cli/schema-gen.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    target: "node22",
    outDir: "dist",
    noExternal,
    shims: true,
    banner: {
      js: requireShim,
    },
  },
]);
