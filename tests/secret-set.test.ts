import { describe, expect, it } from "vitest";
import { buildCassetteEntry } from "../src/core/cassette.js";
import { addCookieSecret, nonCookieSecrets, SecretSet } from "../src/core/secret-set.js";

describe("SecretSet", () => {
  it("cookie 由来のみの値は nonCookieValues に含まれず、Set としては全件が見える", () => {
    const set = new SecretSet();
    set.add("env-secret-value");
    addCookieSecret(set, "cookie-value-1234567");

    expect([...set]).toEqual(["env-secret-value", "cookie-value-1234567"]);
    expect(nonCookieSecrets(set)).toEqual(["env-secret-value"]);
  });

  it("cookie 以外の経路でも登録された値は、登録の順序によらず非 cookie 由来になる", () => {
    const cookieFirst = new SecretSet();
    cookieFirst.addCookie("shared-value-12345");
    cookieFirst.add("shared-value-12345");
    const envFirst = new SecretSet();
    envFirst.add("shared-value-12345");
    envFirst.addCookie("shared-value-12345");

    expect(nonCookieSecrets(cookieFirst)).toEqual(["shared-value-12345"]);
    expect(nonCookieSecrets(envFirst)).toEqual(["shared-value-12345"]);
  });

  it("普通の Set には通常どおり登録され、全件が非 cookie 扱いになる", () => {
    const plain = new Set<string>();
    addCookieSecret(plain, "cookie-value-1234567");

    expect(nonCookieSecrets(plain)).toEqual(["cookie-value-1234567"]);
    expect(nonCookieSecrets(undefined)).toEqual([]);
  });
});

describe("buildCassetteEntry の構造的ヘッダー", () => {
  const response = {
    status: 200,
    headers: { "content-type": "application/json", "x-other": "application/json" },
    bodyText: "{}",
  };

  it("cookie 由来の秘密値とだけ一致するなら元の値に戻し、他のヘッダーはマスクのまま", () => {
    const entry = buildCassetteEntry("GET", "http://x/", response, ["application/json"], []);

    expect(entry.headers["content-type"]).toBe("application/json");
    expect(entry.headers["x-other"]).toBe("***");
  });

  it("非 cookie 由来の秘密値と一致するなら構造的ヘッダーもマスクされる", () => {
    const secrets = ["application/json"];
    const entry = buildCassetteEntry("GET", "http://x/", response, secrets, secrets);

    expect(entry.headers["content-type"]).toBe("***");
  });
});
