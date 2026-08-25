// バンドルサイズを抑えるため latin / latin-ext サブセットのみを読み込む
// (klaus の UI テキストは日本語ラベル以外は ASCII のデータ・コードが中心で、
//  Fira Code / Fira Sans はそもそも CJK グリフを持たないため日本語はブラウザのフォールバックフォントで表示される)
import "@fontsource/fira-code/latin-400.css";
import "@fontsource/fira-code/latin-500.css";
import "@fontsource/fira-code/latin-600.css";
import "@fontsource/fira-code/latin-ext-400.css";
import "@fontsource/fira-code/latin-ext-500.css";
import "@fontsource/fira-code/latin-ext-600.css";
import "@fontsource/fira-sans/latin-400.css";
import "@fontsource/fira-sans/latin-500.css";
import "@fontsource/fira-sans/latin-600.css";
import "@fontsource/fira-sans/latin-ext-400.css";
import "@fontsource/fira-sans/latin-ext-500.css";
import "@fontsource/fira-sans/latin-ext-600.css";
import "./styles/globals.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) throw new Error("#root element not found");

// localhost API 前提のため retry せず、エラーは即座に画面へ表示する
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false },
    mutations: { retry: false },
  },
});

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
