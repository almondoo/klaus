import { describe, expect, it } from "vitest";
import { assertBodySchema } from "../src/core/assert.js";
import type { HistoryEntry } from "../src/core/history.js";
import { validateFlowYaml } from "../src/core/loader.js";
import {
  collectStableValues,
  inferJsonSchema,
  type PromoteOptions,
  type PromoteResult,
  promoteRuns,
  renderPromotedYaml,
} from "../src/core/promote.js";

let counter = 0;

type EntryOverrides = { [K in keyof HistoryEntry]?: HistoryEntry[K] | undefined } & {
  step: string;
};

// biome-ignore lint/suspicious/noExplicitAny: テストでは JSON の形を緩く参照するため any を使う
type Loose = any;

function entry(overrides: EntryOverrides): HistoryEntry {
  counter += 1;
  return {
    v: 1,
    runId: "run-1",
    flow: "scenario",
    startedAt: new Date(Date.UTC(2026, 10, 15, 0, 0, counter)).toISOString(),
    durationMs: 5,
    status: "passed",
    request: { method: "GET", url: "http://127.0.0.1:4000/x", headers: {} },
    response: { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } },
    assertions: [],
    ...overrides,
  } as HistoryEntry;
}

const base: PromoteOptions = { assert: "schema", chain: true };

function promote(entries: HistoryEntry[], options: Partial<PromoteOptions> = {}): PromoteResult {
  const outcome = promoteRuns([{ runId: "run-1", entries }], { ...base, ...options });
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.result;
}

function steps(result: PromoteResult): Loose[] {
  return result.flow.steps as Loose[];
}

/** login -> get-me の2ステップ(トークンがレスポンスから後続リクエストへ流れる) */
function loginAndFetch(): HistoryEntry[] {
  return [
    entry({
      step: "login",
      request: {
        method: "POST",
        url: "http://127.0.0.1:4000/login",
        headers: { "content-length": "40", host: "127.0.0.1:4000", "x-api-key": "***" },
        body: { user: "alice", password: "***" },
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: { token: "tok-1234567890abcdef", user: { name: "alice", role: "admin" } },
      },
    }),
    entry({
      step: "get-me",
      request: {
        method: "GET",
        url: "http://127.0.0.1:4000/users/me",
        headers: { authorization: "Bearer tok-1234567890abcdef", "x-api-key": "***" },
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { name: "alice", roles: ["admin"] },
      },
    }),
  ];
}

