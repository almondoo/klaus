import { defineConfig } from "vitepress";
import llmstxt from "vitepress-plugin-llms";

// klaus ドキュメントサイトの VitePress 設定。
// サイトのソースは docs/ のみ(ui/docs/ 配下は GitHub 上の絶対 URL でリンクする)。
// 多言語化: root = 英語(デフォルト)、/ja/ = 日本語。
// https://vitepress.dev/guide/i18n の locales 構成に従い、
// ロケール間で共通のサイト設定は最上位に、ロケール固有の themeConfig は各ロケールの
// エントリ配下に置く。
// 開発者向けページ(docs/dev/**, docs/en/dev/**)は公開サイトに載せない
// (nav・sidebar から除外し、srcExclude でビルド対象からも除外する)。
export default defineConfig({
  // pnpm-workspace.yaml の overrides で esbuild を 0.28.1(セキュリティ修正版)に固定しているため、
  // VitePress 既定の legacy ブラウザターゲット (chrome87 等) 向け destructuring ダウンレベル変換に
  // 非対応となりビルドが失敗する。ドキュメントサイトの対象ブラウザは新しいもので十分なため
  // esbuild のトランスパイル対象を esnext に引き上げてこの非互換を回避する
  vite: {
    build: {
      target: "esnext",
    },
    plugins: [
      // llms.txt / llms-full.txt を生成する(issue #48)。
      // README の推奨に従いエージェント向けドキュメントは英語ユーザー向けページのみを対象にする。
      // ignoreFiles で ja 側ページ(/ja/**)・非公開の dev ページ(dev/**, en/dev/**)を除外し、
      // srcDir (docs/) 基準の相対パスを維持することで正しい URL を保つ
      llmstxt({
        ignoreFiles: ["ja/**", "dev/**", "en/**"],
        // GitHub Pages 上の絶対 URL にする(base "/klaus/" は vitepressConfig.base から自動付与される)
        domain: "https://almondoo.github.io",
        // ルートの docs/index.md (en) は description frontmatter を持たないため、
        // 明示指定する
        description:
          "A CLI tool for verifying local HTTP APIs. Request definitions are managed as plain YAML in git, with execution, assertions, and history management.",
      }),
    ],
  },
  title: "klaus",
  // GitHub Pages のプロジェクトサイト (https://almondoo.github.io/klaus/) 用のベースパス
  base: "/klaus/",
  // 開発者向けページ(docs/dev/**)と、ユーザー向けページ移動後に docs/en/ 配下に残る
  // 開発者向けページ(docs/en/dev/**)をビルド対象から除外する
  srcExclude: ["dev/**", "en/**"],

  themeConfig: {
    // ロケール間で共通の設定
    socialLinks: [{ icon: "github", link: "https://github.com/almondoo/klaus" }],
  },

  locales: {
    root: {
      label: "English",
      lang: "en",
      description:
        "A CLI tool for verifying local HTTP APIs. Request definitions are managed as plain YAML in git, with execution, assertions, and history management.",
      themeConfig: {
        nav: [{ text: "Guide", link: "/guide/getting-started" }],

        sidebar: {
          "/guide/": [
            {
              text: "User Guide",
              items: [
                { text: "Getting Started", link: "/guide/getting-started" },
                { text: "CLI Reference", link: "/guide/cli" },
                { text: "Flow Definition Reference", link: "/guide/flow-definition" },
                { text: "Generating Flows from OpenAPI", link: "/guide/generate" },
                { text: "record / replay mode", link: "/guide/record-replay" },
                {
                  text: "Default CLI options (klaus.config.yaml)",
                  link: "/guide/config",
                },
                { text: "Execution History", link: "/guide/history" },
                { text: "localhost UI", link: "/guide/ui" },
                { text: "Agent Skill (Claude Code / Codex)", link: "/guide/agent-skill" },
              ],
            },
          ],
        },
      },
    },

    ja: {
      label: "日本語",
      lang: "ja",
      link: "/ja/",
      description:
        "ローカル HTTP API を CLI から検証するツール。リクエスト定義を素の YAML で git 管理し、実行・アサーション・履歴管理を行う。",
      themeConfig: {
        nav: [{ text: "ガイド", link: "/ja/guide/getting-started" }],

        sidebar: {
          "/ja/guide/": [
            {
              text: "利用者向けガイド",
              items: [
                { text: "Getting Started", link: "/ja/guide/getting-started" },
                { text: "CLI リファレンス", link: "/ja/guide/cli" },
                { text: "フロー定義リファレンス", link: "/ja/guide/flow-definition" },
                { text: "OpenAPI からのフロー生成", link: "/ja/guide/generate" },
                { text: "record / replay モード", link: "/ja/guide/record-replay" },
                { text: "CLI オプションの既定値(klaus.config.yaml)", link: "/ja/guide/config" },
                { text: "実行履歴", link: "/ja/guide/history" },
                { text: "localhost UI", link: "/ja/guide/ui" },
                { text: "Agent Skill(Claude Code / Codex)", link: "/ja/guide/agent-skill" },
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
  },
});
