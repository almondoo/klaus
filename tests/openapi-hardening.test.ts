import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ParseError } from "../src/core/errors.js";
import { OpenApiValidator } from "../src/core/openapi.js";
import type { LoadedFlowEntry } from "../src/core/runner.js";
import { runLoadedFlows } from "../src/core/runner.js";
import { flowSchema } from "../src/core/schema.js";
import { closeServer, listenEphemeral } from "./support/net.js";

let dir: string;
const opened: OpenApiValidator[] = [];

beforeAll(async () => {
  await mkdir(join(process.cwd(), "tmp"), { recursive: true });
  dir = await mkdtemp(join(process.cwd(), "tmp", "openapi-hard-"));
});

afterEach(() => {
  for (const validator of opened.splice(0)) validator.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;

async function writeSpec(doc: unknown, name = `spec-${counter++}.json`): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof doc === "string" ? doc : JSON.stringify(doc));
  return path;
}

async function load(paths: string[], options: Parameters<typeof OpenApiValidator.load>[1] = {}) {
  const validator = await OpenApiValidator.load(paths, { cwd: dir, ...options });
  opened.push(validator);
  return validator;
}

const spec = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  openapi: "3.0.3",
  info: { title: "t", version: "1" },
  paths,
  ...extra,
});
const jsonResponse = (schema: unknown) => ({
  description: "ok",
  content: { "application/json": { schema } },
});
const ok200 = (schema: unknown) => ({ get: { responses: { "200": jsonResponse(schema) } } });

function res(body: unknown, status = 200) {
  const bodyText = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers: { "content-type": "application/json" }, body, bodyText };
}

const run = (
  validator: OpenApiValidator,
  url: string,
  response: ReturnType<typeof res>,
  method = "GET",
) => validator.check({ flow: "f", step: "s", method, url, response });

describe("OpenAPI の検証の時間制限(悪意のある pattern)", () => {
  const hostile = { type: "object", properties: { name: { type: "string", pattern: "^(a+)+$" } } };
  const evil = { name: `${"a".repeat(40)}!` };

  it("破滅的な正規表現でも、時間の上限で検証を諦める(skipped・警告)。strict では失敗", async () => {
    const path = await writeSpec(spec({ "/h": ok200(hostile), "/ok": ok200({ type: "object" }) }));
    const validator = await load([path], { validationTimeoutMs: 300 });

    const started = Date.now();
    const result = await run(validator, "http://x/h", res(evil));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3000);
    expect(result[0]).toMatchObject({ ok: true, openapi: { state: "skipped" } });
    expect(result[0]?.message).toContain("time budget");
    expect(validator.warnings.some((w) => w.includes("time budget"))).toBe(true);

    // 同じスキーマは以後、待たずに skipped になる
    const again = Date.now();
    expect((await run(validator, "http://x/h", res(evil)))[0]?.openapi?.state).toBe("skipped");
    expect(Date.now() - again).toBeLessThan(200);

    // ワーカーは起動し直され、別のオペレーションは通常どおり検証できる
    expect((await run(validator, "http://x/ok", res({ a: 1 })))[0]?.openapi?.state).toBe("valid");

    const strict = await load([path], { validationTimeoutMs: 300, strict: true });
    expect((await run(strict, "http://x/h", res(evil)))[0]).toMatchObject({
      ok: false,
      openapi: { state: "skipped" },
    });
  });

  it("--replay の実行でも同じ上限がかかる", async () => {
    const server = createServer((_req, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(evil));
    });
    const { baseUrl } = await listenEphemeral(server);
    try {
      const path = await writeSpec(spec({ "/h": ok200(hostile) }));
      const validator = await load([path], { validationTimeoutMs: 300 });
      const cassette = await mkdtemp(join(dir, "cassette-"));
      const entry: LoadedFlowEntry = {
        filePath: join(dir, "flow.yaml"),
        flow: flowSchema.parse({
          name: "f",
          steps: [{ name: "s", request: { method: "GET", url: `${baseUrl}/h` } }],
        }),
      };
      await runLoadedFlows([entry], {
        history: false,
        recording: { mode: "record", dir: cassette },
      });
      const started = Date.now();
      const result = await runLoadedFlows([entry], {
        history: false,
        recording: { mode: "replay", dir: cassette },
        openapi: validator,
      });
      expect(Date.now() - started).toBeLessThan(3000);
      expect(result.status).toBe("passed");
      expect(result.flows[0]?.steps[0]?.assertions[0]?.openapi?.state).toBe("skipped");
    } finally {
      await closeServer(server);
    }
  });
});

