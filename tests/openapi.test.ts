import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ParseError } from "../src/core/errors.js";
import { OpenApiValidator } from "../src/core/openapi.js";
import type { LoadedFlowEntry } from "../src/core/runner.js";
import { runLoadedFlows } from "../src/core/runner.js";
import { type Flow, flowSchema } from "../src/core/schema.js";
import { closeServer, listenEphemeral } from "./support/net.js";

let dir: string;

beforeAll(async () => {
  await mkdir(join(process.cwd(), "tmp"), { recursive: true });
  dir = await mkdtemp(join(process.cwd(), "tmp", "openapi-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;

/** 仕様をファイルに書いて、パスを返す */
async function writeSpec(doc: unknown, name = `spec-${counter++}.json`): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof doc === "string" ? doc : JSON.stringify(doc));
  return path;
}

function spec30(paths: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { openapi: "3.0.3", info: { title: "Test API", version: "1.2.3" }, paths, ...extra };
}

const jsonResponse = (schema: unknown, extra: Record<string, unknown> = {}) => ({
  description: "ok",
  content: { "application/json": { schema } },
  ...extra,
});

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
) {
  return {
    status,
    headers,
    body,
    bodyText: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function check(
  validator: OpenApiValidator,
  method: string,
  url: string,
  res: ReturnType<typeof response>,
) {
  return validator.check({ flow: "flow", step: "step", method, url, response: res });
}

const userSchema = {
  type: "object",
  required: ["id", "name"],
  properties: { id: { type: "integer" }, name: { type: "string" } },
};

describe("OpenApiValidator.load: 仕様の読み込み", () => {
  it("OpenAPI 3.x 以外は ParseError(Swagger 2.0 は理由を示す)", async () => {
    const swagger = await writeSpec({ swagger: "2.0", paths: {} });
    await expect(OpenApiValidator.load([swagger], { cwd: dir })).rejects.toThrow(/Swagger 2\.0/);
    const other = await writeSpec({ openapi: "4.0.0", paths: {} });
    await expect(OpenApiValidator.load([other], { cwd: dir })).rejects.toThrow(ParseError);
    const noPaths = await writeSpec({ openapi: "3.0.0" });
    await expect(OpenApiValidator.load([noPaths], { cwd: dir })).rejects.toThrow(/paths/);
  });

  it("構文エラーは位置だけを伝え、内容を出さない", async () => {
    const path = await writeSpec("openapi: 3.0.0\npaths: {\n  secret-marker: [\n", "broken.yaml");
    const error = await OpenApiValidator.load([path], { cwd: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ParseError);
    expect((error as Error).message).toMatch(/failed to parse/);
    expect((error as Error).message).not.toContain("secret-marker");
  });

  it("存在しないファイルと YAML/JSON 以外の拡張子は拒否する", async () => {
    await expect(OpenApiValidator.load([join(dir, "nope.json")], { cwd: dir })).rejects.toThrow(
      /not found/,
    );
    const txt = join(dir, "spec.txt");
    await writeFile(txt, "{}");
    await expect(OpenApiValidator.load([txt], { cwd: dir })).rejects.toThrow(
      /\.yaml, \.yml and \.json/,
    );
  });

  it("リモートの $ref は拒否する", async () => {
    const path = await writeSpec(
      spec30({
        "/a": {
          get: { responses: { "200": jsonResponse({ $ref: "https://example.com/s.json#/X" }) } },
        },
      }),
    );
    await expect(OpenApiValidator.load([path], { cwd: dir })).rejects.toThrow(/remote \$ref/);
  });

  it("解決できない $ref は実行前に ParseError、YAML/JSON 以外の $ref 先は拒否し内容を出さない", async () => {
    const missing = await writeSpec(
      spec30({
        "/a": {
          get: { responses: { "200": jsonResponse({ $ref: "#/components/schemas/Nope" }) } },
        },
      }),
    );
    await expect(OpenApiValidator.load([missing], { cwd: dir })).rejects.toThrow(
      /cannot be resolved/,
    );

    await writeFile(join(dir, "secret.txt"), "TOP-SECRET-CONTENT");
    const text = await writeSpec(
      spec30({
        "/a": { get: { responses: { "200": jsonResponse({ $ref: "./secret.txt#/x" }) } } },
      }),
    );
    const error = await OpenApiValidator.load([text], { cwd: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ParseError);
    expect((error as Error).message).not.toContain("TOP-SECRET-CONTENT");

    // 拡張子が .json でも、実体が YAML/JSON でなければ内容は出さない
    await writeFile(join(dir, "bad.json"), "TOP-SECRET-CONTENT {");
    const bad = await writeSpec(
      spec30({ "/a": { get: { responses: { "200": jsonResponse({ $ref: "./bad.json#/x" }) } } } }),
    );
    const badError = await OpenApiValidator.load([bad], { cwd: dir }).catch((e: unknown) => e);
    expect(badError).toBeInstanceOf(ParseError);
    expect((badError as Error).message).not.toContain("TOP-SECRET-CONTENT");
  });

  it("実体が YAML/JSON 以外へのシンボリックリンクは拡張子の偽装でも拒否する", async () => {
    await writeFile(join(dir, "target.txt"), "{}");
    await symlink(join(dir, "target.txt"), join(dir, "link.json"));
    await expect(OpenApiValidator.load([join(dir, "link.json")], { cwd: dir })).rejects.toThrow(
      /\.yaml, \.yml and \.json/,
    );
  });

  it("別ファイルへの $ref を解決し、循環参照があっても検証できる", async () => {
    await writeFile(
      join(dir, "schemas.yaml"),
      [
        "Tree:",
        "  type: object",
        "  required: [value]",
        "  properties:",
        "    value: {type: integer}",
        "    children:",
        "      type: array",
        "      items: {$ref: '#/Tree'}",
        "",
      ].join("\n"),
    );
    const path = await writeSpec(
      spec30({
        "/tree": { get: { responses: { "200": jsonResponse({ $ref: "./schemas.yaml#/Tree" }) } } },
      }),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    const ok = await check(
      validator,
      "GET",
      "http://x/tree",
      response(200, { value: 1, children: [{ value: 2, children: [] }] }),
    );
    expect(ok[0]?.ok).toBe(true);
    const bad = await check(
      validator,
      "GET",
      "http://x/tree",
      response(200, { value: 1, children: [{ value: "two" }] }),
    );
    expect(bad[0]?.ok).toBe(false);
    expect(bad[0]?.openapi?.violations?.[0]).toMatchObject({
      location: "body",
      path: "/children/0/value",
    });
  });

  it("$ref だけが循環する(スキーマの実体が無い)定義は警告にして任意の値として扱う", async () => {
    const path = await writeSpec(
      spec30(
        {
          "/a": { get: { responses: { "200": jsonResponse({ $ref: "#/components/schemas/A" }) } } },
        },
        {
          components: {
            schemas: {
              A: { $ref: "#/components/schemas/B" },
              B: { $ref: "#/components/schemas/A" },
            },
          },
        },
      ),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    expect(
      (await check(validator, "GET", "http://x/a", response(200, { any: "thing" })))[0]?.ok,
    ).toBe(true);
    expect(validator.warnings.some((w) => /cycle/.test(w))).toBe(true);
  });
});

describe("オペレーションの照合", () => {
  it("サーバー URL(変数つき)の接頭辞とパステンプレート + メソッドで照合する", async () => {
    const path = await writeSpec(
      spec30(
        {
          "/users/{id}": { get: { responses: { "200": jsonResponse(userSchema) } } },
          "/users": { post: { responses: { "201": { description: "created" } } } },
        },
        {
          servers: [
            {
              url: "https://{env}.example.com/api/{version}",
              variables: {
                env: { default: "dev", enum: ["dev", "stg"] },
                version: { default: "v1" },
              },
            },
          ],
        },
      ),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    const hit = async (method: string, url: string) =>
      (await check(validator, method, url, response(200, { id: 1, name: "a" }))).length > 0;
    expect(await hit("GET", "https://stg.example.com/api/v2/users/7?x=1#top")).toBe(true);
    expect(await hit("get", "https://DEV.example.com/api/v1/users/7/")).toBe(true);
    // 列挙にないホスト・別のメソッド・接頭辞の外は照合できない(strict でなければアサーションを足さない)
    expect(await hit("GET", "https://prod.example.com/api/v1/users/7")).toBe(false);
    expect(await hit("DELETE", "https://dev.example.com/api/v1/users/7")).toBe(false);
    expect(await hit("GET", "https://dev.example.com/other/users/7")).toBe(false);
    const summary = validator.summarize({ partial: false, planned: false });
    expect(summary.unmatched.map((u) => `${u.method} ${u.url}`)).toEqual([
      "DELETE https://dev.example.com/api/v1/users/7",
      "GET https://dev.example.com/other/users/7",
      "GET https://prod.example.com/api/v1/users/7",
    ]);
  });

  it("相対のサーバー URL は任意のオリジンに、--openapi-base-url は spec の servers に加えて照合する", async () => {
    const relative = await writeSpec(
      spec30(
        { "/ping": { get: { responses: { "200": { description: "ok" } } } } },
        { servers: [{ url: "/v1" }] },
      ),
    );
    const validator = await OpenApiValidator.load([relative], { cwd: dir });
    expect(
      await check(validator, "GET", "http://anything:3000/v1/ping", response(200, "")),
    ).toHaveLength(1);
    expect(
      await check(validator, "GET", "http://anything:3000/ping", response(200, "")),
    ).toHaveLength(0);

    const absolute = await writeSpec(
      spec30(
        { "/ping": { get: { responses: { "200": { description: "ok" } } } } },
        { servers: [{ url: "https://api.example.com" }] },
      ),
    );
    const withBase = await OpenApiValidator.load([absolute], {
      cwd: dir,
      baseUrl: "http://localhost:4010/mock",
    });
    expect(
      await check(withBase, "GET", "http://localhost:4010/mock/ping", response(200, "")),
    ).toHaveLength(1);
    expect(
      await check(withBase, "GET", "https://api.example.com/ping", response(200, "")),
    ).toHaveLength(1);
    expect(
      await check(withBase, "GET", "http://localhost:4010/ping", response(200, "")),
    ).toHaveLength(0);
  });

  it("具体的なパスをテンプレートより優先する(メソッドを持つものだけが候補)", async () => {
    const path = await writeSpec(
      spec30({
        "/users/{id}": {
          get: { responses: { "200": jsonResponse({ type: "object", required: ["templated"] }) } },
          delete: { responses: { "204": { description: "gone" } } },
        },
        "/users/me": {
          get: { responses: { "200": jsonResponse({ type: "object", required: ["concrete"] }) } },
        },
      }),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    const get = await check(
      validator,
      "GET",
      "http://x/users/me",
      response(200, { concrete: true }),
    );
    expect(get[0]?.openapi?.operation).toBe("GET /users/me");
    expect(get[0]?.ok).toBe(true);
    // DELETE は具体的なパスに無いので、テンプレートのパスに照合される
    const del = await check(validator, "DELETE", "http://x/users/me", response(204, "", {}));
    expect(del[0]?.openapi?.operation).toBe("DELETE /users/{id}");
  });

  it("複数の文書は渡した順に照合し、先に一致した文書を使う", async () => {
    const first = await writeSpec(
      spec30({ "/a": { get: { responses: { "200": { description: "first" } } } } }),
    );
    const second = await writeSpec(
      spec30({ "/b": { get: { responses: { "200": { description: "second" } } } } }),
    );
    const validator = await OpenApiValidator.load([first, second], { cwd: dir });
    expect(
      (await check(validator, "GET", "http://x/b", response(200, "")))[0]?.openapi?.document,
    ).toMatch(/spec-\d+\.json$/);
    const summary = validator.summarize({ partial: false, planned: false });
    expect(summary.documents).toHaveLength(2);
    expect(summary.operations).toEqual({ total: 2, covered: 1, percent: 50 });
  });
});

describe("応答の検証", () => {
  it("ステータスは完全一致 → 2XX → default の順に探す。書かれていなければ undocumented(strict で失敗)", async () => {
    const path = await writeSpec(
      spec30({
        "/r": {
          get: {
            responses: {
              "200": jsonResponse({ type: "object", required: ["exact"] }),
              "2XX": jsonResponse({ type: "object", required: ["range"] }),
              default: jsonResponse({ type: "object", required: ["fallback"] }),
            },
          },
        },
      }),
    );
    const lenient = await OpenApiValidator.load([path], { cwd: dir });
    expect((await check(lenient, "GET", "http://x/r", response(200, { exact: 1 })))[0]?.ok).toBe(
      true,
    );
    expect((await check(lenient, "GET", "http://x/r", response(201, { range: 1 })))[0]?.ok).toBe(
      true,
    );
    expect((await check(lenient, "GET", "http://x/r", response(500, { fallback: 1 })))[0]?.ok).toBe(
      true,
    );
    expect((await check(lenient, "GET", "http://x/r", response(201, { exact: 1 })))[0]?.ok).toBe(
      false,
    );

    const noDefault = await writeSpec(
      spec30({ "/r": { get: { responses: { "200": { description: "ok" } } } } }),
    );
    const lenientNoDefault = await OpenApiValidator.load([noDefault], { cwd: dir });
    const undocumented = await check(lenientNoDefault, "GET", "http://x/r", response(418, {}));
    expect(undocumented[0]).toMatchObject({
      ok: true,
      openapi: { state: "undocumented", status: 418 },
    });
    const strict = await OpenApiValidator.load([noDefault], { cwd: dir, strict: true });
    expect((await check(strict, "GET", "http://x/r", response(418, {})))[0]).toMatchObject({
      ok: false,
      openapi: { state: "undocumented" },
    });
    expect((await check(strict, "GET", "http://x/unknown", response(200, {})))[0]).toMatchObject({
      ok: false,
      openapi: { state: "unmatched" },
    });
  });

  it("content-type は宣言と照合する(パラメーター・ワイルドカードを許す)", async () => {
    const path = await writeSpec(
      spec30({
        "/c": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { type: "object" } },
                  "text/*": {},
                },
              },
            },
          },
        },
      }),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    const json = response(200, {}, { "Content-Type": "application/json; charset=utf-8" });
    expect((await check(validator, "GET", "http://x/c", json))[0]?.ok).toBe(true);
    const text = {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "hi",
      bodyText: "hi",
    };
    expect((await check(validator, "GET", "http://x/c", text))[0]?.ok).toBe(true);
    const xml = {
      status: 200,
      headers: { "content-type": "application/xml" },
      body: "<a/>",
      bodyText: "<a/>",
    };
    const bad = await check(validator, "GET", "http://x/c", xml);
    expect(bad[0]?.ok).toBe(false);
    expect(bad[0]?.openapi?.violations?.[0]?.location).toBe("content-type");
    // 本文を宣言した応答(スキーマあり)が空の本文で返ったら違反。204 / 304 と HEAD は本文を持たないので対象外
    const empty = await check(validator, "GET", "http://x/c", response(200, "", {}));
    expect(empty[0]?.ok).toBe(false);
    expect(empty[0]?.openapi?.violations?.[0]).toMatchObject({ location: "body", path: "" });
    expect((await check(validator, "GET", "http://x/c", response(204, "", {})))[0]?.ok).toBe(true);
  });

  it("本文がスキーマに違反すると JSON Pointer つきの違反になり、値は出さない", async () => {
    const path = await writeSpec(
      spec30({ "/users/{id}": { get: { responses: { "200": jsonResponse(userSchema) } } } }),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    const result = await check(
      validator,
      "GET",
      "http://x/users/1",
      response(200, { id: "super-secret-value" }),
    );
    expect(result[0]?.ok).toBe(false);
    expect(result[0]?.kind).toBe("openapi");
    const violations = result[0]?.openapi?.violations ?? [];
    expect(violations).toEqual(
      expect.arrayContaining([
        { location: "body", path: "/id", message: "must be integer" },
        { location: "body", path: "", message: "must have required property 'name'" },
      ]),
    );
    expect(JSON.stringify(result[0])).not.toContain("super-secret-value");
    expect(result[0]?.message).toMatch(/GET \/users\/\{id\} -> 200 violates the specification/);
  });

  it("違反は上限件数で切り詰め、総数は violationCount に残す", async () => {
    const path = await writeSpec(
      spec30({
        "/many": {
          get: {
            responses: { "200": jsonResponse({ type: "array", items: { type: "integer" } }) },
          },
        },
      }),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    const result = await check(
      validator,
      "GET",
      "http://x/many",
      response(
        200,
        Array.from({ length: 50 }, () => "x"),
      ),
    );
    expect(result[0]?.openapi?.violations).toHaveLength(20);
    expect(result[0]?.openapi?.violationCount).toBe(50);
    expect(result[0]?.message).toContain("(+47 more)");
  });

  it("3.0 の nullable・exclusiveMinimum の真偽値を変換する。未知の format は失敗にしない", async () => {
    const path = await writeSpec(
      spec30({
        "/n": {
          get: {
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  nick: { type: "string", nullable: true },
                  kind: { type: "string", enum: ["a", "b"], nullable: true },
                  score: { type: "number", minimum: 0, exclusiveMinimum: true },
                  when: { type: "string", format: "x-made-up" },
                  at: { type: "string", format: "date-time" },
                },
              }),
            },
          },
        },
      }),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    const ok = await check(
      validator,
      "GET",
      "http://x/n",
      response(200, { nick: null, kind: null, score: 0.1, when: "anything", at: "not-a-date" }),
    );
    expect(ok[0]?.ok).toBe(true);
    const zero = await check(validator, "GET", "http://x/n", response(200, { score: 0 }));
    expect(zero[0]?.ok).toBe(false);
    expect(zero[0]?.openapi?.violations?.[0]?.path).toBe("/score");
  });

  it("3.1 は 2020-12 のまま検証する(type 配列・$ref の兄弟キーワード)", async () => {
    const path = await writeSpec({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/v": {
          get: {
            responses: {
              "200": jsonResponse({
                type: "object",
                properties: {
                  maybe: { type: ["integer", "null"] },
                  user: { $ref: "#/components/schemas/User", description: "sibling is allowed" },
                },
              }),
            },
          },
        },
      },
      components: { schemas: { User: userSchema } },
    });
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    expect(
      (
        await check(
          validator,
          "GET",
          "http://x/v",
          response(200, { maybe: null, user: { id: 1, name: "a" } }),
        )
      )[0]?.ok,
    ).toBe(true);
    const bad = await check(
      validator,
      "GET",
      "http://x/v",
      response(200, { maybe: "x", user: { id: 1 } }),
    );
    expect(bad[0]?.openapi?.violationCount).toBeGreaterThanOrEqual(2);
  });

  it("writeOnly のプロパティは応答では必須にしない", async () => {
    const path = await writeSpec(
      spec30({
        "/pw": {
          get: {
            responses: {
              "200": jsonResponse({
                type: "object",
                required: ["id", "password"],
                properties: {
                  id: { type: "integer", readOnly: true },
                  password: { type: "string", writeOnly: true },
                },
              }),
            },
          },
        },
      }),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    expect((await check(validator, "GET", "http://x/pw", response(200, { id: 1 })))[0]?.ok).toBe(
      true,
    );
    expect((await check(validator, "GET", "http://x/pw", response(200, {})))[0]?.ok).toBe(false);
  });

  it("必須の応答ヘッダーが無ければ違反(大文字小文字は区別しない)", async () => {
    const path = await writeSpec(
      spec30({
        "/h": {
          get: {
            responses: {
              "200": {
                description: "ok",
                headers: {
                  "X-Request-Id": { required: true, schema: { type: "string" } },
                  "X-Opt": { schema: { type: "string" } },
                },
              },
            },
          },
        },
      }),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    expect(
      (await check(validator, "GET", "http://x/h", response(200, "", { "x-request-id": "1" })))[0]
        ?.ok,
    ).toBe(true);
    const missing = await check(validator, "GET", "http://x/h", response(200, "", {}));
    expect(missing[0]?.ok).toBe(false);
    expect(missing[0]?.openapi?.violations?.[0]).toMatchObject({
      location: "header",
      path: "X-Request-Id",
    });
  });

  it("application/problem+json など +json は JSON として検証し、壊れた JSON は違反にする", async () => {
    const path = await writeSpec(
      spec30({
        "/p": {
          get: {
            responses: {
              "400": {
                description: "bad",
                content: {
                  "application/problem+json": { schema: { type: "object", required: ["title"] } },
                },
              },
            },
          },
        },
      }),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    const headers = { "content-type": "application/problem+json" };
    // 実行時は +json を JSON としてパースしないため body は文字列のまま来る
    const ok = { status: 400, headers, body: '{"title":"x"}', bodyText: '{"title":"x"}' };
    expect((await check(validator, "GET", "http://x/p", ok))[0]?.ok).toBe(true);
    const missing = { status: 400, headers, body: "{}", bodyText: "{}" };
    expect((await check(validator, "GET", "http://x/p", missing))[0]?.ok).toBe(false);
    const broken = { status: 400, headers, body: "{oops", bodyText: "{oops" };
    expect(
      (await check(validator, "GET", "http://x/p", broken))[0]?.openapi?.violations?.[0]?.message,
    ).toMatch(/not valid JSON/);
  });

  it("コンパイルできないスキーマは検証せず警告にする(strict では失敗)", async () => {
    const path = await writeSpec(
      spec30({
        "/bad": { get: { responses: { "200": jsonResponse({ type: "nonsense-type" }) } } },
      }),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    const result = await check(validator, "GET", "http://x/bad", response(200, {}));
    expect(result[0]).toMatchObject({ ok: true, openapi: { state: "skipped" } });
    expect(validator.warnings.some((w) => /cannot be compiled/.test(w))).toBe(true);
    const strict = await OpenApiValidator.load([path], { cwd: dir, strict: true });
    expect((await check(strict, "GET", "http://x/bad", response(200, {})))[0]?.ok).toBe(false);
  });
});

describe("カバレッジの集計", () => {
  it("カバー済み(観測したステータス・仕様のステータス)・未カバー・対象外・違反数・partial / planned・下限を返す", async () => {
    const path = await writeSpec(
      spec30({
        "/a": {
          get: { responses: { "200": jsonResponse(userSchema), "404": { description: "nf" } } },
        },
        "/b": { get: { responses: { "200": { description: "ok" } } } },
        "/c": { get: { responses: { "200": { description: "ok" } } } },
        "/d": { get: { responses: { "200": { description: "ok" } } } },
      }),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    await check(validator, "GET", "http://x/a", response(200, { id: 1, name: "a" }));
    await check(validator, "GET", "http://x/a", response(404, ""));
    await check(validator, "GET", "http://x/a", response(200, { id: "x" }));
    await check(validator, "GET", "http://x/b", response(200, ""));
    validator.exclude("flow", "events", "sse");
    validator.exclude("flow", "events", "sse");
    const summary = validator.summarize({ partial: true, planned: false, coverageMin: 80 });
    expect(summary.operations).toEqual({ total: 4, covered: 2, percent: 50 });
    expect(summary.covered).toEqual([
      expect.objectContaining({
        operation: "GET /a",
        statuses: [200, 404],
        documented: ["200", "404"],
      }),
      expect.objectContaining({ operation: "GET /b", statuses: [200] }),
    ]);
    expect(summary.uncovered.map((u) => u.operation)).toEqual(["GET /c", "GET /d"]);
    expect(summary.excluded).toEqual([{ flow: "flow", step: "events", reason: "sse" }]);
    expect(summary.violations).toBe(1);
    expect(summary.partial).toBe(true);
    expect(summary.planned).toBe(false);
    expect(summary.coverageMin).toEqual({ percent: 80, met: false });
    expect(summary.documents).toEqual([
      expect.objectContaining({ title: "Test API", version: "1.2.3", operations: 4 }),
    ]);
    expect(
      validator.summarize({ partial: false, planned: false, coverageMin: 50 }).coverageMin?.met,
    ).toBe(true);
  });

  it("plan は送らずに照合した結果を計画済みのカバーとして数える", async () => {
    const path = await writeSpec(
      spec30({
        "/users/{id}": { get: { responses: { "200": { description: "ok" } } } },
        "/other": { get: { responses: { "200": { description: "ok" } } } },
      }),
    );
    const validator = await OpenApiValidator.load([path], { cwd: dir });
    // ベース URL が未解決の変数のままでも、パスで照合する
    validator.plan("GET", "{{baseUrl}}/users/{{userId}}");
    validator.plan("GET", "https://{{host}}/nowhere");
    const summary = validator.summarize({ partial: false, planned: true });
    expect(summary.operations.covered).toBe(1);
    expect(summary.covered[0]).toMatchObject({ operation: "GET /users/{id}", statuses: [] });
    expect(summary.unmatched).toEqual([{ method: "GET", url: "/nowhere", count: 1 }]);
    expect(summary.planned).toBe(true);
  });
});

describe("runLoadedFlows との統合", () => {
  async function fixture() {
    const state = { body: { id: 1, name: "alice" } as unknown, status: 200 };
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/redirect")) {
        res.writeHead(302, { Location: "/users/1" });
        res.end();
        return;
      }
      res.writeHead(state.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.body));
    });
    const { baseUrl } = await listenEphemeral(server);
    return { server, state, base: baseUrl };
  }

  function flowOf(
    base: string,
    steps: { name: string; path: string; assert?: unknown }[],
  ): LoadedFlowEntry {
    const flow: Flow = flowSchema.parse({
      name: "api",
      steps: steps.map((step) => ({
        name: step.name,
        request: { method: "GET", url: `${base}${step.path}` },
        ...(step.assert !== undefined ? { assert: step.assert } : {}),
      })),
    });
    return { filePath: join(dir, "api.yaml"), flow };
  }

  it("仕様に違反した応答はステップを failed にし、仕様どおりなら通る。カバレッジは検証器に集まる", async () => {
    const { server, state, base } = await fixture();
    try {
      const path = await writeSpec(
        spec30({
          "/users/{id}": { get: { responses: { "200": jsonResponse(userSchema) } } },
          "/untested": { get: { responses: { "200": { description: "ok" } } } },
        }),
      );
      const openapi = await OpenApiValidator.load([path], { cwd: dir });
      const entry = flowOf(base, [{ name: "get user", path: "/users/1" }]);
      const ok = await runLoadedFlows([entry], { history: false, openapi });
      expect(ok.status).toBe("passed");
      expect(ok.flows[0]?.steps[0]?.assertions.map((a) => a.kind)).toContain("openapi");

      state.body = { id: "oops" };
      const bad = await runLoadedFlows([entry], { history: false, openapi });
      expect(bad.status).toBe("failed");
      const assertion = bad.flows[0]?.steps[0]?.assertions.find((a) => a.kind === "openapi");
      expect(assertion).toMatchObject({
        ok: false,
        openapi: { state: "invalid", operation: "GET /users/{id}" },
      });

      const summary = openapi.summarize({ partial: false, planned: false });
      expect(summary.operations).toEqual({ total: 2, covered: 1, percent: 50 });
      expect(summary.uncovered).toEqual([expect.objectContaining({ operation: "GET /untested" })]);
      expect(summary.violations).toBe(1);
    } finally {
      await closeServer(server);
    }
  });

  it("--jobs と --data(複数反復)でも検証・集計でき、リダイレクトを追ったステップは対象外にする", async () => {
    const { server, base } = await fixture();
    try {
      const path = await writeSpec(
        spec30({ "/users/{id}": { get: { responses: { "200": jsonResponse(userSchema) } } } }),
      );
      const openapi = await OpenApiValidator.load([path], { cwd: dir });
      const direct = flowOf(base, [{ name: "direct", path: "/users/1" }]);
      const followed: LoadedFlowEntry = {
        filePath: join(dir, "redirect.yaml"),
        flow: flowSchema.parse({
          name: "redirect",
          http: { followRedirects: true },
          steps: [{ name: "via redirect", request: { method: "GET", url: `${base}/redirect` } }],
        }),
      };
      const result = await runLoadedFlows([direct, followed], {
        history: false,
        openapi,
        jobs: 2,
        dataRows: [{ n: "1" }, { n: "2" }, { n: "3" }],
      });
      expect(result.status).toBe("passed");
      const summary = openapi.summarize({ partial: false, planned: false });
      expect(summary.operations.covered).toBe(1);
      expect(summary.excluded).toEqual([
        { flow: "redirect", step: "via redirect", reason: "redirected" },
      ]);
      expect(summary.unmatched).toEqual([]);
    } finally {
      await closeServer(server);
    }
  });

  it("--replay の応答も同じように検証する", async () => {
    // record で保存した応答を replay で再生しても、実ネットワークと同じ経路で検証される
    const { server, base } = await fixture();
    try {
      const path = await writeSpec(
        spec30({ "/users/{id}": { get: { responses: { "200": jsonResponse(userSchema) } } } }),
      );
      const cassetteDir = await mkdtemp(join(dir, "cassette-"));
      const entry = flowOf(base, [{ name: "get user", path: "/users/1" }]);
      await runLoadedFlows([entry], {
        history: false,
        recording: { mode: "record", dir: cassetteDir },
      });
      const openapi = await OpenApiValidator.load([path], { cwd: dir });
      const replayed = await runLoadedFlows([entry], {
        history: false,
        recording: { mode: "replay", dir: cassetteDir },
        openapi,
      });
      expect(replayed.status).toBe("passed");
      expect(
        replayed.flows[0]?.steps[0]?.assertions.some((a) => a.kind === "openapi" && a.ok),
      ).toBe(true);
    } finally {
      await closeServer(server);
    }
  });
});
