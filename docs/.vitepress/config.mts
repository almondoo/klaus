import { defineConfig } from 'vitepress'

// klaus ドキュメントサイトの VitePress 設定。
// サイトのソースは docs/ のみ(ui/docs/ 配下は GitHub 上の絶対 URL でリンクする)。
export default defineConfig({
  lang: 'ja',
  title: 'klaus',
  description:
    'ローカル HTTP API を CLI から検証するツール。リクエスト定義を素の YAML で git 管理し、実行・アサーション・履歴管理を行う。',
  // GitHub Pages のプロジェクトサイト (https://almondoo.github.io/klaus/) 用のベースパス
  base: '/klaus/',

  themeConfig: {
    nav: [
      { text: 'ガイド', link: '/guide/getting-started' },
      { text: '開発者向け', link: '/dev/architecture' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: '利用者向けガイド',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'CLI リファレンス', link: '/guide/cli' },
            { text: 'フロー定義リファレンス', link: '/guide/flow-definition' },
            { text: '実行履歴', link: '/guide/history' },
            { text: 'localhost UI', link: '/guide/ui' },
          ],
        },
      ],
      '/dev/': [
        {
          text: '現状の資料(実装を反映)',
          items: [
            { text: 'アーキテクチャ', link: '/dev/architecture' },
            { text: '変更履歴', link: '/dev/changelog' },
            { text: '改善提案', link: '/dev/improvement-proposals' },
            {
              text: 'klaus ui — HTTP API と内部構成',
              link: '/dev/ui-api',
            },
          ],
        },
        {
          text: '設計時の記録(実装と乖離あり)',
          items: [
            { text: '実装要件', link: '/dev/requirements' },
            { text: 'UI アーキテクチャ設計', link: '/dev/ui-design' },
            { text: 'UI ビジュアル / UX 設計', link: '/dev/ui-ux-design' },
            {
              text: 'デザインシステム',
              link: '/dev/design-system/klaus/MASTER',
            },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/almondoo/klaus' },
    ],

    outline: {
      label: 'このページの目次',
    },
    docFooter: {
      prev: '前のページ',
      next: '次のページ',
    },
    darkModeSwitchLabel: 'アピアランス',
    sidebarMenuLabel: 'メニュー',
    returnToTopLabel: 'トップへ戻る',
    langMenuLabel: '言語を変更',
    skipToContentLabel: 'メインコンテンツへスキップ',
  },
})
