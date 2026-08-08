import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// klaus server は既定で 127.0.0.1:4001 で待ち受ける(KLAUS_SERVER_PORT で変更可能)
const serverPort = process.env.KLAUS_SERVER_PORT ?? "4001";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    // klaus server(dist/server.js)が同一オリジンで配信する静的ファイルの出力先
    outDir: "../dist/ui",
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    css: false,
  },
});
