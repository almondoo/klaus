import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dryRunFlow } from "../src/core/dry-run.js";
import type { HistoryEntry } from "../src/core/history.js";
import { executeFlow } from "../src/core/runner.js";
import { flowSchema, requestSchema } from "../src/core/schema.js";
import { closeServer, listenEphemeral } from "./support/net.js";

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

const servers: Server[] = [];
const tmpDirs: string[] = [];
let cwd: string;

async function start(handler: (req: IncomingMessage, res: ServerResponse) => void = ok) {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      handler(req, res);
    });
  });
  servers.push(server);
  const { baseUrl, port } = await listenEphemeral(server);
  return { baseUrl, port, requests };
}

function ok(_req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("ok");
}

async function makeTmp(): Promise<string> {
  const root = join(process.cwd(), "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "body-"));
  tmpDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  cwd = await makeTmp();
});

afterEach(async () => {
  for (const server of servers.splice(0)) await closeServer(server);
  for (const dir of tmpDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env.KLAUS_BODY_TEST_SECRET;
});

const flowOf = (request: Record<string, unknown>, http?: unknown) =>
  flowSchema.parse({
    name: "f",
    ...(http ? { http } : {}),
    steps: [{ name: "s", request: { method: "POST", ...request } }],
  });

async function run(
  flow: ReturnType<typeof flowOf>,
  options: Parameters<typeof executeFlow>[2] = {},
) {
  const entries: HistoryEntry[] = [];
  const result = await executeFlow(flow, "flow.yaml", {
    cwd,
    history: (entry) => {
      entries.push(entry);
    },
    ...options,
  });
  return { result, entries, step: result.steps[0], entry: entries[0] };
}

describe("form", () => {
  it("application/x-www-form-urlencoded として送り、Content-Type を補う(指定があれば尊重する)", async () => {
    const api = await start();
    const { step } = await run(
      flowOf({ url: `${api.baseUrl}/f`, form: { name: "a b", q: "x&y=z", empty: "" } }),
    );
    expect(step?.status).toBe("passed");
    expect(api.requests[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(api.requests[0]?.body.toString()).toBe("name=a+b&q=x%26y%3Dz&empty=");

    await run(
      flowOf({
        url: `${api.baseUrl}/f`,
        headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        form: { a: "1" },
      }),
    );
    expect(api.requests[1]?.headers["content-type"]).toBe(
      "application/x-www-form-urlencoded; charset=utf-8",
    );
  });

  it("値はテンプレート展開され、秘密値(エンコード形を含む)は履歴でマスクされる", async () => {
    process.env.KLAUS_BODY_TEST_SECRET = "p&ss+w=rd/9";
    const api = await start();
    const { entry } = await run(
      flowOf({ url: `${api.baseUrl}/f`, form: { password: "{{env.KLAUS_BODY_TEST_SECRET}}" } }),
    );
    expect(api.requests[0]?.body.toString()).toBe("password=p%26ss%2Bw%3Drd%2F9");
    expect(entry?.request?.body).toBe("password=***");
    expect(JSON.stringify(entry)).not.toContain("p%26ss");
  });
});

describe("multipart", () => {
  it("テキストとファイルを multipart/form-data で送り、履歴にはファイル名とサイズだけを残す", async () => {
    await writeFile(join(cwd, "report.txt"), "FILE-CONTENT-123");
    const api = await start();
    const { step, entry } = await run(
      flowOf({
        url: `${api.baseUrl}/up`,
        // ユーザー指定の Content-Type は boundary を壊すため無視される
        headers: { "Content-Type": "multipart/form-data" },
        multipart: {
          title: "hello",
          upload: { file: "report.txt", contentType: "text/plain" },
          renamed: { file: "./report.txt", filename: "x.bin" },
        },
      }),
    );
    expect(step?.status).toBe("passed");

    const received = api.requests[0];
    expect(received?.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const body = received?.body.toString() ?? "";
    expect(body).toContain('name="title"\r\n\r\nhello');
    expect(body).toContain('name="upload"; filename="report.txt"');
    expect(body).toContain("Content-Type: text/plain");
    expect(body).toContain('name="renamed"; filename="x.bin"');
    expect(body.match(/FILE-CONTENT-123/g)).toHaveLength(2);

    // 履歴・結果の request.body はファイルの内容を持たない
    const snapshot = entry?.request?.body as Record<string, unknown>;
    expect(snapshot.title).toBe("hello");
    expect(snapshot.upload).toEqual({
      file: "report.txt",
      filename: "report.txt",
      contentType: "text/plain",
      size: 16,
    });
    expect(snapshot.renamed).toEqual({ file: "report.txt", filename: "x.bin", size: 16 });
    expect(JSON.stringify(entry)).not.toContain("FILE-CONTENT-123");
    expect(entry?.request?.headers["Content-Type"]).toBe("multipart/form-data");
  });

  it("テキストフィールドの秘密値は履歴でマスクされる", async () => {
    process.env.KLAUS_BODY_TEST_SECRET = "multipart-secret-77";
    const api = await start();
    const { entry } = await run(
      flowOf({
        url: `${api.baseUrl}/up`,
        multipart: { token: "{{env.KLAUS_BODY_TEST_SECRET}}" },
      }),
    );
    expect(api.requests[0]?.body.toString()).toContain("multipart-secret-77");
    expect(JSON.stringify(entry)).not.toContain("multipart-secret-77");
  });

  it("307 / 308 のリダイレクトではボディを再送し、301 / 302 の POST は GET に変わる", async () => {
    await writeFile(join(cwd, "a.txt"), "REDIRECT-FILE");
    const target = await start();
    const origin = await start((req, res) => {
      res.writeHead(Number(req.url?.slice(1)), { Location: `${target.baseUrl}/t` });
      res.end();
    });
    const multipart = { f: { file: "a.txt" }, t: "text" };
    await run(flowOf({ url: `${origin.baseUrl}/307`, multipart }, { followRedirects: true }));
    await run(flowOf({ url: `${origin.baseUrl}/302`, multipart }, { followRedirects: true }));
    expect(target.requests[0]?.method).toBe("POST");
    expect(target.requests[0]?.body.toString()).toContain("REDIRECT-FILE");
    expect(target.requests[0]?.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(target.requests[1]?.method).toBe("GET");
    expect(target.requests[1]?.body.length).toBe(0);
  });
});

describe("bodyFile", () => {
  it("ファイルのバイト列をそのまま送り、Content-Type は補わない(指定があれば使う)", async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f]);
    await writeFile(join(cwd, "data.bin"), bytes);
    const api = await start();
    const { step, entry } = await run(flowOf({ url: `${api.baseUrl}/b`, bodyFile: "data.bin" }));
    expect(step?.status).toBe("passed");
    expect(api.requests[0]?.body.equals(bytes)).toBe(true);
    expect(api.requests[0]?.headers["content-type"]).toBeUndefined();
    expect(entry?.request?.body).toEqual({ bodyFile: "data.bin", size: 5 });

    await run(
      flowOf({
        url: `${api.baseUrl}/b`,
        headers: { "Content-Type": "application/octet-stream" },
        bodyFile: "data.bin",
      }),
    );
    expect(api.requests[1]?.headers["content-type"]).toBe("application/octet-stream");
  });

  it("パスはテンプレート展開され、サブディレクトリのファイルも送れる", async () => {
    await mkdir(join(cwd, "payloads"));
    await writeFile(join(cwd, "payloads", "p.json"), '{"k":1}');
    const api = await start();
    await run(flowOf({ url: `${api.baseUrl}/b`, bodyFile: "payloads/{{name}}.json" }), {
      variables: { name: "p" },
    });
    expect(api.requests[0]?.body.toString()).toBe('{"k":1}');
  });
});

describe("ファイル入力は cwd 配下に限る", () => {
  const variants: [string, (api: string) => Record<string, unknown>][] = [
    ["bodyFile", () => ({ bodyFile: "../outside.txt" })],
    ["multipart", () => ({ multipart: { f: { file: "../outside.txt" } } })],
  ];

  for (const [name, build] of variants) {
    it(`${name}: cwd の外(相対・絶対・シンボリックリンク経由)は拒否し、送信せず、履歴に拒否を記録する`, async () => {
      const outsideDir = await makeTmp();
      const outside = join(outsideDir, "secret.txt");
      await writeFile(outside, "TOP-SECRET-FILE");
      await writeFile(join(cwd, "..", "outside.txt"), "x");
      await symlink(outside, join(cwd, "link.txt"));
      await symlink(outsideDir, join(cwd, "linkdir"));
      const api = await start();

      const cases: Record<string, unknown>[] = [
        build(api.baseUrl),
        name === "bodyFile" ? { bodyFile: outside } : { multipart: { f: { file: outside } } },
        name === "bodyFile" ? { bodyFile: "link.txt" } : { multipart: { f: { file: "link.txt" } } },
        name === "bodyFile"
          ? { bodyFile: "linkdir/secret.txt" }
          : { multipart: { f: { file: "linkdir/secret.txt" } } },
      ];
      for (const request of cases) {
        const { step, entry } = await run(flowOf({ url: `${api.baseUrl}/x`, ...request }));
        expect(step?.status, JSON.stringify(request)).toBe("error");
        expect(step?.error).toContain("outside the current directory");
        expect(entry?.status).toBe("error");
      }
      expect(api.requests).toHaveLength(0);
      await rm(join(cwd, "..", "outside.txt"), { force: true });
    });
  }

  it("cwd 配下を指すシンボリックリンクは許可し、存在しないファイル・ディレクトリは error", async () => {
    await writeFile(join(cwd, "real.txt"), "REAL");
    await symlink(join(cwd, "real.txt"), join(cwd, "inside-link.txt"));
    await mkdir(join(cwd, "dir"));
    const api = await start();

    const okRun = await run(flowOf({ url: `${api.baseUrl}/x`, bodyFile: "inside-link.txt" }));
    expect(okRun.step?.status).toBe("passed");
    expect(api.requests[0]?.body.toString()).toBe("REAL");

    const missing = await run(flowOf({ url: `${api.baseUrl}/x`, bodyFile: "nope.txt" }));
    expect(missing.step?.status).toBe("error");
    expect(missing.step?.error).toContain("failed to read bodyFile file");
    const dir = await run(flowOf({ url: `${api.baseUrl}/x`, bodyFile: "dir" }));
    expect(dir.step?.error).toContain("not a regular file");
    expect(api.requests).toHaveLength(1);
  });
});

describe("dry-run", () => {
  it("form / multipart / bodyFile を、内容を含めずに展開し、cwd の外のファイルは展開エラーにする", async () => {
    await writeFile(join(cwd, "r.txt"), "DRY-RUN-CONTENT");
    const flow = flowSchema.parse({
      name: "f",
      steps: [
        {
          name: "form",
          request: { method: "POST", url: "http://127.0.0.1:9/f", form: { a: "1" } },
        },
        {
          name: "multi",
          request: {
            method: "POST",
            url: "http://127.0.0.1:9/m",
            multipart: { t: "x", f: { file: "r.txt" } },
          },
        },
        {
          name: "file",
          request: { method: "POST", url: "http://127.0.0.1:9/b", bodyFile: "r.txt" },
        },
        {
          name: "outside",
          request: { method: "POST", url: "http://127.0.0.1:9/o", bodyFile: "../outside.txt" },
        },
      ],
    });
    const dry = await dryRunFlow(flow, "f.yaml", { cwd });

    expect(dry.steps[0]?.request?.body).toBe("a=1");
    expect(dry.steps[0]?.request?.headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(dry.steps[1]?.request?.body).toEqual({
      t: "x",
      f: { file: "r.txt", filename: "r.txt", size: 15 },
    });
    expect(dry.steps[1]?.request?.headers["Content-Type"]).toBe("multipart/form-data");
    expect(dry.steps[2]?.request?.body).toEqual({ bodyFile: "r.txt", size: 15 });
    expect(JSON.stringify(dry)).not.toContain("DRY-RUN-CONTENT");
    expect(dry.steps[3]?.error).toContain("outside the current directory");
    expect(dry.steps[3]).not.toHaveProperty("request");
  });
});

describe("スキーマ", () => {
  const base = { method: "POST", url: "http://x.test/" };
  const parse = (extra: Record<string, unknown>) => requestSchema.safeParse({ ...base, ...extra });

  it("body / graphql / form / multipart / bodyFile は同時に指定できない", () => {
    const one = {
      body: { a: 1 },
      graphql: { query: "{ a }" },
      form: { a: "1" },
      multipart: { a: "1" },
      bodyFile: "f.bin",
    };
    expect(parse({ form: one.form }).success).toBe(true);
    expect(
      parse({ multipart: { a: "1", f: { file: "x", filename: "y", contentType: "z" } } }).success,
    ).toBe(true);
    const keys = Object.keys(one) as (keyof typeof one)[];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i] as keyof typeof one;
        const b = keys[j] as keyof typeof one;
        const result = parse({ [a]: one[a], [b]: one[b] });
        expect(result.success, `${a}+${b}`).toBe(false);
        expect(JSON.stringify(result.error?.issues)).toContain("mutually exclusive");
      }
    }
  });

  it("multipart のファイルパートは file が必須で、未知のキーは拒否する", () => {
    expect(parse({ multipart: { f: { filename: "x" } } }).success).toBe(false);
    expect(parse({ multipart: { f: { file: "x", extra: 1 } } }).success).toBe(false);
  });
});
