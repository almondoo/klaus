import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/core/index.ts" },
    format: ["esm"],
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
  },
  {
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    target: "node22",
    outDir: "dist",
    banner: {
      js: "#!/usr/bin/env node",
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
  },
]);
