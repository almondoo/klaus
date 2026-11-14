import { describe, expect, it } from "vitest";
import { CookieJar, splitSetCookieHeader } from "../src/core/cookie-jar.js";

const u = (url: string) => new URL(url);

describe("CookieJar", () => {
  it("Domain 属性なしの cookie はホスト限定で、サブドメインや別ホストには送らない", () => {
    const jar = new CookieJar();
    jar.store(u("https://api.example.com/"), ["a=1"]);
    expect(jar.headerFor(u("https://api.example.com/x"))).toBe("a=1");
    expect(jar.headerFor(u("https://example.com/"))).toBeUndefined();
    expect(jar.headerFor(u("https://x.api.example.com/"))).toBeUndefined();
  });

  it("Domain 属性が親ドメインでも、cookie はリクエストホスト限定で保存し、兄弟サブドメインや親には送らない", () => {
    const jar = new CookieJar();
    jar.store(u("https://a.example.com/"), ["p=1; Domain=example.com", "q=1; Domain=.EXAMPLE.com"]);
    expect(jar.headerFor(u("https://a.example.com/"))).toBe("p=1; q=1");
    expect(jar.headerFor(u("https://b.example.com/"))).toBeUndefined();
    expect(jar.headerFor(u("https://example.com/"))).toBeUndefined();
    expect(jar.headerFor(u("https://x.a.example.com/"))).toBeUndefined();
  });

  it("公開サフィックスを Domain に指定しても、同じサフィックス上の別サイトには送らない", () => {
    const jar = new CookieJar();
    jar.store(u("https://a.example.co.uk/"), ["s=1; Domain=co.uk"]);
    jar.store(u("https://evil.github.io/"), ["t=1; Domain=github.io"]);
    expect(jar.headerFor(u("https://a.example.co.uk/"))).toBe("s=1");
    expect(jar.headerFor(u("https://victim.co.uk/"))).toBeUndefined();
    expect(jar.headerFor(u("https://other.example.co.uk/"))).toBeUndefined();
    expect(jar.headerFor(u("https://victim.github.io/"))).toBeUndefined();
  });

  it("Domain がリクエストホストと完全一致なら受け付けるが host-only のまま", () => {
    const jar = new CookieJar();
    jar.store(u("https://a.example.com/"), ["a=1; Domain=a.example.com"]);
    expect(jar.headerFor(u("https://a.example.com/"))).toBe("a=1");
    expect(jar.headerFor(u("https://x.a.example.com/"))).toBeUndefined();
  });

  it("無関係な・子孫の Domain、IP ホストへの別 Domain の cookie は拒否する", () => {
    const jar = new CookieJar();
    jar.store(u("https://api.example.com/"), ["b=1; Domain=other.com"]);
    jar.store(u("https://example.com/"), ["c=1; Domain=api.example.com"]);
    jar.store(u("http://127.0.0.1/"), ["d=1; Domain=0.0.1"]);
    expect(jar.headerFor(u("https://api.example.com/"))).toBeUndefined();
    expect(jar.headerFor(u("https://example.com/"))).toBeUndefined();
    expect(jar.headerFor(u("http://127.0.0.1/"))).toBeUndefined();
  });

  it("Secure cookie は http:// に送らず、http:// のレスポンスからも設定できない", () => {
    const jar = new CookieJar();
    jar.store(u("https://example.com/"), ["s=1; Secure"]);
    expect(jar.headerFor(u("https://example.com/"))).toBe("s=1");
    expect(jar.headerFor(u("http://example.com/"))).toBeUndefined();
    expect(jar.headerFor(u("wss://example.com/"))).toBe("s=1");
    jar.store(u("http://example.org/"), ["t=1; Secure"]);
    expect(jar.headerFor(u("https://example.org/"))).toBeUndefined();
  });

  it("http:// から既存の Secure cookie を上書き・削除できない", () => {
    const jar = new CookieJar();
    jar.store(u("https://example.com/"), ["s=orig; Secure"]);
    jar.store(u("http://example.com/"), ["s=evil"]);
    jar.store(u("http://example.com/"), ["s=x; Max-Age=0"]);
    expect(jar.headerFor(u("https://example.com/"))).toBe("s=orig");
  });

  it("__Host- / __Secure- プレフィックスの制約を守る", () => {
    const jar = new CookieJar();
    jar.store(u("https://example.com/"), [
      "__Host-a=1; Secure; Path=/",
      "__Host-b=1; Secure; Path=/; Domain=example.com",
      "__Host-c=1; Secure; Path=/x",
      "__Secure-d=1",
    ]);
    expect(jar.headerFor(u("https://example.com/"))).toBe("__Host-a=1");
  });

  it("パスの一致は境界で判定し、長いパスを先に並べる", () => {
    const jar = new CookieJar();
    jar.store(u("https://example.com/"), ["a=1; Path=/api", "b=2; Path=/api/v1", "c=3; Path=/"]);
    expect(jar.headerFor(u("https://example.com/api/v1/x"))).toBe("b=2; a=1; c=3");
    expect(jar.headerFor(u("https://example.com/apix"))).toBe("c=3");
  });

  it("Path 省略時はリクエストパスのディレクトリを既定にする", () => {
    const jar = new CookieJar();
    jar.store(u("https://example.com/app/login"), ["a=1"]);
    expect(jar.headerFor(u("https://example.com/app/x"))).toBe("a=1");
    expect(jar.headerFor(u("https://example.com/other"))).toBeUndefined();
  });

  it("Max-Age / Expires で期限切れ・削除を判定する(Max-Age 優先)", () => {
    const jar = new CookieJar();
    const now = Date.parse("2026-01-01T00:00:00Z");
    jar.store(
      u("https://example.com/"),
      ["a=1; Max-Age=10", "b=1; Expires=Thu, 01 Jan 2026 00:00:30 GMT"],
      now,
    );
    expect(jar.headerFor(u("https://example.com/"), now + 5_000)).toBe("a=1; b=1");
    expect(jar.headerFor(u("https://example.com/"), now + 20_000)).toBe("b=1");
    expect(jar.headerFor(u("https://example.com/"), now + 40_000)).toBeUndefined();
    const jar2 = new CookieJar();
    jar2.store(u("https://example.com/"), ["a=1", "b=2"], now);
    jar2.store(u("https://example.com/"), ["b=2; Max-Age=0"], now);
    expect(jar2.headerFor(u("https://example.com/"), now)).toBe("a=1");
  });

  it("同名・同ドメイン・同パスは上書きし、store は値を返す(拒否分も含む)", () => {
    const jar = new CookieJar();
    jar.store(u("https://example.com/"), ["a=1"]);
    const values = jar.store(u("https://example.com/"), ["a=2", "z=rejected; Domain=other.com"]);
    expect(values).toEqual(["2", "rejected"]);
    expect(jar.headerFor(u("https://example.com/"))).toBe("a=2");
    expect(jar.valueFor("a", u("https://example.com/"))).toBe("2");
  });

  it("ws:// は http:// として扱う", () => {
    const jar = new CookieJar();
    jar.store(u("http://example.com/"), ["a=1"]);
    expect(jar.headerFor(u("ws://example.com/"))).toBe("a=1");
  });
});

describe("splitSetCookieHeader", () => {
  it("Expires のカンマでは分割せず、cookie の区切りのカンマだけで分割する", () => {
    expect(
      splitSetCookieHeader("a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, b=2; HttpOnly"),
    ).toEqual(["a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/", "b=2; HttpOnly"]);
  });
});
