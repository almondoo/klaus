import { describe, expect, it } from "vitest";
import {
  checkHostAllowed,
  findMethodOverrideHeader,
  isSafeMethod,
  parseAllowedHostEntry,
} from "../src/core/guard.js";

describe("parseAllowedHostEntry", () => {
  it("完全一致のホスト名を小文字化して解釈する", () => {
    expect(parseAllowedHostEntry("API.Example.com")).toEqual({
      host: "api.example.com",
      wildcard: false,
    });
  });

  it("先頭 *. のワイルドカードは基底ドメインを保持する", () => {
    expect(parseAllowedHostEntry("*.example.com")).toEqual({ host: "example.com", wildcard: true });
  });

  it("ポート指定を数値として解釈し、未指定なら port を持たない", () => {
    expect(parseAllowedHostEntry("localhost:3000")).toEqual({
      host: "localhost",
      wildcard: false,
      port: 3000,
    });
    expect(parseAllowedHostEntry("localhost")).not.toHaveProperty("port");
  });

  it("既定ポート(:80 / :443)を明示してもポート指定として保持する(URL 正規化で落とさない)", () => {
    expect(parseAllowedHostEntry("example.com:80")?.port).toBe(80);
    expect(parseAllowedHostEntry("example.com:443")?.port).toBe(443);
  });

  it("角括弧つき IPv6 リテラルを正規化して解釈する(ポート付きも可)", () => {
    expect(parseAllowedHostEntry("[::1]")).toEqual({ host: "[::1]", wildcard: false });
    expect(parseAllowedHostEntry("[0:0:0:0:0:0:0:1]:8080")).toEqual({
      host: "[::1]",
      wildcard: false,
      port: 8080,
    });
  });

  it.each([
    "",
    "*",
    "*.",
    "http://example.com",
    "example.com/path",
    "user@example.com",
    "exa*mple.com",
    "foo.*.example.com",
    "::1",
    "example.com:",
    "example.com:0",
    "example.com:65536",
    "example.com:abc",
    " example.com",
    "*.[::1]",
    "*.127.0.0.1",
  ])("不正な書式 %j は undefined を返す", (entry) => {
    expect(parseAllowedHostEntry(entry)).toBeUndefined();
  });

  it.each([
    ["ラベルが 1 つだけのワイルドカード", ["*.com", "*.localhost", "*.backend:3000"]],
    ["数値だけのホスト", ["0", "2130706433", "1", "4294967296"]],
    [
      "16進・8進・省略形の IPv4",
      ["0x7f.1", "0x7f000001", "0177.0.0.1", "127.1", "127.0.1", "1.2.3"],
    ],
    ["範囲外・先頭ゼロのオクテット", ["256.0.0.1", "01.2.3.4"]],
    ["空ラベル", ["a..b", ".example.com", "example.com.", "*..example.com"]],
    ["パーセントエンコードされたホスト", ["ex%61mple.com", "%65xample.com", "[%3a%3a1]"]],
  ])("URL の正規化の癖でだけ通る書式は拒否する: %s", (_label, entries) => {
    for (const entry of entries) {
      expect(parseAllowedHostEntry(entry), entry).toBeUndefined();
    }
  });

  it("通常のドット区切り IPv4・IPv6・localhost・単一ラベルの内部名・2 ラベル以上のワイルドカードは有効なまま", () => {
    expect(parseAllowedHostEntry("127.0.0.1:8080")).toEqual({
      host: "127.0.0.1",
      wildcard: false,
      port: 8080,
    });
    expect(parseAllowedHostEntry("0.0.0.0")?.host).toBe("0.0.0.0");
    expect(parseAllowedHostEntry("localhost")?.host).toBe("localhost");
    expect(parseAllowedHostEntry("backend")?.host).toBe("backend");
    expect(parseAllowedHostEntry("backend:3000")?.port).toBe(3000);
    expect(parseAllowedHostEntry("[::1]")?.host).toBe("[::1]");
    expect(parseAllowedHostEntry("*.corp.internal")).toEqual({
      host: "corp.internal",
      wildcard: true,
    });
  });
});

