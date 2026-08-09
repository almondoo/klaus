# klaus プロジェクト設定

klaus は YAML でリクエストフローを定義・実行する API 検証 CLI(+ localhost Web UI)。構成: `src/core/`(実行エンジン)→ `src/cli/` / `src/server/`(利用層)、`ui/`(React SPA、core とは型のみ共有)、`tests/`(vitest)、`docs/`(VitePress、ja/en ミラー)。

依存方向: `src/core` は他層に依存しない。`ui` は core を runtime import しない(型共有のみ)。詳細は docs/dev/architecture.md。

## 検証

実装後は毎回、以下の検証ガイドに従うこと。

@../docs/dev/verification.md

注意: リポジトリ直下の `VERIFICATION.md` は別物(`make verify` 用の Docker 手動検証手順)。実装後の検証はこのガイド(docs/dev/verification.md)に従う。

## 規約

- コミット: Conventional Commits 形式の prefix(feat/fix/build/test/docs/chore/style)+ 日本語本文。
- ブランチ: develop で開発し、PR で main にマージ。CI は PR と develop への push で実行。

## 依存関係の固定

- TypeScript は 5.x に意図的に固定(tsup の d.ts 生成が TS6+ 未対応。dependabot も major を ignore 済み)。バージョンアップを提案しない。
- `pnpm-workspace.yaml` の esbuild override(脆弱性対応の固定)を依存更新時に外さない。
