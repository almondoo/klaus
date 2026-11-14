import { describe, expect, it } from "vitest";
import type { CassetteEntry } from "../src/core/cassette.js";
import {
  buildMockResponse,
  createMockMatcher,
  normalizeOrigin,
  parseRequestTarget,
} from "../src/core/mock.js";

function entry(
  method: string,
  url: string,
  bodyText: string,
  headers: Record<string, string> = {},
  status = 200,
): CassetteEntry {
  return { v: 1, method, url, status, headers, bodyText };
}

describe("createMockMatcher", () => {
  it("ホストを無視して method + path + query で照合する", () => {
    const matcher = createMockMatcher([entry("GET", "http://api.example.com/users?page=1", "a")]);
    expect(matcher.match("GET", "/users?page=1")?.bodyText).toBe("a");
    expect(matcher.match("get", "/users?page=1")?.bodyText).toBe("a");
    expect(matcher.match("POST", "/users?page=1")).toBeUndefined();
    expect(matcher.match("GET", "/users")).toBeUndefined();
    expect(matcher.match("GET", "/users?page=2")).toBeUndefined();
  });

  it("query は完全一致を優先し、無ければ順序非依存で一致させる", () => {
    const matcher = createMockMatcher([
      entry("GET", "http://h/x?a=1&b=2", "ab"),
      entry("GET", "http://h/x?b=2&a=1", "ba"),
    ]);
    expect(matcher.match("GET", "/x?b=2&a=1")?.bodyText).toBe("ba");
    expect(matcher.match("GET", "/x?a=1&b=2")?.bodyText).toBe("ab");
    const only = createMockMatcher([entry("GET", "http://h/x?a=1&b=2", "ab")]);
    expect(only.match("GET", "/x?b=2&a=1")?.bodyText).toBe("ab");
    expect(only.match("GET", "/x?a=1&b=3")).toBeUndefined();
  });

  it("ignoreQuery では path のみで照合する", () => {
    const matcher = createMockMatcher([entry("GET", "http://h/x?a=1", "one")], {
      ignoreQuery: true,
    });
    expect(matcher.match("GET", "/x?anything=1")?.bodyText).toBe("one");
    expect(matcher.match("GET", "/x")?.bodyText).toBe("one");
  });

  it("同一キーは既定で先頭を返し続け、sequence では記録順に進んで最後を繰り返す", () => {
    const entries = [
      entry("GET", "http://h/n", "1"),
      entry("GET", "http://h/n", "2"),
      entry("GET", "http://h/n", "3"),
    ];
    const first = createMockMatcher(entries);
    expect([1, 2, 3].map(() => first.match("GET", "/n")?.bodyText)).toEqual(["1", "1", "1"]);
    const seq = createMockMatcher(entries, { sequence: true });
    expect([1, 2, 3, 4, 5].map(() => seq.match("GET", "/n")?.bodyText)).toEqual([
      "1",
      "2",
      "3",
      "3",
      "3",
    ]);
  });

  it("複数オリジンは統合され、衝突は最初のオリジンを採用して collisions に残す", () => {
    const entries = [
      entry("GET", "http://a.example.com/p", "from-a"),
      entry("GET", "http://b.example.com/p", "from-b"),
      entry("GET", "http://b.example.com/only-b", "b2"),
    ];
    const matcher = createMockMatcher(entries);
    expect(matcher.origins).toEqual(["http://a.example.com", "http://b.example.com"]);
    expect(matcher.match("GET", "/p")?.bodyText).toBe("from-a");
    expect(matcher.match("GET", "/only-b")?.bodyText).toBe("b2");
    expect(matcher.collisions).toEqual([
      { key: "GET /p", winner: "http://a.example.com", ignored: ["http://b.example.com"] },
    ]);
  });

  it("origin 指定でそのオリジンのエントリだけを使う", () => {
    const entries = [
      entry("GET", "http://a.example.com/p", "from-a"),
      entry("GET", "http://b.example.com/p", "from-b"),
    ];
    const matcher = createMockMatcher(entries, { origin: "http://b.example.com/ignored/path" });
    expect(matcher.match("GET", "/p")?.bodyText).toBe("from-b");
    expect(matcher.collisions).toEqual([]);
    expect(createMockMatcher(entries, { origin: "http://none.example.com" }).routeCount).toBe(0);
  });

  it("closestPaths は同一メソッドで共通セグメントの多い記録済みパスを返し、ボディを含めない", () => {
    const matcher = createMockMatcher([
      entry("GET", "http://h/users/1", "SECRET-BODY"),
      entry("POST", "http://h/users", "x"),
      entry("GET", "http://h/orders/1", "y"),
    ]);
    const closest = matcher.closestPaths("GET", "/users/2");
    expect(closest[0]).toBe("GET /users/1");
    expect(closest.join("\n")).not.toContain("SECRET-BODY");
  });
});

