/**
 * createStaticHandler(routes/static.ts) の単体テスト。
 * サーバー全体(startServer)は dist/ui を staticDir 固定で使うため、
 * ここでは Hono アプリに直接ハンドラをマウントし、任意の staticDir で検証する。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStaticHandler } from "../../src/server/routes/static.js";

const tmpRoot = join(process.cwd(), "tmp");

/** createStaticHandler を "*" にマウントしただけの検証用アプリを作る */
function buildApp(staticDir: string): Hono {
  const app = new Hono();
  app.get("*", createStaticHandler(staticDir));
  return app;
}

describe("createStaticHandler", () => {
  let staticDir: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    staticDir = await mkdtemp(join(tmpRoot, "klaus-static-"));
    await writeFile(join(staticDir, "index.html"), "<html>index</html>", "utf-8");
    await mkdir(join(staticDir, "assets"), { recursive: true });
    await writeFile(join(staticDir, "assets", "app.js"), "console.log('app')", "utf-8");
  });

  afterEach(async () => {
    await rm(staticDir, { recursive: true, force: true });
  });

  it("拡張子に応じた Content-Type で実ファイルを返す", async () => {
    const res = await buildApp(staticDir).request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await res.text()).toBe("console.log('app')");
  });

  it("未知のパスは index.html にフォールバックする(SPA クライアントサイドルーティング)", async () => {
    const res = await buildApp(staticDir).request("/some/client/route");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<html>index</html>");
  });

  it("dist/ui が未ビルド(index.html が無い)場合は 503 を返す", async () => {
    const emptyDir = await mkdtemp(join(tmpRoot, "klaus-static-empty-"));
    try {
      const res = await buildApp(emptyDir).request("/");
      expect(res.status).toBe(503);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("path traversal を試みても staticDir 外のファイルは配信されず index.html にフォールバックする", async () => {
    // URL の "/../" はブラウザ・fetch の URL 正規化で除去されてしまうため、
    // %2f(エンコードされた "/")を使い、decodeURIComponent 後に初めて ".." が現れる経路を再現する。
    // ("/..%2fetc/passwd" -> url.pathname はそのまま維持され、decode 後に "/../etc/passwd" になる)
    const parentDir = await mkdtemp(join(tmpRoot, "klaus-static-traversal-"));
    const appDir = join(parentDir, "app");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "index.html"), "<html>index</html>", "utf-8");
    await mkdir(join(parentDir, "etc"), { recursive: true });
    // staticDir(appDir) の外側、正規化後の到達先に実ファイルを置き、漏洩しないことを確認する
    await writeFile(join(parentDir, "etc", "passwd"), "SECRET_CONTENT", "utf-8");

    try {
      const res = await buildApp(appDir).request("/..%2fetc/passwd");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const text = await res.text();
      expect(text).toBe("<html>index</html>");
      expect(text).not.toContain("SECRET_CONTENT");
    } finally {
      await rm(parentDir, { recursive: true, force: true });
    }
  });
});
