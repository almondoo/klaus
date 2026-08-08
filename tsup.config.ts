import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/core/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node20",
    outDir: "dist",
  },
  {
    entry: { cli: "src/cli/index.ts" },
    format: ["esm"],
    dts: false,
    sourcemap: true,
    clean: false,
    target: "node20",
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
    target: "node20",
    outDir: "dist",
  },
]);
