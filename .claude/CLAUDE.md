# klaus プロジェクト設定

klaus は YAML でリクエストフローを定義・実行する API 検証 CLI(+ localhost Web UI)。構成: `src/core/`(実行エンジン)→ `src/cli/` / `src/server/`(利用層)、`ui/`(React SPA、core とは型のみ共有)、`tests/`(vitest)、`docs/`(VitePress、ja/en ミラー)。

依存方向: `src/core` は他層に依存しない。`ui` は core を runtime import しない(型共有のみ)。詳細は docs/dev/architecture.md。

## 検証

実装後は毎回、以下の検証ガイドに従うこと。

@../docs/dev/verification.md

注意: 手動実行用のコマンドチェックリスト(`make verify` の Docker 手順を含む)は `verify/CHECKLIST.md` にある。実装後の検証はこのガイド(docs/dev/verification.md)に従う。

## 規約

- コミット: Conventional Commits 形式の prefix(feat/fix/build/test/docs/chore/style)+ 日本語本文。
- ブランチ: develop で開発し、PR で main にマージ。CI は PR と develop への push で実行。
- PR 作成時は package.json の version を上げてから PR を作成する(機能追加は minor、修正のみは patch。コミットは `chore: vX.Y.Z` の1行変更。ui/package.json は据え置き)。タグ `vX.Y.Z` はマージ後に main 上で打つ。

## リリース手順

PR を main にマージしたら、以下を最後まで行う。GitHub リリースの作成までがリリースで、タグを打っただけでは完了ではない。

1. main を最新にしてタグを打つ: `git checkout main && git pull origin main && git tag vX.Y.Z && git push origin vX.Y.Z`
2. タグの push で `publish` ワークフロー(`.github/workflows/publish.yml`)が動く。`publish` ジョブは環境の承認待ちで止まるので、承認されて成功するまで確認する。
3. npm に公開されたことを確認する: `npm view @almondoo/klaus dist-tags.latest`(反映に数分かかることがある)。
4. GitHub リリースを作成する。本文は直前のリリースの形式に合わせ(`## 変更内容`、挙動の変化、既知の制約、Full Changelog のリンク)、`tmp/release-vX.Y.Z.md` に書いてから `gh release create vX.Y.Z --title vX.Y.Z --notes-file tmp/release-vX.Y.Z.md` で作成する。作成後に `gh release list` で Latest になっていることを確認する。
5. develop に main を取り込んで push する: `git checkout develop && git merge main && git push origin develop`

## 依存関係の固定

- TypeScript は 5.x に意図的に固定(tsup の d.ts 生成が TS6+ 未対応。dependabot も major を ignore 済み)。バージョンアップを提案しない。
- `pnpm-workspace.yaml` の esbuild override(脆弱性対応の固定)を依存更新時に外さない。