describe("OpenAPI: 参照先ファイルの扱い", () => {
  it("YAML のパース警告を出さない(参照先ファイルの行が stderr に漏れない)", async () => {
    await writeFile(
      join(dir, "vault.yaml"),
      "Secret:\n  type: object\n  api_key: !vault SECRET-LINE\n",
    );
    const path = await writeSpec(
      spec({ "/v": ok200({ $ref: "./vault.yaml#/Secret" }) }),
      "with-vault.json",
    );
    const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const write = vi.spyOn(process.stderr, "write");
    try {
      await load([path]);
      expect(emit).not.toHaveBeenCalled();
      expect(write.mock.calls.flat().join("")).not.toContain("SECRET-LINE");
    } finally {
      emit.mockRestore();
      write.mockRestore();
    }
  });

  it("$ref は、ルートの文書のディレクトリの外・存在しないファイル・外を指すリンクを、同じメッセージで拒否する", async () => {
    const outside = await mkdtemp(join(process.cwd(), "tmp", "openapi-outside-"));
    try {
      await writeFile(
        join(outside, "secret.yaml"),
        "Enum:\n  type: string\n  enum: [SUPERSECRET_ENUM]\n",
      );
      const sub = join(dir, "confined");
      await mkdir(sub, { recursive: true });
      await symlink(outside, join(sub, "linked"));
      const refs = [
        `${outside}/secret.yaml#/Enum`,
        "../missing-file.yaml#/Enum",
        "./linked/secret.yaml#/Enum",
      ];
      const messages: string[] = [];
      for (const ref of refs) {
        const path = join(sub, "root.json");
        await writeFile(path, JSON.stringify(spec({ "/v": ok200({ $ref: ref }) })));
        const error = await OpenApiValidator.load([path], { cwd: dir }).catch((e: unknown) => e);
        expect(error, ref).toBeInstanceOf(ParseError);
        const text = (error as Error).message;
        expect(text).toContain("cannot be resolved");
        // 対処(参照先をルートのディレクトリの下に置く・仕様を 1 ファイルにまとめる)も、同じメッセージで案内する
        expect(text).toContain("place the referenced files under that directory");
        expect(text).toContain("bundle the document into a single file");
        expect(text).not.toContain("SUPERSECRET_ENUM");
        messages.push(text.replace(/\$ref "[^"]*"/, "$ref"));
      }
      // 存在しない・外にある・リンクのどれでも、メッセージの形は同じ(ファイルの有無を探れない)
      expect(new Set(messages).size).toBe(1);
      // ルートのディレクトリの下なら読める
      await mkdir(join(sub, "schemas"), { recursive: true });
      await writeFile(join(sub, "schemas", "ok.yaml"), "T:\n  type: object\n");
      const inside = join(sub, "inside.json");
      await writeFile(
        inside,
        JSON.stringify(spec({ "/v": ok200({ $ref: "./schemas/ok.yaml#/T" }) })),
      );
      await load([inside]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("OpenAPI: 検証の正確さ", () => {
  it("検証が弱くなったスキーマ(循環する別名)は、valid ではなく skipped(strict では失敗)", async () => {
    const doc = spec(
      { "/a": ok200({ $ref: "#/components/schemas/A" }) },
      {
        components: {
          schemas: { A: { $ref: "#/components/schemas/B" }, B: { $ref: "#/components/schemas/A" } },
        },
      },
    );
    const path = await writeSpec(doc);
    const lenient = await load([path]);
    expect((await run(lenient, "http://x/a", res({ any: 1 })))[0]).toMatchObject({
      ok: true,
      openapi: { state: "skipped" },
    });
    const strict = await load([path], { strict: true });
    expect((await run(strict, "http://x/a", res({ any: 1 })))[0]?.ok).toBe(false);
  });

  it("$dynamicRef を含む 3.1 のスキーマも skipped", async () => {
    const path = await writeSpec({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: { "/d": ok200({ type: "object", properties: { x: { $dynamicRef: "#node" } } }) },
    });
    const validator = await load([path]);
    expect((await run(validator, "http://x/d", res({ x: 1 })))[0]?.openapi?.state).toBe("skipped");
  });

  it("サーバー変数の既定値が / を含んでも(複数セグメント)照合できる", async () => {
    const path = await writeSpec(
      spec(
        { "/users/{id}": ok200({ type: "object" }) },
        { servers: [{ url: "/{base}", variables: { base: { default: "api/v1" } } }] },
      ),
    );
    const validator = await load([path]);
    expect((await run(validator, "http://h/api/v1/users/42", res({})))[0]?.openapi?.operation).toBe(
      "GET /users/{id}",
    );
    expect(await run(validator, "http://h/api/v1/nope/42", res({}))).toHaveLength(0);
  });

  it("YAML のマージキー(<<)を解釈する(弱くなったスキーマで検証しない)", async () => {
    const yaml = [
      "openapi: 3.0.3",
      "info: {title: t, version: '1'}",
      "x-base: &base",
      "  type: object",
      "  required: [id]",
      "paths:",
      "  /m:",
      "    get:",
      "      responses:",
      "        '200':",
      "          description: ok",
      "          content:",
      "            application/json:",
      "              schema:",
      "                <<: *base",
      "                properties: {id: {type: integer}}",
      "",
    ].join("\n");
    const validator = await load([await writeSpec(yaml, "merge.yaml")]);
    expect((await run(validator, "http://x/m", res({ id: 1 })))[0]?.ok).toBe(true);
    const bad = await run(validator, "http://x/m", res({}));
    expect(bad[0]?.openapi?.violations?.[0]?.message).toContain("required property 'id'");
  });

  it("allOf の別の分岐で writeOnly と宣言されたプロパティは、required にあっても必須にしない", async () => {
    const path = await writeSpec(
      spec(
        {
          "/a": ok200({
            allOf: [
              { type: "object", required: ["id", "password"] },
              { type: "object", properties: { password: { type: "string", writeOnly: true } } },
            ],
          }),
          "/b": ok200({
            allOf: [
              { $ref: "#/components/schemas/Base" },
              { type: "object", properties: { password: { type: "string", writeOnly: true } } },
            ],
          }),
        },
        { components: { schemas: { Base: { type: "object", required: ["id", "password"] } } } },
      ),
    );
    const validator = await load([path]);
    for (const url of ["http://x/a", "http://x/b"]) {
      expect((await run(validator, url, res({ id: 1 })))[0]?.ok, url).toBe(true);
      expect((await run(validator, url, res({})))[0]?.ok, url).toBe(false);
    }
  });

  it("3.1 の nullable は仕様に無いキーワードなので無視し、警告する", async () => {
    const path = await writeSpec({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/n": ok200({ type: "object", properties: { v: { type: "string", nullable: true } } }),
      },
    });
    const validator = await load([path]);
    expect((await run(validator, "http://x/n", res({ v: null })))[0]?.ok).toBe(false);
    expect(validator.warnings.some((w) => w.includes("nullable"))).toBe(true);
  });

  it("`/users/x/../me` は、実際に送られる(正規化後の)パスで照合する", async () => {
    const path = await writeSpec(
      spec({ "/users/me": ok200({ type: "object" }), "/users/{id}": ok200({ type: "object" }) }),
    );
    const validator = await load([path]);
    expect((await run(validator, "http://x/users/x/../me", res({})))[0]?.openapi?.operation).toBe(
      "GET /users/me",
    );
    expect(
      (await run(validator, "http://x/users/./7/%2e%2e/me", res({})))[0]?.openapi?.operation,
    ).toBe("GET /users/me");
    expect(
      (await run(validator, "http://x/users/../../../users/7", res({})))[0]?.openapi?.operation,
    ).toBe("GET /users/{id}");
  });

  it("再帰するスキーマに深い本文を与えても、RangeError にならず skipped(上限内なら検証できる)", async () => {
    const path = await writeSpec(
      spec(
        { "/t": ok200({ $ref: "#/components/schemas/Tree" }) },
        {
          components: {
            schemas: {
              Tree: { type: "object", properties: { next: { $ref: "#/components/schemas/Tree" } } },
            },
          },
        },
      ),
    );
    const validator = await load([path]);
    const nested = (depth: number): unknown => {
      let value: unknown = {};
      for (let i = 0; i < depth; i++) value = { next: value };
      return value;
    };
    expect((await run(validator, "http://x/t", res(nested(300))))[0]?.openapi?.state).toBe("valid");
    const deep = await run(validator, "http://x/t", res(nested(5000)));
    expect(deep[0]).toMatchObject({ ok: true, openapi: { state: "skipped" } });
    expect(deep[0]?.message).toContain("nested deeper");
  });
});