describe("buildMockResponse", () => {
  it("ホップバイホップ・長さ依存ヘッダーを落とし、content-length を再計算する", () => {
    const response = buildMockResponse(
      entry(
        "GET",
        "http://h/x",
        "あい",
        {
          "content-type": "text/plain",
          "content-length": "999",
          "transfer-encoding": "chunked",
          "content-encoding": "gzip",
          connection: "keep-alive",
          "keep-alive": "timeout=5",
          "x-custom": "v",
        },
        201,
      ),
    );
    expect(response.status).toBe(201);
    expect(response.headers).toEqual({
      "content-type": "text/plain",
      "x-custom": "v",
      "content-length": "6",
    });
    expect(response.body.toString("utf-8")).toBe("あい");
  });
});

describe("normalizeOrigin", () => {
  it("URL からオリジンを取り出し、URL でなければ undefined", () => {
    expect(normalizeOrigin("http://api.example.com:8080/a/b")).toBe("http://api.example.com:8080");
    expect(normalizeOrigin("not a url")).toBeUndefined();
  });
});

describe("buildMockResponse (ボディ無しステータス・HEAD・CORS)", () => {
  it("204 / 304 / 1xx はボディも content-length も付けない", () => {
    for (const status of [100, 204, 304]) {
      const response = buildMockResponse(entry("GET", "http://h/x", "stale body", {}, status));
      expect(response.body.byteLength).toBe(0);
      expect(response.headers["content-length"]).toBeUndefined();
    }
  });

  it("HEAD はボディを送らず、対応する GET と同じ content-length を返す", () => {
    const response = buildMockResponse(entry("GET", "http://h/x", "abcd"), "HEAD");
    expect(response.body.byteLength).toBe(0);
    expect(response.headers["content-length"]).toBe("4");
  });

  it("記録済みの access-control-* ヘッダーは大文字小文字を問わず落とす", () => {
    const response = buildMockResponse(
      entry("GET", "http://h/x", "ok", {
        "Access-Control-Allow-Origin": "https://upstream.example.com",
        "access-control-allow-credentials": "true",
        "x-keep": "1",
      }),
    );
    expect(Object.keys(response.headers).sort()).toEqual(["content-length", "x-keep"]);
  });
});

describe("parseRequestTarget", () => {
  it("origin-form はそのまま path と query に分け、先頭の // を host とみなさない", () => {
    expect(parseRequestTarget("/users?a=1")).toEqual({ path: "/users", query: "a=1" });
    expect(parseRequestTarget("//evil.com/users")).toEqual({ path: "//evil.com/users", query: "" });
    expect(parseRequestTarget("/caf%E9%zz?q=%")).toEqual({ path: "/caf%E9%zz", query: "q=%" });
  });

  it("absolute-form は path + query を使い、それ以外の形式は undefined", () => {
    expect(parseRequestTarget("http://host:8080/users?a=1")).toEqual({
      path: "/users",
      query: "a=1",
    });
    expect(parseRequestTarget("*")).toBeUndefined();
    expect(parseRequestTarget("example.com:443")).toBeUndefined();
    expect(parseRequestTarget("ftp://host/x")).toBeUndefined();
    expect(parseRequestTarget("http://")).toBeUndefined();
  });

  it("マッチャーは // 始まりのターゲットを /users として扱わない", () => {
    const matcher = createMockMatcher([entry("GET", "http://h/users", "ok")]);
    expect(matcher.match("GET", "//evil.com/users")).toBeUndefined();
    expect(matcher.match("GET", "http://other.example.com/users")?.bodyText).toBe("ok");
    expect(matcher.match("GET", "*")).toBeUndefined();
  });
});
