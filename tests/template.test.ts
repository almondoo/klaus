import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeError } from "../src/core/errors.js";
import { renderDeep, renderHeaders, renderString } from "../src/core/template.js";

describe("renderString", () => {
  it("キャプチャ変数を展開する", () => {
    const result = renderString("Bearer {{token}}", { captures: { token: "abc123" }, env: {} });
    expect(result).toBe("Bearer abc123");
  });

  it("キャプチャ変数が環境ファイル変数より優先される", () => {
    const result = renderString("{{x}}", {
      captures: { x: "from-capture" },
      env: { x: "from-env" },
    });
    expect(result).toBe("from-capture");
  });

  it("環境ファイル変数を展開する", () => {
    const result = renderString("{{baseUrl}}/login", {
      captures: {},
      env: { baseUrl: "http://localhost:3000" },
    });
    expect(result).toBe("http://localhost:3000/login");
  });

  it("未解決の変数は RuntimeError を投げる", () => {
    expect(() => renderString("{{unknown}}", { captures: {}, env: {} })).toThrow(RuntimeError);
  });

  describe("env.X (OS 環境変数)", () => {
    const KEY = "KLAUS_TEST_TEMPLATE_VAR";

    beforeEach(() => {
      process.env[KEY] = "secret-value";
    });

    afterEach(() => {
      delete process.env[KEY];
    });

    it("process.env の値を展開する", () => {
      const result = renderString(`{{env.${KEY}}}`, { captures: {}, env: {} });
      expect(result).toBe("secret-value");
    });

    it("未定義の OS 環境変数は RuntimeError を投げる", () => {
      expect(() =>
        renderString("{{env.KLAUS_TEST_UNDEFINED_VAR}}", { captures: {}, env: {} }),
      ).toThrow(RuntimeError);
    });
  });

  describe("テンプレート関数", () => {
    it("newUuid は UUID 形式の文字列を返す", () => {
      const result = renderString("{{newUuid}}", { captures: {}, env: {} });
      expect(result).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("newDate は ISO 8601 文字列を返す", () => {
      const result = renderString("{{newDate}}", { captures: {}, env: {} });
      expect(() => new Date(result).toISOString()).not.toThrow();
      expect(new Date(result).toISOString()).toBe(result);
    });

    it("newTimestamp は epoch ms の数値文字列を返す", () => {
      const result = renderString("{{newTimestamp}}", { captures: {}, env: {} });
      expect(result).toMatch(/^\d+$/);
    });
  });

  it("文字列内の複数の変数を部分置換する", () => {
    const result = renderString("{{a}}-{{b}}", { captures: { a: "1", b: "2" }, env: {} });
    expect(result).toBe("1-2");
  });
});

describe("renderDeep", () => {
  it("オブジェクト・配列を再帰的に辿り文字列だけ展開する", () => {
    const input = {
      email: "{{email}}",
      nested: { value: "{{value}}", list: ["{{a}}", 2, true, null] },
    };
    const result = renderDeep(input, {
      captures: { email: "a@example.com", value: "v", a: "x" },
      env: {},
    });
    expect(result).toEqual({
      email: "a@example.com",
      nested: { value: "v", list: ["x", 2, true, null] },
    });
  });

  it("数値・真偽値・null はそのまま返す", () => {
    expect(renderDeep(42, { captures: {}, env: {} })).toBe(42);
    expect(renderDeep(true, { captures: {}, env: {} })).toBe(true);
    expect(renderDeep(null, { captures: {}, env: {} })).toBe(null);
  });
});

describe("renderHeaders", () => {
  it("ヘッダーの値をテンプレート展開する", () => {
    const result = renderHeaders(
      { Authorization: "Bearer {{token}}" },
      { captures: { token: "abc" }, env: {} },
    );
    expect(result.Authorization).toBe("Bearer abc");
  });

  it("undefined を渡すと空オブジェクトを返す", () => {
    expect(renderHeaders(undefined, { captures: {}, env: {} })).toEqual({});
  });
});
