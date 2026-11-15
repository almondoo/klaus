import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { assertBody, assertHeaders, assertStatus, evaluateAssertions } from "../src/core/assert.js";
import { captureValues, executeFlow } from "../src/core/runner.js";
import { flowSchema } from "../src/core/schema.js";
import { closeServer, listenEphemeral } from "./support/net.js";

describe("assertStatus の拡張形式", () => {
  it("数値の配列はいずれかに一致すれば ok", () => {
    expect(assertStatus([200, 201], 201)[0]?.ok).toBe(true);
    const miss = assertStatus([200, 201], 204)[0];
    expect(miss?.ok).toBe(false);
    expect(miss?.message).toBe("expected status one of [200, 201] but got 204");
  });

  it('"2xx" 形式はクラスで判定する(大文字 X も許す)', () => {
    expect(assertStatus("2xx", 299)[0]?.ok).toBe(true);
    expect(assertStatus("2XX", 204)[0]?.ok).toBe(true);
    expect(assertStatus("2xx", 300)[0]?.ok).toBe(false);
    expect(assertStatus("4xx", 404)[0]?.ok).toBe(true);
    expect(assertStatus("2xx", 199)[0]?.ok).toBe(false);
  });

  it("スキーマは不正な形式(空配列・3xxx・文字列の数字)を拒否する", () => {
    const parse = (status: unknown) =>
      flowSchema.safeParse({
        name: "f",
        steps: [{ name: "s", request: { method: "GET", url: "http://x" }, assert: { status } }],
      }).success;
    expect(parse([])).toBe(false);
    expect(parse("20x")).toBe(false);
    expect(parse("200")).toBe(false);
    expect(parse("2xx")).toBe(true);
    expect(parse([200, 204])).toBe(true);
    expect(parse(200)).toBe(true);
  });
});

describe("比較系マッチャー(body)", () => {
  const json = { n: 5, s: "hello", list: [1, 2, 3], obj: { a: 1 }, nil: null, f: 1.5, str: "7" };
  const run = (def: Record<string, unknown>) =>
    assertBody([{ path: "$.x", ...def }] as never, { x: undefined, ...json });
  const at = (path: string, def: Record<string, unknown>) =>
    assertBody([{ path, ...def }] as never, json);

  it("gt / gte / lt / lte は数値だけを比較し、境界は gte / lte のみ含む", () => {
    expect(at("$.n", { gt: 4 })[0]?.ok).toBe(true);
    expect(at("$.n", { gt: 5 })[0]?.ok).toBe(false);
    expect(at("$.n", { gte: 5 })[0]?.ok).toBe(true);
    expect(at("$.n", { lt: 6 })[0]?.ok).toBe(true);
    expect(at("$.n", { lt: 5 })[0]?.ok).toBe(false);
    expect(at("$.n", { lte: 5 })[0]?.ok).toBe(true);
    expect(at("$.n", { gte: 1, lte: 4 }).map((r) => r.ok)).toEqual([true, false]);
  });

  it("body では数値文字列を数値として扱わない / 存在しない値は失敗", () => {
    const r = at("$.str", { gt: 1 })[0];
    expect(r?.ok).toBe(false);
    expect(r?.message).toContain('expected a number > 1 but got "7"');
    expect(at("$.missing", { lt: 100 })[0]?.ok).toBe(false);
  });

  it("length: 数値は完全一致、{min,max} は範囲(片側のみも可)。文字列と配列だけが対象", () => {
    expect(at("$.s", { length: 5 })[0]?.ok).toBe(true);
    expect(at("$.list", { length: 3 })[0]?.ok).toBe(true);
    expect(at("$.list", { length: 2 })[0]?.ok).toBe(false);
    expect(at("$.list", { length: { min: 1, max: 3 } })[0]?.ok).toBe(true);
    expect(at("$.list", { length: { min: 4 } })[0]?.ok).toBe(false);
    expect(at("$.list", { length: { max: 2 } })[0]?.ok).toBe(false);
    const obj = at("$.obj", { length: 1 })[0];
    expect(obj?.ok).toBe(false);
    expect(obj?.message).toContain("length applies to strings and arrays but the value is object");
  });

  it("type: JSON 型で判定し、integer は整数だけ、number は整数も含む", () => {
    expect(at("$.s", { type: "string" })[0]?.ok).toBe(true);
    expect(at("$.n", { type: "integer" })[0]?.ok).toBe(true);
    expect(at("$.f", { type: "integer" })[0]?.ok).toBe(false);
    expect(at("$.f", { type: "number" })[0]?.ok).toBe(true);
    expect(at("$.n", { type: "number" })[0]?.ok).toBe(true);
    expect(at("$.list", { type: "array" })[0]?.ok).toBe(true);
    expect(at("$.obj", { type: "object" })[0]?.ok).toBe(true);
    expect(at("$.list", { type: "object" })[0]?.ok).toBe(false);
    expect(at("$.nil", { type: "null" })[0]?.ok).toBe(true);
    const missing = at("$.missing", { type: "string" })[0];
    expect(missing?.ok).toBe(false);
    expect(missing?.message).toContain("but got missing");
  });

  it("oneOf: いずれかと構造的に等しければ ok(オブジェクトも比較できる)", () => {
    expect(at("$.s", { oneOf: ["x", "hello"] })[0]?.ok).toBe(true);
    expect(at("$.s", { oneOf: ["x", "y"] })[0]?.ok).toBe(false);
    expect(at("$.obj", { oneOf: [{ a: 1 }] })[0]?.ok).toBe(true);
    expect(at("$.n", { oneOf: ["5"] })[0]?.ok).toBe(false);
  });

  it("未使用のマッチャーは結果を増やさない", () => {
    expect(run({ exists: true })).toHaveLength(1);
  });
});

