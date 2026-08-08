import { defineConfig } from "vitepress";

// klaus ドキュメントサイトの VitePress 設定。
// サイトのソースは docs/ のみ(ui/docs/ 配下は GitHub 上の絶対 URL でリンクする)。
// 多言語化: root = 日本語(デフォルト)、/en/ = 英語。
// https://vitepress.dev/guide/i18n の locales 構成に従い、
// ロケール間で共通のサイト設定は最上位に、ロケール固有の themeConfig は各ロケールの
// エントリ配下に置く。
export default defineConfig({
  // pnpm-workspace.yaml の overrides で esbuild を 0.28.1(セキュリティ修正版)に固定しているため、
  // VitePress 既定の legacy ブラウザターゲット (chrome87 等) 向け destructuring ダウンレベル変換に
  // 非対応となりビルドが失敗する。ドキュメントサイトの対象ブラウザは新しいもので十分なため
  // esbuild のトランスパイル対象を esnext に引き上げてこの非互換を回避する
  vite: {
    build: {
      target: "esnext",
    },
  },
  title: "klaus",
  // GitHub Pages のプロジェクトサイト (https://almondoo.github.io/klaus/) 用のベースパス
  base: "/klaus/",

  themeConfig: {
    // ロケール間で共通の設定
    socialLinks: [{ icon: "github", link: "https://github.com/almondoo/klaus" }],
  },

  locales: {
    root: {
      label: "日本語",
      lang: "ja",
      description:
        "ローカル HTTP API を CLI から検証するツール。リクエスト定義を素の YAML で git 管理し、実行・アサーション・履歴管理を行う。",
      themeConfig: {
        nav: [
          { text: "ガイド", link: "/guide/getting-started" },
          { text: "開発者向け", link: "/dev/architecture" },
        ],

        sidebar: {
          "/guide/": [
            {
              text: "利用者向けガイド",
              items: [
                { text: "Getting Started", link: "/guide/getting-started" },
                { text: "CLI リファレンス", link: "/guide/cli" },
                { text: "フロー定義リファレンス", link: "/guide/flow-definition" },
                { text: "実行履歴", link: "/guide/history" },
                { text: "localhost UI", link: "/guide/ui" },
              ],
            },
          ],
          "/dev/": [
            {
              text: "現状の資料(実装を反映)",
              items: [
                { text: "アーキテクチャ", link: "/dev/architecture" },
                { text: "変更履歴", link: "/dev/changelog" },
                { text: "改善提案", link: "/dev/improvement-proposals" },
                {
                  text: "klaus ui — HTTP API と内部構成",
                  link: "/dev/ui-api",
                },
              ],
            },
            {
              text: "設計時の記録(実装と乖離あり)",
              items: [
                { text: "実装要件", link: "/dev/requirements" },
                { text: "UI アーキテクチャ設計", link: "/dev/ui-design" },
                { text: "UI ビジュアル / UX 設計", link: "/dev/ui-ux-design" },
                {
                  text: "デザインシステム",
                  link: "/dev/design-system/klaus/MASTER",
                },
              ],
            },
          ],
        },

        outline: {
          label: "このページの目次",
        },
        docFooter: {
          prev: "前のページ",
          next: "次のページ",
        },
        darkModeSwitchLabel: "アピアランス",
        sidebarMenuLabel: "メニュー",
        returnToTopLabel: "トップへ戻る",
        langMenuLabel: "言語を変更",
        skipToContentLabel: "メインコンテンツへスキップ",
      },
    },

    en: {
      label: "English",
      lang: "en",
      link: "/en/",
      description:
        "A CLI tool for verifying local HTTP APIs. Request definitions are managed as plain YAML in git, with execution, assertions, and history management.",
      themeConfig: {
        nav: [
          { text: "Guide", link: "/en/guide/getting-started" },
          { text: "Development", link: "/en/dev/architecture" },
        ],

        sidebar: {
          "/en/guide/": [
            {
              text: "User Guide",
              items: [
                { text: "Getting Started", link: "/en/guide/getting-started" },
                { text: "CLI Reference", link: "/en/guide/cli" },
                { text: "Flow Definition Reference", link: "/en/guide/flow-definition" },
                { text: "Execution History", link: "/en/guide/history" },
                { text: "localhost UI", link: "/en/guide/ui" },
              ],
            },
          ],
          "/en/dev/": [
            {
              text: "Current references",
              items: [
                { text: "Architecture", link: "/en/dev/architecture" },
                { text: "Changelog", link: "/en/dev/changelog" },
                { text: "Improvement Proposals", link: "/en/dev/improvement-proposals" },
                {
                  text: "klaus ui — HTTP API and Internal Structure",
                  link: "/en/dev/ui-api",
                },
              ],
            },
            {
              text: "Design records (may diverge from implementation)",
              items: [
                { text: "Requirements", link: "/en/dev/requirements" },
                { text: "UI Architecture Design", link: "/en/dev/ui-design" },
                { text: "UI Visual / UX Design", link: "/en/dev/ui-ux-design" },
                {
                  text: "Design System",
                  link: "/en/dev/design-system/klaus/MASTER",
                },
              ],
            },
          ],
        },
      },
    },
  },
});
