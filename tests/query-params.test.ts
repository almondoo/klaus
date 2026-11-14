import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { expandSecretVariants, maskString } from "../src/core/history.js";
import { executeFlow, expandStepRequest } from "../src/core/runner.js";
import type { Step } from "../src/core/schema.js";
import { flowSchema, stepSchema } from "../src/core/schema.js";
import type { TemplateContext } from "../src/core/template.js";
import { closeServer, listenEphemeral } from "./support/net.js";

function expandUrl(
  url: string,
  query: Record<string, string>,
  context: Partial<TemplateContext> = {},
): string {
  const step: Step = stepSchema.parse({ name: "s", request: { method: "GET", url, query } });
  return expandStepRequest(step, { captures: {}, env: {}, ...context }).snapshot.url;
}

describe("request.query のマージ", () => {
  it("URL に書かれたクエリは組み直さず、書かれたままの文字列で保ち、追加分だけを後ろに足す", () => {
    expect(expandUrl("http://h/p?token=a&b+c=d/e&&z=%2F", { x: "1" })).toBe(
      "http://h/p?token=a&b+c=d/e&&z=%2F&x=1",
    );
  });

  it("同名キーは最初の出現位置で query 側の値に置き換え、以降の同名は取り除く(文書化された上書きルール)", () => {
    expect(expandUrl("http://h/p?a=1&b=2&a=3&c=4", { a: "new" })).toBe("http://h/p?a=new&b=2&c=4");
    // キー名は URL エンコードされていても同名として扱う
    expect(expandUrl("http://h/p?a%20b=1", { "a b": "2" })).toBe("http://h/p?a+b=2");
  });

  it("追加する値は form-urlencoded でエンコードし、クエリの無い URL は従来どおり正規化して ? を足す", () => {
    expect(expandUrl("http://127.0.0.1:1234", { q: "a b&c" })).toBe(
      "http://127.0.0.1:1234/?q=a+b%26c",
    );
  });

  it("フラグメントは保たれる", () => {
    expect(expandUrl("http://h/p?a=1#frag", { b: "2" })).toBe("http://h/p?a=1&b=2#frag");
  });

  it("dry-run で未解決のまま残した {{name}} は、パーセントエンコードされず、そのまま読める", () => {
    const context = { deferred: new Set(["token", "host"]), unresolved: new Set<string>() };
    expect(
      expandUrl("{{host}}/x", { a: "1", t: "{{token}}", mixed: "pre {{token}}&" }, context),
    ).toBe("{{host}}/x?a=1&t={{token}}&mixed=pre+{{token}}%26");
  });

  it("URL として読めない場合は RuntimeError(TypeError ではない)", () => {
    expect(() => expandUrl("not a url", { a: "1" })).toThrow("not a valid URL");
  });
});

describe("& + = / を含むシークレットを URL のクエリに直接書いた場合", () => {
  const KEY = "KLAUS_QUERY_TEST_SECRET";
  const SECRET = "a&b+c=d/e-secret";
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    delete process.env[KEY];
    if (server) await closeServer(server);
    server = undefined;
  });

  it("query: と併用しても、サーバーに届く値は壊れず、履歴のマスクは値全体に効く", async () => {
    process.env[KEY] = SECRET;
    const received: string[] = [];
    server = createServer((req, res) => {
      received.push(req.url ?? "");
      res.end("ok");
    });
    const { baseUrl } = await listenEphemeral(server);
    const flow = flowSchema.parse({
      name: "f",
      steps: [
        {
          name: "s",
          request: {
            method: "GET",
            url: `${baseUrl}/p?token={{env.${KEY}}}`,
            query: { x: "1" },
          },
        },
      ],
    });
    const entries: { request?: { url: string } }[] = [];
    const result = await executeFlow(flow, "f.yaml", {
      history: (entry) => {
        entries.push(entry);
      },
    });

    // 書いたとおりのクエリが届く(再分割・再エンコードされない)
    expect(received).toEqual([`/p?token=${SECRET}&x=1`]);
    expect(result.steps[0]?.status).toBe("passed");
    // 履歴の URL は秘密値の全体がマスクされ、一部も残らない
    const recorded = entries[0]?.request?.url ?? "";
    expect(recorded).toBe(`${baseUrl}/p?token=***&x=1`);
    expect(maskString(`token=${SECRET}`, expandSecretVariants([SECRET]))).toBe("token=***");
  });
});
