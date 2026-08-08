/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" のとき fetch を差し替えたモック API 実装(src/api/mock.ts)を使う */
  readonly VITE_KLAUS_MOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
