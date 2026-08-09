/**
 * dist/ui (Vite ビルド成果物) を同一オリジンで配信する静的ハンドラ。
 * SPA なので未知の GET パスは index.html にフォールバックする(/api/* は対象外)。
 */
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Context } from "hono";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** dist/ui が存在しない・未ビルドの場合に表示する案内文 */
const MISSING_BUILD_MESSAGE = "klaus UI static files not found. Run `pnpm build:all`.";

async function readIfExists(filePath: string): Promise<Buffer | null> {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) return null;
    return await readFile(filePath);
  } catch {
    return null;
  }
}

/** dist/ui 配下の静的ファイルを配信する Hono ハンドラを作る */
export function createStaticHandler(staticDir: string) {
  return async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    const pathname = decodeURIComponent(url.pathname);

    // /api/* の未定義ルートは静的配信の対象外(index.html へフォールバックしない)
    if (pathname.startsWith("/api/")) {
      return c.text("Not Found", 404);
    }

    const indexContent = await readIfExists(join(staticDir, "index.html"));
    if (indexContent === null) {
      return c.text(MISSING_BUILD_MESSAGE, 503);
    }

    if (pathname !== "/") {
      // path traversal 対策: staticDir 配下に正規化解決される場合のみ実ファイルを試す
      const requested = resolve(staticDir, `.${pathname}`);
      const boundary = staticDir.endsWith(sep) ? staticDir : staticDir + sep;
      if (requested === staticDir || requested.startsWith(boundary)) {
        const content = await readIfExists(requested);
        if (content !== null) {
          // Node の Buffer は ArrayBufferLike(SharedArrayBuffer を含み得る)なので、
          // Hono の c.body の型(Uint8Array<ArrayBuffer>)に合わせて素の Uint8Array へ変換する
          return c.body(new Uint8Array(content), 200, {
            "Content-Type": contentTypeFor(requested),
          });
        }
      }
    }

    // 未知のパス(SPA のクライアントサイドルーティング)は index.html にフォールバックする
    return c.body(new Uint8Array(indexContent), 200, {
      "Content-Type": "text/html; charset=utf-8",
    });
  };
}