describe("checkHostAllowed", () => {
  it("guard または allowedHosts が未指定なら常に許可する(制限なし)", () => {
    expect(checkHostAllowed("https://anything.example/", undefined)).toBeUndefined();
    expect(checkHostAllowed("https://anything.example/", {})).toBeUndefined();
  });

  it("完全一致のホストを許可し、それ以外を拒否する。ホスト名は大文字小文字を区別しない", () => {
    const guard = { allowedHosts: ["api.example.com"] };
    expect(checkHostAllowed("https://api.example.com/v1", guard)).toBeUndefined();
    expect(checkHostAllowed("https://API.EXAMPLE.COM/v1", guard)).toBeUndefined();
    const error = checkHostAllowed("https://evil.example.com/v1", guard);
    expect(error?.message).toContain('host "evil.example.com"');
    expect(error?.message).toContain("guard.allowedHosts");
  });

  it("完全一致のエントリはサブドメインを許可しない", () => {
    expect(
      checkHostAllowed("https://sub.api.example.com/", { allowedHosts: ["api.example.com"] }),
    ).toBeDefined();
  });

  it("*.example.com はサブドメイン(多段を含む)に一致し、基底ドメイン自身や似た名前には一致しない", () => {
    const guard = { allowedHosts: ["*.example.com"] };
    expect(checkHostAllowed("https://api.example.com/", guard)).toBeUndefined();
    expect(checkHostAllowed("https://a.b.example.com/", guard)).toBeUndefined();
    expect(checkHostAllowed("https://example.com/", guard)).toBeDefined();
    expect(checkHostAllowed("https://badexample.com/", guard)).toBeDefined();
    expect(checkHostAllowed("https://example.com.evil.test/", guard)).toBeDefined();
  });

  it("ポート指定のエントリはそのポートのみ、未指定のエントリは任意のポートに一致する", () => {
    expect(
      checkHostAllowed("http://localhost:3000/", { allowedHosts: ["localhost:3000"] }),
    ).toBeUndefined();
    expect(
      checkHostAllowed("http://localhost:4000/", { allowedHosts: ["localhost:3000"] }),
    ).toBeDefined();
    expect(
      checkHostAllowed("http://localhost/", { allowedHosts: ["localhost:3000"] }),
    ).toBeDefined();
    expect(
      checkHostAllowed("http://localhost:4000/", { allowedHosts: ["localhost"] }),
    ).toBeUndefined();
  });

  it("URL に既定ポートが省略されていてもスキーム既定のポートとして照合する(http/ws=80、https/wss=443)", () => {
    expect(
      checkHostAllowed("https://example.com/", { allowedHosts: ["example.com:443"] }),
    ).toBeUndefined();
    expect(
      checkHostAllowed("http://example.com/", { allowedHosts: ["example.com:443"] }),
    ).toBeDefined();
    expect(
      checkHostAllowed("wss://example.com/socket", { allowedHosts: ["example.com:443"] }),
    ).toBeUndefined();
    expect(
      checkHostAllowed("ws://example.com/socket", { allowedHosts: ["example.com:80"] }),
    ).toBeUndefined();
    // 明示された既定ポートも同じ実効ポートとして扱う
    expect(
      checkHostAllowed("https://example.com:443/", { allowedHosts: ["example.com:443"] }),
    ).toBeUndefined();
  });

  it("IPv6 リテラルの URL を照合できる", () => {
    expect(
      checkHostAllowed("http://[::1]:3000/x", { allowedHosts: ["[::1]:3000"] }),
    ).toBeUndefined();
    expect(checkHostAllowed("http://[::1]:3000/x", { allowedHosts: ["[::1]"] })).toBeUndefined();
    expect(checkHostAllowed("http://[::2]:3000/x", { allowedHosts: ["[::1]"] })).toBeDefined();
  });

  it("ユーザー情報によるホスト偽装(許可ホスト@攻撃先)は実際の接続先ホストで判定する", () => {
    const error = checkHostAllowed("https://api.example.com@evil.test/", {
      allowedHosts: ["api.example.com"],
    });
    expect(error?.message).toContain('host "evil.test"');
  });

  it("IPv4 の別表記の URL(10進整数・16進・省略形)も正規化後の 127.0.0.1 として照合される", () => {
    const guard = { allowedHosts: ["127.0.0.1"] };
    for (const url of [
      "http://2130706433/",
      "http://0x7f.1/",
      "http://0x7f000001/",
      "http://127.1/",
    ]) {
      expect(checkHostAllowed(url, guard), url).toBeUndefined();
    }
    expect(checkHostAllowed("http://2130706434/", guard)).toBeDefined();
    expect(checkHostAllowed("http://0x7f.2/", guard)).toBeDefined();
  });

  it("拒否メッセージのホスト名は展開後の URL に書かれたままの表記(小文字化・punycode 化しない)で、マスクが効く", () => {
    const error = checkHostAllowed("https://TenantSecretXYZ.internal.example/x", {
      allowedHosts: ["api.example.com"],
    });
    expect(error?.message).toContain('host "TenantSecretXYZ.internal.example"');
    expect(error?.message).not.toContain("tenantsecretxyz");
  });

  it("ホスト部が安全な文字だけでない(非 ASCII など)場合、拒否メッセージにホスト名を載せない", () => {
    const error = checkHostAllowed("https://秘密テナント.example/x", {
      allowedHosts: ["api.example.com"],
    });
    expect(error?.message).toContain("request host is not in guard.allowedHosts");
    expect(error?.message).not.toContain("秘密");
    expect(error?.message).not.toContain("xn--");
  });

  it("パースできない URL は fail closed で拒否する", () => {
    const error = checkHostAllowed("not a url", { allowedHosts: ["example.com"] });
    expect(error?.message).toContain("could not be parsed");
  });

  it("書式不正のエントリは一致しない扱いにし、空配列は全拒否になる(fail closed)", () => {
    expect(checkHostAllowed("https://example.com/", { allowedHosts: ["*"] })).toBeDefined();
    expect(checkHostAllowed("https://example.com/", { allowedHosts: [] })).toBeDefined();
  });

  it("エラーメッセージにはクエリ等を含む URL 全体を載せない", () => {
    const error = checkHostAllowed("https://evil.test/path?token=SECRET-VALUE", {
      allowedHosts: ["example.com"],
    });
    expect(error?.message).not.toContain("SECRET-VALUE");
    expect(error?.message).not.toContain("/path");
  });
});

