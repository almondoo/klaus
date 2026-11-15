import { describe, expect, it } from "vitest";
import { errorCodeOf, explainError } from "./errorExplain";

const CODES = [
  "guard.allowed-hosts",
  "guard.protected",
  "guard.readonly",
  "guard.method-override",
  "guard.host-header",
  "guard.proxy-header",
  "guard.path",
  "guard.redirect",
  "response-too-large",
];

describe("explainError", () => {
  it.each(CODES)("%s は title と hint を返す", (code) => {
    const explained = explainError(code);
    expect(explained?.title).toBeTruthy();
    expect(explained?.hint).toBeTruthy();
  });

  it("識別子は原文のまま含める", () => {
    expect(explainError("guard.protected")?.hint).toContain("klaus run --allow-protected");
    expect(explainError("guard.allowed-hosts")?.hint).toContain("guard.allowedHosts");
  });

  it("未知のコード・未指定・プロトタイプ由来の名前は null", () => {
    expect(explainError("unknown.code")).toBeNull();
    expect(explainError(undefined)).toBeNull();
    expect(explainError(null)).toBeNull();
    expect(explainError("")).toBeNull();
    expect(explainError("toString")).toBeNull();
  });
});

describe("errorCodeOf", () => {
  it("文字列の errorCode だけを返す", () => {
    expect(errorCodeOf({ errorCode: "guard.redirect" })).toBe("guard.redirect");
    expect(errorCodeOf({ errorCode: 1 })).toBeUndefined();
    expect(errorCodeOf({})).toBeUndefined();
    expect(errorCodeOf(null)).toBeUndefined();
  });
});
