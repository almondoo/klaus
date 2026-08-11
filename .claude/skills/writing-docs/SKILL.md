---
name: writing-docs
description: klaus のドキュメント(docs/ 配下の VitePress サイトと README.md / README.ja.md)を書く・変更するときの規約とチェックリスト。docs のページ追加・修正、README の更新、ja/en 翻訳の同期、sidebar や目次(config.mts / index.md)の変更、troubleshooting 項目の追加、新機能実装に伴うドキュメント追記のいずれでも必ずこのスキルを使うこと。ユーザーが「ドキュメント」「docs」「README」「翻訳」「ガイド」に言及したら、明示的な依頼がなくても参照する。
---

# klaus ドキュメントの書き方

klaus の docs は VitePress 製の公開サイト(en がルートロケール、ja が `/ja/`)と README の2層構成。このスキルは 2026-08 に一次ソース検証済みのベストプラクティス(Diátaxis、VitePress i18n、Hurl/Vitest 等の実サイト構成)を klaus に適用した際の決定事項をまとめたもの。ここから外れる変更をする場合は、その理由をユーザーに説明して合意を取る。

## 配置と役割分担

| 場所 | 役割 | 公開 |
|---|---|---|
| `docs/guide/*.md` | ユーザー向けガイド(en、正) | 公開サイト |
| `docs/ja/guide/*.md` | 上記の日本語ミラー | 公開サイト |
| `docs/index.md` / `docs/ja/index.md` | トップ目次。**全ガイドページ**を漏れなく列挙する | 公開サイト |
| `docs/dev/**` | 開発者向け内部ドキュメント | 非公開(`srcExclude`) |
| `docs/en/dev/**` | dev の英訳(GitHub 閲覧用) | 非公開 |
| `README.md` / `README.ja.md` | ピッチ+インストール+クイックスタート+CLI 概要+docs へのリンク集 | GitHub / npm |

README には docs/guide と重複する詳説(オプション全列挙、テンプレート構文、アサーション一覧、プロトコル別の書式など)を書かない。詳細は docs の該当ページへのリンクで誘導する。README の Quick Start と Exit code 表は価値の中核なので維持する。理由: 重複はドリフトの温床で、実際に過去の README は docs と食い違っていた。

## ページ種別を混ぜない(Diátaxis)

各ページは1種別に寄せる。現状の分類: tutorial = getting-started / how-to = generate, record-replay, ui, agent-skill / reference = cli, flow-definition, config, history / troubleshooting = troubleshooting。

- **チュートリアル**では説明を最小化し、各ステップで見える結果を示す。選択肢や代替手段は書かない(how-to の領分)。
- **リファレンス**は中立・記述的に。手順やベストプラクティスの意見を混ぜない。**構造は製品の構造をミラーする**: `cli.md` の節順は `src/cli/index.ts` のコマンド登録順に従う(例外: `generate` は専用ページ `guide/generate.md` に詳細があるため cli.md には節を作らず、冒頭の列挙とリンクのみ)。`flow-definition.md` もスキーマの構造(request → use → capture → assert)に概ね従うが、SSE / WebSocket はスキーマのフィールド順ではなく概念的な近さ(SSE は request 亜種として先)で並べている — 機械的な1:1ミラーを強制せず、順序を変える場合は理由を持つ。コマンドやスキーマを変えたらドキュメントの順序も追従させる。
- 新しいページを作るときは、まずどの種別かを決めてから書く。

## 事実は必ずソースコードで裏取りする

エラーメッセージ・デフォルト値・exit code・挙動の記述は、書く前に `src/` の該当箇所を確認する。もっともらしい推測で書かない。理由: レビューで実際に「エラーメッセージの書式違い」「`klaus validate` の挙動誤記」が検出された実績がある。

- troubleshooting の項目は「症状(実際のエラーメッセージの引用)→ 原因 → 対処」の3部形式。メッセージの引用コードブロックは en/ja で byte-identical にする(翻訳しない)。
- 根拠が取れない項目は書かない。項目数を水増ししない。

## ja/en ミラーの規則

- 見出し構成(h1〜h3)は en/ja で完全一致させる。片方だけの節を作らない。
- en を書いて(または変更して)から ja を同一構成でミラーする。両方を同じコミットに含める。
- リンクは locale を揃える: en ページ・README.md からは `/guide/...`(サイト URL は `https://almondoo.github.io/klaus/guide/...`)、ja ページ・README.ja.md からは `/ja/guide/...`。
- README.md ⇔ README.ja.md も見出し構成を完全一致させる。

## 新規ページ追加のチェックリスト

1ページ追加すると更新箇所は最低5ファイル、通常は README も含めて7ファイル。漏れやすいので順に確認する:

1. `docs/guide/<name>.md`(en 本文)
2. `docs/ja/guide/<name>.md`(ja ミラー)
3. `docs/.vitepress/config.mts` の sidebar — **en / ja 両 locale** の既存グループ配列に追加する。en は Getting Started / Guides / Reference、ja は対応する「はじめる / ガイド / リファレンス」(ラベル文字列が locale ごとに異なる)。新しいグループを作らない・英語ラベルを ja 側に混ぜない
4. `docs/index.md` と `docs/ja/index.md` の目次に追加
5. README.md / README.ja.md の Documentation 節にもリンクを追加(全ガイドページを列挙する方針。省略する場合は理由を明確にする)

## 体裁

- frontmatter は使わない。ファイルは `# タイトル` で始める(既存全ページの慣習)。
- 絵文字禁止。
- 本文のトーン・表組み・コードブロックの使い方は既存の近い種別のページに合わせる。
- Vue のテンプレート補間と衝突する `{{...}}` をインラインで書くときは `<code v-pre>{{var}}</code>` を使う(troubleshooting.md に実例あり)。

## 変更後の検証

```bash
CI=true pnpm docs:build   # dead link 検出を含む。失敗したら直すまで完了としない
git status --short -- package.json pnpm-lock.yaml ui/package.json   # 差分が出ていないこと
```

- 新設・変更したページ間リンク(日本語見出しアンカー含む)は docs:build が解決を検証する。README のサイト URL リンクは build 対象外なので、対応する `docs/guide/*.md` の実在を手で確認する。
- `docs/public/schema/*.json` は gitignore されたビルド生成物で、docs:build は欠落を検出しない(本番デプロイは `pnpm build && pnpm build:schema:docs` を先に実行する)。ドキュメントが参照する JSON Schema のキーを変える変更をしたら、この2コマンドで再生成してから内容を確認する。
- コミットは `docs:` prefix + 日本語本文(Conventional Commits、プロジェクト規約)。