describe("findMethodOverrideHeader", () => {
  it("メソッド上書きヘッダーを大文字小文字を区別せず検出し、小文字の正規名を返す", () => {
    expect(findMethodOverrideHeader({ "X-HTTP-Method-Override": "DELETE" })).toBe(
      "x-http-method-override",
    );
    expect(findMethodOverrideHeader({ "x-http-method": "PUT" })).toBe("x-http-method");
    expect(findMethodOverrideHeader({ "X-METHOD-OVERRIDE": "PATCH" })).toBe("x-method-override");
  });

  it("関係ないヘッダーのみ・ヘッダー無しなら undefined", () => {
    expect(findMethodOverrideHeader({ Accept: "application/json" })).toBeUndefined();
    expect(findMethodOverrideHeader(undefined)).toBeUndefined();
  });
});

describe("isSafeMethod", () => {
  it("GET / HEAD / OPTIONS は大文字小文字を問わず安全メソッドとして扱う", () => {
    for (const method of ["GET", "head", "Options", " get "]) {
      expect(isSafeMethod(method)).toBe(true);
    }
  });

  it("それ以外のメソッド(WS を含む)は安全メソッドではない", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "TRACE", "WS", ""]) {
      expect(isSafeMethod(method)).toBe(false);
    }
  });
});