describe("比較系マッチャー(header)", () => {
  const headers = { "Content-Length": "42", "X-Mode": "fast", "X-Ratio": "abc" };

  it("数値文字列は数値として比較できる(非数値は失敗)", () => {
    const r = assertHeaders(
      [
        { name: "content-length", gt: 10, lte: 42 },
        { name: "x-ratio", gt: 1 },
      ],
      headers,
    );
    expect(r.map((x) => x.ok)).toEqual([true, true, false]);
  });

  it("数値として扱うのは 10 進表記だけ(0x10 の 16 進・1e3 の指数・Infinity は数値ではない)", () => {
    const h = {
      A: "0x10",
      B: "1e3",
      C: "Infinity",
      D: "-5",
      E: "3.5",
      F: " 7 ",
      G: ".5",
      H: "0b11",
    };
    const ok = (name: string, def: Record<string, number>) =>
      assertHeaders([{ name, ...def }] as never, h)[0]?.ok;
    expect(ok("A", { gte: 0 })).toBe(false);
    expect(ok("B", { gte: 0 })).toBe(false);
    expect(ok("C", { gte: 0 })).toBe(false);
    expect(ok("H", { gte: 0 })).toBe(false);
    expect(ok("D", { lt: 0 })).toBe(true);
    expect(ok("E", { gt: 3, lt: 4 })).toBe(true);
    expect(ok("F", { gte: 7, lte: 7 })).toBe(true);
    expect(ok("G", { gt: 0.4 })).toBe(true);
  });

  it("length / type / oneOf が使える", () => {
    const r = assertHeaders(
      [{ name: "X-Mode", length: 4, type: "string", oneOf: ["fast", "slow"] }],
      headers,
    );
    expect(r.map((x) => x.ok)).toEqual([true, true, true]);
    expect(assertHeaders([{ name: "X-Mode", oneOf: ["slow"] }], headers)[0]?.ok).toBe(false);
    expect(assertHeaders([{ name: "X-None", type: "string" }], headers)[0]?.ok).toBe(false);
  });

  it("evaluateAssertions から status の配列形式と組み合わせて評価される", () => {
    const results = evaluateAssertions(
      { status: "2xx", headers: [{ name: "X-Mode", oneOf: ["fast"] }] },
      { status: 201, headers, body: undefined, bodyText: "", durationMs: 1 },
    );
    expect(results.map((r) => r.kind)).toEqual(["status", "header.oneOf"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe("captureValues(オブジェクト形式)", () => {
  const response = (cookie: Record<string, string> = {}) => ({
    status: 201,
    headers: { "Content-Type": "text/plain", "X-Request-Id": "req-9" },
    bodyText: "order=ord_123;total=42",
    cookie: (name: string) => cookie[name],
  });
  const cap = (def: unknown, res = response()) =>
    captureValues({ v: def } as never, undefined, "step", res).v;

  it("header は大文字小文字を無視して取る。無ければ値を含まないエラー", () => {
    expect(cap({ header: "x-request-id" })).toBe("req-9");
    expect(() => cap({ header: "X-Missing" })).toThrow('response header "X-Missing" not found');
  });

  it("cookie は jar の値。無ければ http.cookies の案内つきエラー", () => {
    expect(cap({ cookie: "sid" }, response({ sid: "abc" }))).toBe("abc");
    expect(() => cap({ cookie: "sid" })).toThrow("is http.cookies enabled?");
  });

  it("regex はグループ省略時に 1(グループが無ければ 0)、group 指定でその番号を取る", () => {
    expect(cap({ regex: "order=(\\w+)" })).toBe("ord_123");
    expect(cap({ regex: "ord_\\d+" })).toBe("ord_123");
    expect(cap({ regex: "order=(\\w+);total=(\\d+)", group: 2 })).toBe("42");
    expect(cap({ regex: "order=(\\w+);total=(\\d+)", group: 0 })).toBe("order=ord_123;total=42");
  });

  it("regex の不一致・グループ範囲外・不正な正規表現は error(本文を含めない)", () => {
    expect(() => cap({ regex: "nope=(\\d+)" })).toThrow("matched nothing");
    expect(() => cap({ regex: "order=(\\w+)", group: 3 })).toThrow("has no group 3");
    expect(() => cap({ regex: "(" })).toThrow("invalid regex");
    try {
      cap({ regex: "nope=(\\d+)" });
    } catch (error) {
      expect(String(error)).not.toContain("ord_123");
    }
  });

  it("status は数値のまま取れる", () => {
    expect(cap({ status: true })).toBe(201);
  });

  it("オブジェクト形式はレスポンス情報が無い呼び出しでは error、文字列形式は従来どおり", () => {
    expect(() => captureValues({ v: { status: true } }, {}, "s")).toThrow("need an HTTP response");
    expect(captureValues({ v: "$.a" }, { a: 1 }, "s")).toEqual({ v: 1 });
  });

  it("スキーマは複数キーの混在(header と cookie 同時指定)を拒否する", () => {
    const parse = (capture: unknown) =>
      flowSchema.safeParse({
        name: "f",
        steps: [{ name: "s", request: { method: "GET", url: "http://x" }, capture }],
      }).success;
    expect(parse({ v: { header: "a", cookie: "b" } })).toBe(false);
    expect(parse({ v: { status: false } })).toBe(false);
    expect(parse({ v: { regex: "x", group: -1 } })).toBe(false);
    expect(parse({ v: { header: "a" } })).toBe(true);
    expect(parse({ v: "$.a" })).toBe(true);
  });
});

describe("executeFlow での header / cookie / regex / status の capture", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await closeServer(server);
  });

  async function start(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    const server = createServer(handler);
    servers.push(server);
    return listenEphemeral(server);
  }

  it("後続ステップのテンプレートで使え、リダイレクト先で付いた cookie も取れる", async () => {
    const seen: string[] = [];
    const { baseUrl } = await start((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/landing", "Set-Cookie": "sid=cookie-value-1; Path=/" });
        res.end();
        return;
      }
      if (req.url === "/landing") {
        res.writeHead(200, { "Content-Type": "text/plain", "X-Trace": "trace-77" });
        res.end("ticket=T-555 done");
        return;
      }
      seen.push(
        `${req.url} ${req.headers["x-trace"]} ${req.headers["x-ticket"]} ${req.headers["x-code"]} ${req.headers["x-sid"]}`,
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    const flow = flowSchema.parse({
      name: "f",
      http: { cookies: true, followRedirects: true },
      steps: [
        {
          name: "first",
          request: { method: "GET", url: `${baseUrl}/start` },
          capture: {
            trace: { header: "X-Trace" },
            ticket: { regex: "ticket=(\\S+)" },
            code: { status: true },
            sid: { cookie: "sid" },
          },
        },
        {
          name: "second",
          request: {
            method: "GET",
            url: `${baseUrl}/use`,
            headers: {
              "X-Trace": "{{trace}}",
              "X-Ticket": "{{ticket}}",
              "X-Code": "{{code}}",
              "X-Sid": "{{sid}}",
            },
          },
          assert: { status: [200] },
        },
      ],
    });
    const result = await executeFlow(flow, "flow.yaml", { history: () => {} });
    expect(result.steps[0]?.error).toBeUndefined();
    expect(result.steps.map((s) => s.status)).toEqual(["passed", "passed"]);
    expect(seen).toEqual(["/use trace-77 T-555 200 cookie-value-1"]);
  });

  it("cookies を有効にしていない run で cookie capture すると step は error", async () => {
    const { baseUrl } = await start((_req, res) => {
      res.writeHead(200, { "Set-Cookie": "sid=v; Path=/" });
      res.end();
    });
    const flow = flowSchema.parse({
      name: "f",
      steps: [
        {
          name: "s",
          request: { method: "GET", url: `${baseUrl}/` },
          capture: { sid: { cookie: "sid" } },
        },
      ],
    });
    const result = await executeFlow(flow, "flow.yaml", { history: () => {} });
    expect(result.steps[0]?.status).toBe("error");
    expect(result.steps[0]?.error).toContain("is http.cookies enabled?");
  });
});
