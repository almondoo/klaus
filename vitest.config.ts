import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**"],
      exclude: ["tests/**", "dist/**", "docs/**", "ui/**", "**/*.config.ts", "**/*.d.ts"],
      // CI で強制する下限。lines 90% がプロジェクトの基準値(README 参照)。
      // 他 3 指標は現状の実測値から僅かに下げた維持ライン(退行検知用)
      thresholds: {
        lines: 90,
        statements: 88,
        functions: 90,
        branches: 82,
      },
    },
  },
});