describe("inferJsonSchema", () => {
  it("型と必須キーのみを推論し、enum / const を使わない(数値は number)", () => {
    const body = { a: 1, b: 1.5, c: "x", d: true, e: null, f: { g: [1] }, h: {}, i: [] };
    expect(inferJsonSchema(body)).toEqual({
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
        c: { type: "string" },
        d: { type: "boolean" },
        e: { type: "null" },
        f: {
          type: "object",
          properties: { g: { type: "array", items: { type: "number" } } },
          required: ["g"],
        },
        h: { type: "object" },
        i: { type: "array" },
      },
      required: ["a", "b", "c", "d", "e", "f", "h", "i"],
    });
  });

  it("配列要素のスキーマを併合する: required は全要素に共通のキーのみ、型が違えば anyOf", () => {
    expect(inferJsonSchema([{ id: "a", x: 1 }, { id: "b" }])).toEqual({
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, x: { type: "number" } },
        required: ["id"],
      },
    });
    expect(inferJsonSchema([1, "a", 2])).toEqual({
      type: "array",
      items: { anyOf: [{ type: "number" }, { type: "string" }] },
    });
  });

  it("推論したスキーマは観測した body 自身を通す", () => {
    const body = {
      items: [
        { id: "a", tags: ["x"] },
        { id: "b", tags: [], note: null },
      ],
      mixed: [1, "a"],
      n: null,
    };
    const results = assertBodySchema(inferJsonSchema(body), body);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe("collectStableValues", () => {
  it("真偽値・小さな整数・短い enum 風の文字列だけを拾い、揮発しそうな値とキーは除外する", () => {
    const body = {
      active: true,
      count: 3,
      status: "active",
      id: 7,
      userId: "u1",
      created_at: "ok",
      token: "abc",
      big: 123456,
      uuid: "123e4567-e89b-12d3-a456-426614174000",
      when: "2026-11-15T00:00:00Z",
      hex: "deadbeefdeadbeef",
      sentence: "hello world",
      masked: "***",
      nothing: null,
      valid: false,
      list: [{ kind: "A" }, { kind: "B" }],
    };
    expect(collectStableValues(body).map((v) => v.path)).toEqual([
      "$.active",
      "$.count",
      "$.status",
      "$.valid",
      "$.list[0].kind",
      "$.list[1].kind",
    ]);
  });
});

describe("promoteRuns", () => {
  it("login -> fetch: リクエスト再構成・ヘッダー除外・プレースホルダー・チェインを生成し、YAML が検証を通る", () => {
    const result = promote(loginAndFetch());
    const [login, getMe] = steps(result);

    expect(login?.request).toEqual({
      method: "POST",
      url: "http://127.0.0.1:4000/login",
      headers: { "x-api-key": "{{env.TODO_X_API_KEY}}" },
      body: { user: "alice", password: "{{env.TODO_BODY_PASSWORD}}" },
    });
    expect(login?.capture).toEqual({ token: "$.token" });
    expect(getMe?.request.headers).toEqual({
      authorization: "Bearer {{token}}",
      "x-api-key": "{{env.TODO_X_API_KEY}}",
    });

    // 同じヘッダーのプレースホルダーはステップをまたいで1つにまとまる
    expect(result.placeholders).toEqual([
      {
        name: "TODO_X_API_KEY",
        locations: ['step "login": header x-api-key', 'step "get-me": header x-api-key'],
      },
      { name: "TODO_BODY_PASSWORD", locations: ['step "login": body $.password'] },
    ]);
    expect(result.captures).toEqual([
      {
        name: "token",
        from: { step: "login", path: "$.token" },
        used: [{ step: "get-me", location: 'header "authorization"' }],
      },
    ]);

    const yaml = renderPromotedYaml(result, ["run-1"]);
    expect(yaml).not.toContain("***");
    expect(yaml.split("\n")[0]).toBe(
      "# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json",
    );
    expect(yaml).toContain("TODO_X_API_KEY");
    expect(validateFlowYaml(yaml).valid).toBe(true);
    expect(result.suggestedPath).toBe("flows/scenario.yaml");
  });

  it("--no-chain 相当ではキャプチャを作らず、記録された値をそのまま残す", () => {
    const result = promote(loginAndFetch(), { chain: false });
    expect(result.captures).toEqual([]);
    expect(steps(result)[0]?.capture).toBeUndefined();
    // チェインしない場合でも、authorization は秘密情報を示すヘッダーなのでリテラルを残さない(方式は Bearer を保つ)
    expect(steps(result)[1]?.request.headers.authorization).toBe(
      "Bearer {{env.TODO_AUTHORIZATION}}",
    );
    expect(JSON.stringify(result.flow)).not.toContain("tok-1234567890abcdef");
  });

  it("assert モード: status / schema(既定)/ values / all の内容が変わる", () => {
    const body = { status: "active", count: 3, name: "alice", items: [{ id: "a" }] };
    const entries = [
      entry({
        step: "s",
        response: {
          status: 201,
          headers: { "content-type": "application/json; charset=utf-8" },
          body,
        },
      }),
    ];
    const assertOf = (assert: PromoteOptions["assert"]) =>
      steps(promote(entries, { assert }))[0]?.assert;

    expect(assertOf("status")).toEqual({ status: 201 });

    const schema = assertOf("schema");
    expect(schema.status).toBe(201);
    expect(schema.headers).toEqual([{ name: "content-type", contains: "application/json" }]);
    expect(schema.bodySchema.type).toBe("object");
    expect(schema.body).toBeUndefined();

    const values = assertOf("values");
    expect(values.bodySchema).toBeUndefined();
    expect(values.body).toEqual([
      { path: "$.status", equals: "active" },
      { path: "$.count", equals: 3 },
      { path: "$.name", equals: "alice" },
    ]);

    const all = assertOf("all");
    expect(all.bodySchema).toBeDefined();
    expect(all.body).toBeDefined();
  });

  it("JSON でない body には status と content-type のみ(注記つき)、空 body は注記なし", () => {
    const text = promote([
      entry({
        step: "html",
        response: { status: 200, headers: { "content-type": "text/html" }, body: "<p>hi</p>" },
      }),
    ]);
    expect(steps(text)[0]?.assert).toEqual({
      status: 200,
      headers: [{ name: "content-type", contains: "text/html" }],
    });
    expect(text.notes).toHaveLength(1);

    const empty = promote([
      entry({ step: "none", response: { status: 204, headers: {}, body: "" } }),
    ]);
    expect(steps(empty)[0]?.assert).toEqual({ status: 204 });
    expect(empty.notes).toEqual([]);
  });

  it("--base-url-var は origin を {{name}} に置き換え、複数 origin は name_2 以降になる", () => {
    const result = promote(
      [
        entry({
          step: "a",
          request: { method: "GET", url: "http://127.0.0.1:4000/a?x=1", headers: {} },
        }),
        entry({ step: "b", request: { method: "GET", url: "https://other.test/b", headers: {} } }),
        entry({
          step: "c",
          request: { method: "GET", url: "http://127.0.0.1:4000/c", headers: {} },
        }),
      ],
      { baseUrlVar: "baseUrl" },
    );
    expect(steps(result).map((s) => s.request.url)).toEqual([
      "{{baseUrl}}/a?x=1",
      "{{baseUrl_2}}/b",
      "{{baseUrl}}/c",
    ]);
    expect(result.baseUrls).toEqual([
      { name: "baseUrl", value: "http://127.0.0.1:4000" },
      { name: "baseUrl_2", value: "https://other.test" },
    ]);
    expect(renderPromotedYaml(result, ["run-1"])).toContain("#   baseUrl: http://127.0.0.1:4000");
  });

  it("URL のマスク値(クエリ値・パスセグメント)もプレースホルダーになる", () => {
    const result = promote([
      entry({
        step: "s",
        request: { method: "GET", url: "http://h/keys/***/items?api_key=***&q=a", headers: {} },
      }),
    ]);
    expect(steps(result)[0]?.request.url).toBe(
      "http://h/keys/{{env.TODO_URL_PATH_2}}/items?api_key={{env.TODO_QUERY_API_KEY}}&q=a",
    );
    expect(result.placeholders.map((p) => p.name)).toEqual([
      "TODO_URL_PATH_2",
      "TODO_QUERY_API_KEY",
    ]);
  });

  it("1つの値に複数の *** があれば NAME, NAME_2 の別プレースホルダーにする", () => {
    const result = promote([
      entry({
        step: "s",
        request: { method: "POST", url: "http://h/x", headers: { "x-multi": "***:***" } },
      }),
    ]);
    expect(steps(result)[0]?.request.headers["x-multi"]).toBe(
      "{{env.TODO_X_MULTI}}:{{env.TODO_X_MULTI_2}}",
    );
  });

  it("チェインは保守的: 数値の body 値・特徴の薄い値・利用者が先に与えた値・origin 全体は対象外", () => {
    const result = promote([
      entry({
        step: "create",
        request: {
          method: "POST",
          url: "http://h/orders",
          headers: {},
          body: { email: "alice@example.com" },
        },
        response: {
          status: 201,
          headers: {},
          body: {
            id: 123456789,
            state: "completed",
            email: "alice@example.com",
            self: "http://h",
            orderRef: "ord-9f8e7d6c",
          },
        },
      }),
      entry({
        step: "use",
        request: {
          method: "POST",
          url: "http://h/orders/completed/alice@example.com/ord-9f8e7d6c",
          headers: {},
          body: { orderId: 123456789, note: "see 123456789 and ord-9f8e7d6c", origin: "http://h" },
        },
      }),
    ]);
    const request = steps(result)[1]?.request;
    // orderRef と、body 文字列内のトークンとしての id が対象。body の数値(orderId)は型を壊すため置換しない
    expect(request.url).toBe("http://h/orders/completed/alice@example.com/{{orderRef}}");
    expect(request.body).toEqual({
      orderId: 123456789,
      note: "see {{id}} and {{orderRef}}",
      origin: "http://h",
    });
    expect(steps(result)[0]?.capture).toEqual({ orderRef: "$.orderRef", id: "$.id" });
  });

  it("数値 id は URL パスセグメントなら文字列として置換できるためチェインする", () => {
    const result = promote([
      entry({
        step: "create",
        request: { method: "POST", url: "http://h/orders", headers: {} },
        response: { status: 201, headers: {}, body: { id: 123456789 } },
      }),
      entry({
        step: "get",
        request: { method: "GET", url: "http://h/orders/123456789?ref=123456789", headers: {} },
      }),
    ]);
    expect(steps(result)[1]?.request.url).toBe("http://h/orders/{{id}}?ref={{id}}");
    expect(steps(result)[0]?.capture).toEqual({ id: "$.id" });
  });

  it("同名のキャプチャが衝突したらステップ名を前置して一意にする(近い方のステップを優先)", () => {
    const result = promote([
      entry({
        step: "first",
        request: { method: "POST", url: "http://h/a", headers: {} },
        response: { status: 200, headers: {}, body: { id: "aaaaaaaa-1111" } },
      }),
      entry({
        step: "second",
        request: { method: "GET", url: "http://h/a/aaaaaaaa-1111", headers: {} },
        response: { status: 200, headers: {}, body: { id: "bbbbbbbb-2222" } },
      }),
      entry({
        step: "third",
        request: { method: "GET", url: "http://h/b/bbbbbbbb-2222/aaaaaaaa-1111", headers: {} },
      }),
    ]);
    expect(steps(result).map((s) => s.capture)).toEqual([
      { id: "$.id" },
      { second_id: "$.id" },
      undefined,
    ]);
    expect(steps(result)[2]?.request.url).toBe("http://h/b/{{second_id}}/{{id}}");
  });

  it("skipped / error / WebSocket / レスポンスなしのステップは理由つきでスキップし、SSE は status のみの sse ステップになる", () => {
    const result = promote([
      entry({ step: "skipped-step", status: "skipped", request: undefined, response: undefined }),
      entry({
        step: "refused",
        status: "error",
        error: 'host "x" is not in guard.allowedHosts',
        response: undefined,
      }),
      entry({
        step: "capture-error",
        status: "error",
        error: 'capture "t" failed',
        request: { method: "GET", url: "http://h/c", headers: {} },
        response: { status: 200, headers: {}, body: { ok: true } },
      }),
      entry({
        step: "ws",
        request: { method: "WS", url: "ws://h/socket", headers: {} },
        response: { status: 101, headers: {}, body: [] },
      }),
      entry({
        step: "stream",
        request: {
          method: "GET",
          url: "http://h/events",
          headers: { accept: "text/event-stream" },
        },
        response: {
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: undefined,
        },
        events: [{ data: "1" }],
      }),
    ]);
    expect(result.skipped.map((s) => [s.step, s.reason])).toEqual([
      ["skipped-step", "skipped step (no request was recorded)"],
      [
        "refused",
        'step ended in error (host "x" is not in guard.allowedHosts); steps that ended in error are not promoted',
      ],
      [
        "capture-error",
        'step ended in error (capture "t" failed); steps that ended in error are not promoted',
      ],
      ["ws", "WebSocket steps are not promoted"],
    ]);
    expect(steps(result)).toHaveLength(1);
    expect(steps(result)[0]).toMatchObject({ name: "stream", sse: {}, assert: { status: 200 } });
    expect(validateFlowYaml(renderPromotedYaml(result, ["run-1"])).valid).toBe(true);
  });

  it("昇格できるステップが無ければ失敗する", () => {
    const outcome = promoteRuns(
      [{ runId: "run-1", entries: [entry({ step: "s", status: "error", response: undefined })] }],
      base,
    );
    expect(outcome).toEqual({
      ok: false,
      message: "no promotable steps (every recorded step was skipped)",
      kind: "content",
    });
  });

  it("単発リクエスト(flow が (single))は method とパスからステップ名を付け、重複は連番にし、api/ に出す", () => {
    const single = (url: string, method = "GET") =>
      entry({
        step: "request",
        flow: "(single)",
        source: "single",
        request: { method, url, headers: {} },
      });
    const result = promote([
      single("http://api.test/users"),
      single("http://api.test/users"),
      single("http://api.test/", "POST"),
    ]);
    expect(steps(result).map((s) => s.name)).toEqual(["get-users", "get-users-2", "post-api-test"]);
    expect(result.flowName).toBe("promoted api.test");

    const one = promote([single("http://api.test/users")]);
    expect(one.suggestedPath).toBe("api/promoted-api-test.yaml");
    expect(promote([single("http://api.test/users")], { name: "Users API" }).suggestedPath).toBe(
      "api/users-api.yaml",
    );
  });

  it("複数の run を与えた順に連結し、チェインも run をまたぐ", () => {
    const first = entry({
      runId: "r1",
      step: "request",
      flow: "(single)",
      request: { method: "POST", url: "http://h/login", headers: {} },
      response: { status: 200, headers: {}, body: { token: "tok-abcdefgh1234" } },
    });
    const second = entry({
      runId: "r2",
      step: "request",
      flow: "(single)",
      request: {
        method: "GET",
        url: "http://h/me",
        headers: { authorization: "Bearer tok-abcdefgh1234" },
      },
    });
    const outcome = promoteRuns(
      [
        { runId: "r1", entries: [first] },
        { runId: "r2", entries: [second] },
      ],
      base,
    );
    if (!outcome.ok) throw new Error(outcome.message);
    expect(steps(outcome.result).map((s) => s.name)).toEqual(["post-login", "get-me"]);
    expect(steps(outcome.result)[1]?.request.headers.authorization).toBe("Bearer {{token}}");
  });

  it("run に複数のフローがあれば --flow を要求し、指定すればそのフローだけを使う", () => {
    const entries = [entry({ step: "a", flow: "one" }), entry({ step: "b", flow: "two" })];
    const ambiguous = promoteRuns([{ runId: "run-1", entries }], base);
    expect(ambiguous).toMatchObject({ ok: false, kind: "usage" });
    expect((ambiguous as { message: string }).message).toContain('"one", "two"');
    const picked = promote(entries, { flow: "two" });
    expect(picked.flowName).toBe("two");
    expect(steps(picked).map((s) => s.name)).toEqual(["b"]);
    expect(promoteRuns([{ runId: "run-1", entries }], { ...base, flow: "none" })).toMatchObject({
      ok: false,
    });
  });

  it("--data 実行は最初のイテレーションだけを昇格する", () => {
    const result = promote([
      entry({
        step: "s",
        iteration: 2,
        request: { method: "GET", url: "http://h/two", headers: {} },
      }),
      entry({
        step: "s",
        iteration: 1,
        request: { method: "GET", url: "http://h/one", headers: {} },
      }),
    ]);
    expect(steps(result).map((s) => s.request.url)).toEqual(["http://h/one"]);
    expect(result.notes[0]).toContain("only iteration 1");
  });

  it("ヘッダー名・body キーの改行は YAML コメントを壊さない", () => {
    const result = promote([
      entry({
        step: "s",
        request: { method: "POST", url: "http://h/x", headers: {}, body: { "bad\nkey": "***" } },
      }),
    ]);
    const yaml = renderPromotedYaml(result, ["run-1"]);
    expect(yaml.split("\n").filter((line) => line.startsWith("#   TODO_"))).toHaveLength(1);
    expect(validateFlowYaml(yaml).valid).toBe(true);
  });
});

function outcomeOf(entries: HistoryEntry[], options: Partial<PromoteOptions> = {}) {
  return promoteRuns([{ runId: "run-1", entries }], { ...base, ...options });
}

describe("promoteRuns: 記録値のリテラルテンプレート", () => {
  const hostile = () => [
    entry({
      step: "first",
      request: { method: "GET", url: "http://h/a", headers: {} },
      response: { status: 200, headers: {}, body: { note: "{{env.CANARY}}" } },
    }),
    entry({
      step: "second",
      request: {
        method: "POST",
        url: "http://h/b?n={{env.CANARY}}",
        headers: { "x-note": "see {{env.CANARY}}" },
        body: { text: "{{env.CANARY}}" },
      },
    }),
  ];

  it("既定では生成を拒否し、ステップと場所を示す(URL・ヘッダー・body・クエリのすべて)", () => {
    const outcome = outcomeOf(hostile());
    expect(outcome).toMatchObject({ ok: false, kind: "content" });
    const message = (outcome as { message: string }).message;
    expect(message).toContain('step "second" url');
    expect(message).toContain('step "second" header "x-note"');
    expect(message).toContain('step "second" body $.text');
    expect(message).toContain("--allow-template-literals");
  });

  it("チェインで置き換えられる値でも、記録値に {{ があれば拒否する", () => {
    const entries = [
      entry({
        step: "first",
        request: { method: "GET", url: "http://h/a", headers: {} },
        response: { status: 200, headers: {}, body: { ref: "{{env.CANARY_12345678}}" } },
      }),
      entry({
        step: "second",
        request: { method: "GET", url: "http://h/b/{{env.CANARY_12345678}}", headers: {} },
      }),
    ];
    expect(outcomeOf(entries)).toMatchObject({ ok: false, kind: "content" });
  });

  it("--allow-template-literals では出力し、警告(notes・YAML コメント・templateLiterals)を付ける", () => {
    const outcome = outcomeOf(hostile(), { allowTemplateLiterals: true });
    if (!outcome.ok) throw new Error(outcome.message);
    const { result } = outcome;
    expect(result.templateLiterals.map((item) => item.location)).toEqual([
      "url",
      'header "x-note"',
      "body $.text",
    ]);
    expect(result.notes.some((note) => note.startsWith("WARNING:"))).toBe(true);
    const yaml = renderPromotedYaml(result, ["run-1"]);
    expect(yaml).toContain('# WARNING: these recorded values contain a literal "{{"');
    expect(validateFlowYaml(yaml).valid).toBe(true);
  });

  it("promote 自身が生成するプレースホルダーとキャプチャは拒否の対象にならない", () => {
    expect(outcomeOf(loginAndFetch())).toMatchObject({ ok: true });
  });
});

describe("promoteRuns: 秘密情報らしい値", () => {
  const sensitiveRequest = () =>
    entry({
      step: "s",
      request: {
        method: "POST",
        url: "http://h/x?api_key=live-key-1&q=plain&sig=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-def_ghi",
        headers: {
          authorization: "Bearer opaque-credential",
          cookie: "sid=abc",
          "x-api-key": "k-12345",
          "x-auth-token": "t",
          "proxy-authorization": "Basic dXNlcjpwdw==",
          "x-note": "hello",
          accept: "application/json",
        },
        body: {
          user: "alice",
          password: "hunter2-plain",
          nested: { clientSecret: "s3", list: ["a", "b"] },
          apiKey: "ak",
          credentials: { pwd: "p" },
          free: "use sk_live_abcdef123456 now",
          note: "plain text",
          pin: 1234,
          author: "bob",
        },
      },
    });

  it("秘密情報を示すヘッダー・body キー・クエリ名の値はリテラルではなく {{env.TODO_*}} になる", () => {
    const result = promote([sensitiveRequest()]);
    const request = steps(result)[0]?.request;
    expect(request.headers).toEqual({
      authorization: "Bearer {{env.TODO_AUTHORIZATION}}",
      cookie: "{{env.TODO_COOKIE}}",
      "x-api-key": "{{env.TODO_X_API_KEY}}",
      "x-auth-token": "{{env.TODO_X_AUTH_TOKEN}}",
      "proxy-authorization": "Basic {{env.TODO_PROXY_AUTHORIZATION}}",
      "x-note": "hello",
      accept: "application/json",
    });
    expect(request.body).toEqual({
      user: "alice",
      password: "{{env.TODO_BODY_PASSWORD}}",
      nested: { clientSecret: "{{env.TODO_BODY_NESTED_CLIENTSECRET}}", list: ["a", "b"] },
      apiKey: "{{env.TODO_BODY_APIKEY}}",
      credentials: { pwd: "{{env.TODO_BODY_CREDENTIALS_PWD}}" },
      free: "use {{env.TODO_BODY_FREE}} now",
      note: "plain text",
      pin: 1234,
      author: "bob",
    });
    expect(request.url).toBe(
      "http://h/x?api_key={{env.TODO_QUERY_API_KEY}}&q=plain&sig={{env.TODO_QUERY_SIG}}",
    );
    const text = JSON.stringify(result.flow);
    for (const leaked of [
      "opaque-credential",
      "sid=abc",
      "k-12345",
      "hunter2-plain",
      "sk_live_abcdef123456",
      "live-key-1",
      "eyJhbGci",
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("置き換えた箇所を redacted と placeholders に列挙する(理由つき)", () => {
    const result = promote([sensitiveRequest()]);
    const byName = new Map(result.redacted.map((item) => [item.name, item]));
    expect(byName.get("TODO_AUTHORIZATION")).toEqual({
      name: "TODO_AUTHORIZATION",
      location: 'step "s": header authorization',
      reason: "sensitive key",
    });
    expect(byName.get("TODO_BODY_FREE")?.reason).toBe("token-like value");
    expect(byName.get("TODO_QUERY_SIG")?.reason).toBe("token-like value");
    for (const item of result.redacted) {
      expect(result.placeholders.map((placeholder) => placeholder.name)).toContain(item.name);
    }
  });

  it("チェインで供給される値は置き換えず、{{name}} のまま残る", () => {
    const result = promote(loginAndFetch());
    expect(steps(result)[1]?.request.headers.authorization).toBe("Bearer {{token}}");
    expect(result.redacted.map((item) => item.location)).not.toContain(
      'step "get-me": header authorization',
    );
  });

  it("トークンらしい文字列(JWT・sk_ 接頭辞・長い高エントロピー文字列)は秘密情報を示さないキーでも置き換え、UUID は置き換えない", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const result = promote([
      entry({
        step: "s",
        request: {
          method: "POST",
          url: `http://h/items/${uuid}`,
          headers: {},
          body: {
            a: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            b: "Zk9xQ2mV7bT4pLw8Yc1RnD6sHj3FgA5uXe0BtKiO",
            c: uuid,
            d: "short",
          },
        },
      }),
    ]);
    const request = steps(result)[0]?.request;
    expect(request.url).toBe(`http://h/items/${uuid}`);
    expect(request.body).toEqual({
      a: "{{env.TODO_BODY_A}}",
      b: "{{env.TODO_BODY_B}}",
      c: uuid,
      d: "short",
    });
  });

  it("--assert values|all でも、秘密情報を示すキー(祖先を含む)とトークンらしい値の equals は作らない", () => {
    const body = {
      apiKey: "live",
      auth: { role: "admin", valid: true },
      credential_type: "basic",
      cookieName: "sid",
      hasPassword: true,
      sk: "sk_live_abcdef123456",
      status: "active",
      author: "bob",
    };
    const paths = collectStableValues(body).map((value) => value.path);
    expect(paths).toEqual(["$.status", "$.author"]);
    const result = promote([entry({ step: "s", response: { status: 200, headers: {}, body } })], {
      assert: "all",
    });
    expect(JSON.stringify(steps(result)[0]?.assert.body)).not.toContain("live");
  });

  it("生成物の先頭コメントとコマンド出力用の notice に、機微情報の確認を促す注意が必ず入る", () => {
    const result = promote(loginAndFetch());
    expect(result.notice).toContain("review this file for sensitive data");
    const yaml = renderPromotedYaml(result, ["run-1"]);
    expect(yaml).toContain(`# NOTICE: ${result.notice}`);
  });
});

describe("promoteRuns: キャプチャ名・マスクの形・深さ", () => {
  it("レスポンスのキーがテンプレート関数名・env でもキャプチャ名には使わない", () => {
    const uuid = (n: string) => `aaaaaaaa-1111-4222-8333-${n.padStart(12, "0")}`;
    const result = promote([
      entry({
        step: "login",
        request: { method: "POST", url: "http://h/login", headers: {} },
        response: {
          status: 200,
          headers: {},
          body: { newUuid: uuid("1"), newDate: uuid("2"), newTimestamp: uuid("3"), env: uuid("4") },
        },
      }),
      entry({
        step: "use",
        request: {
          method: "GET",
          url: `http://h/${uuid("1")}/${uuid("2")}/${uuid("3")}/${uuid("4")}`,
          headers: {},
        },
      }),
    ]);
    const names = result.captures.map((capture) => capture.name);
    expect(names).toEqual(["login_newUuid", "login_newDate", "login_newTimestamp", "login_env"]);
    expect(steps(result)[1]?.request.url).toBe(
      "http://h/{{login_newUuid}}/{{login_newDate}}/{{login_newTimestamp}}/{{login_env}}",
    );
  });

  it("= の無いマスクされたクエリ要素はプレースホルダーになる", () => {
    const result = promote([
      entry({
        step: "s",
        request: { method: "GET", url: "http://h/x?***&a=1&***", headers: {} },
      }),
    ]);
    expect(steps(result)[0]?.request.url).toBe(
      "http://h/x?{{env.TODO_QUERY_PARAM}}&a=1&{{env.TODO_QUERY_PARAM}}",
    );
  });

  it("マスクされた body キー・ヘッダー名・クエリ名は再現できないため、場所を示して拒否する", () => {
    const maskedKey = outcomeOf([
      entry({
        step: "s",
        request: { method: "POST", url: "http://h/x", headers: {}, body: { nested: { "***": 1 } } },
      }),
    ]);
    expect(maskedKey).toMatchObject({ ok: false, kind: "content" });
    expect((maskedKey as { message: string }).message).toContain(
      "step \"s\" body key at $.nested['***']",
    );
    const maskedHeader = outcomeOf([
      entry({
        step: "s",
        request: { method: "GET", url: "http://h/x", headers: { "x-***": "1" } },
      }),
    ]);
    expect((maskedHeader as { message: string }).message).toContain('step "s" header name');
    const maskedQueryName = outcomeOf([
      entry({ step: "s", request: { method: "GET", url: "http://h/x?***=1", headers: {} } }),
    ]);
    expect((maskedQueryName as { message: string }).message).toContain('step "s" url query name');
  });

  it("深く入れ子になった値でスタックを溢れさせない(equals / スキーマ / チェイン候補は深さを制限し、深いリクエスト body は拒否する)", () => {
    const deep = (depth: number): unknown => {
      let value: unknown = { leaf: "ok" };
      for (let i = 0; i < depth; i++) value = { child: value };
      return value;
    };
    const response = { status: 200, headers: {}, body: deep(20000) };
    const result = promote([entry({ step: "s", response })], { assert: "all" });
    expect(steps(result)[0]?.assert.status).toBe(200);
    expect(collectStableValues(deep(20000))).toEqual([]);
    expect(JSON.stringify(inferJsonSchema(deep(20000))).length).toBeLessThan(10000);

    const tooDeep = outcomeOf([
      entry({
        step: "s",
        request: { method: "POST", url: "http://h/x", headers: {}, body: deep(20000) },
      }),
    ]);
    expect(tooDeep).toMatchObject({ ok: false, kind: "content" });
    expect((tooDeep as { message: string }).message).toContain("nested deeper than");
  });
});
