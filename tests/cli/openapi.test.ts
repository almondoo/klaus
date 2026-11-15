import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyConfigToRunOptions, loadCliConfig } from "../../src/cli/config.js";
import { dryRunReportSchema } from "../../src/cli/reporters/dry-run.js";
import { jsonReportSchema } from "../../src/cli/reporters/json.js";
import { type RunCommandOptions, runCommand } from "../../src/cli/run.js";
import { closeServer, listenEphemeral } from "../support/net.js";

const tmpRoot = join(__dirname, "..", "..", "tmp");

const SPEC = {
  openapi: "3.0.3",
  info: { title: "Users", version: "1.0.0" },
  paths: {
    "/users/{id}": {
      get: {
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["id", "name"],
                  properties: { id: { type: "integer" }, name: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    "/health": { get: { responses: { "200": { description: "ok" } } } },
    "/orders": { get: { responses: { "200": { description: "ok" } } } },
  },
};

describe("klaus run --openapi", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let userBody: unknown;
  let workDir: string;
  let out: string[];
  let err: string[];
  let stdoutWrite: typeof process.stdout.write;
  let stderrWrite: typeof process.stderr.write;
  let isTty: boolean | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url?.startsWith("/users/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(userBody));
        return;
      }
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end("{}");
    });
    ({ baseUrl } = await listenEphemeral(server));
    await mkdir(tmpRoot, { recursive: true });
  });
  afterAll(async () => {
    await closeServer(server);
  });
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpRoot, "klaus-openapi-cli-"));
    out = [];
    err = [];
    stdoutWrite = process.stdout.write;
    stderrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      out.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      err.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    isTty = process.stdout.isTTY;
    process.stdout.isTTY = undefined as unknown as true;
    userBody = { id: 1, name: "alice" };
  });
  afterEach(async () => {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.stdout.isTTY = isTty as true;
    await rm(workDir, { recursive: true, force: true });
  });

  const options = (overrides: Partial<RunCommandOptions> = {}): RunCommandOptions => ({
    history: false,
    mask: true,
    reportFile: [],
    ci: false,
    ...overrides,
  });
  const json = () => JSON.parse(out.join(""));

  async function writeSpec(spec: unknown = SPEC, name = "openapi.json") {
    const path = join(workDir, name);
    await writeFile(path, typeof spec === "string" ? spec : JSON.stringify(spec));
    return path;
  }

  async function writeFlow(name: string, steps: { name: string; path: string }[], tags?: string[]) {
    const path = join(workDir, name);
    const yaml = [
      `name: ${name}`,
      ...(tags ? [`tags: [${tags.join(", ")}]`] : []),
      "steps:",
      ...steps.flatMap((step) => [
        `  - name: ${step.name}`,
        "    continueOnError: true",
        "    request:",
        "      method: GET",
        `      url: "${baseUrl}${step.path}"`,
      ]),
      "",
    ].join("\n");
    await writeFile(path, yaml);
    return path;
  }

  it("仕様どおりの応答は通り、カバレッジを JSON に載せる(未カバー・照合できないリクエストを含む)", async () => {
    const spec = await writeSpec();
    const flow = await writeFlow("ok.yaml", [
      { name: "user", path: "/users/1" },
      { name: "health", path: "/health" },
      { name: "extra", path: "/not-in-spec" },
    ]);

    const code = await runCommand([flow], options({ openapi: [spec] }));

    expect(code).toBe(0);
    const report = json();
    expect(report.status).toBe("passed");
    expect(report.openapi).toMatchObject({
      documents: [{ title: "Users", version: "1.0.0", operations: 3 }],
      operations: { total: 3, covered: 2, percent: 66.7 },
      uncovered: [{ operation: "GET /orders" }],
      unmatched: [{ method: "GET", url: `${baseUrl}/not-in-spec`, count: 1 }],
      excluded: [],
      violations: 0,
      partial: false,
      planned: false,
    });
    expect(report.openapi.covered).toEqual([
      expect.objectContaining({ operation: "GET /users/{id}", statuses: [200] }),
      expect.objectContaining({ operation: "GET /health", statuses: [200] }),
    ]);
    expect(report.openapi.coverageMin).toBeUndefined();
  });

  it("仕様に違反した応答はステップを failed にして exit 4。違反はアサーションに載る", async () => {
    userBody = { id: "one" };
    const spec = await writeSpec();
    const flow = await writeFlow("bad.yaml", [{ name: "user", path: "/users/1" }]);

    const code = await runCommand([flow], options({ openapi: [spec] }));

    expect(code).toBe(4);
    const report = json();
    expect(report.status).toBe("failed");
    const assertion = report.flows[0].steps[0].assertions.find(
      (a: { kind: string }) => a.kind === "openapi",
    );
    expect(assertion).toMatchObject({
      ok: false,
      openapi: {
        state: "invalid",
        operation: "GET /users/{id}",
        status: 200,
        violationCount: 2,
      },
    });
    expect(assertion.openapi.violations).toEqual(
      expect.arrayContaining([{ location: "body", path: "/id", message: "must be integer" }]),
    );
    expect(report.openapi.violations).toBe(1);
    // 出力は公開している JSON スキーマ(strictObject)に収まる
    expect(() => jsonReportSchema.parse(report)).not.toThrow();
  });

  it("text 出力に違反とカバレッジの要約が出る", async () => {
    userBody = { id: "one" };
    const spec = await writeSpec();
    const flow = await writeFlow("text.yaml", [
      { name: "user", path: "/users/1" },
      { name: "other", path: "/not-in-spec" },
    ]);

    expect(await runCommand([flow], options({ openapi: [spec], text: true }))).toBe(4);

    const text = out.join("");
    expect(text).toContain("OpenAPI: GET /users/{id} -> 200 violates the specification");
    expect(text).toContain("openapi: 1/3 operations covered (33.3%), 1 violation(s)");
    expect(text).toContain("openapi: uncovered: GET /health, GET /orders");
    expect(text).toContain(`openapi: unmatched requests: GET ${baseUrl}/not-in-spec`);
  });

  it("--openapi-strict: 照合できないリクエストは失敗になる", async () => {
    const spec = await writeSpec();
    const flow = await writeFlow("strict.yaml", [{ name: "extra", path: "/not-in-spec" }]);

    expect(await runCommand([flow], options({ openapi: [spec] }))).toBe(0);
    out.length = 0;
    expect(await runCommand([flow], options({ openapi: [spec], openapiStrict: true }))).toBe(4);
    const assertion = json().flows[0].steps[0].assertions[0];
    expect(assertion).toMatchObject({
      ok: false,
      kind: "openapi",
      openapi: { state: "unmatched" },
    });
  });

  it("--openapi-coverage-min: 下回れば実行全体が failed(exit 4)、満たせば 0", async () => {
    const spec = await writeSpec();
    const flow = await writeFlow("cov.yaml", [{ name: "health", path: "/health" }]);

    expect(await runCommand([flow], options({ openapi: [spec], openapiCoverageMin: 50 }))).toBe(4);
    const report = json();
    expect(report.status).toBe("failed");
    expect(report.summary.failed).toBe(0);
    expect(report.openapi.coverageMin).toEqual({ percent: 50, met: false });
    expect(err.join("")).toContain("OpenAPI coverage 33.3% is below --openapi-coverage-min 50%");

    out.length = 0;
    expect(await runCommand([flow], options({ openapi: [spec], openapiCoverageMin: 33 }))).toBe(0);
    expect(json().openapi.coverageMin).toEqual({ percent: 33, met: true });
  });

  it("--tags で一部のフローだけを実行すると partial と明記する", async () => {
    const spec = await writeSpec();
    const a = await writeFlow("a.yaml", [{ name: "health", path: "/health" }], ["smoke"]);
    const b = await writeFlow("b.yaml", [{ name: "user", path: "/users/1" }], ["full"]);

    expect(await runCommand([a, b], options({ openapi: [spec], tags: ["smoke"] }))).toBe(0);
    expect(json().openapi).toMatchObject({ partial: true, operations: { covered: 1 } });
    out.length = 0;
    expect(await runCommand([a, b], options({ openapi: [spec] }))).toBe(0);
    expect(json().openapi.partial).toBe(false);
  });

  it("--dry-run: 送らず、計画のカバレッジだけを報告する", async () => {
    const spec = await writeSpec();
    const flow = await writeFlow("dry.yaml", [
      { name: "user", path: "/users/1" },
      { name: "extra", path: "/not-in-spec" },
    ]);

    expect(await runCommand([flow], options({ openapi: [spec], dryRun: true }))).toBe(0);

    const report = json();
    expect(report.dryRun).toBe(true);
    expect(report.openapi).toMatchObject({
      planned: true,
      operations: { total: 3, covered: 1 },
      covered: [{ operation: "GET /users/{id}", statuses: [] }],
      unmatched: [{ method: "GET", url: `${baseUrl}/not-in-spec` }],
    });
    expect(report.flows[0].steps[0].assertions).toBeUndefined();
    expect(() => dryRunReportSchema.parse(report)).not.toThrow();
  });

  it("引数の誤りは exit 1: --openapi なしの関連オプション・--dry-run との併用・不正な base URL", async () => {
    const spec = await writeSpec();
    const flow = await writeFlow("args.yaml", [{ name: "health", path: "/health" }]);
    const cases: [Partial<RunCommandOptions>, RegExp][] = [
      [{ openapiStrict: true }, /--openapi-strict requires --openapi/],
      [{ openapiCoverageMin: 10 }, /--openapi-coverage-min requires --openapi/],
      [{ openapiBaseUrl: "http://localhost" }, /--openapi-base-url requires --openapi/],
      [
        { openapi: [spec], openapiStrict: true, dryRun: true },
        /--dry-run cannot be combined with --openapi-strict/,
      ],
      [
        { openapi: [spec], openapiCoverageMin: 1, dryRun: true },
        /--dry-run cannot be combined with --openapi-coverage-min/,
      ],
      [{ openapi: [spec], openapiBaseUrl: "ftp://x" }, /must be an absolute http\(s\) URL/],
    ];
    for (const [overrides, pattern] of cases) {
      err.length = 0;
      expect(await runCommand([flow], options(overrides))).toBe(1);
      expect(err.join("")).toMatch(pattern);
    }
    expect(out.join("")).toBe("");
  });

  it("読めない・壊れた仕様は exit 2 で、何も実行しない", async () => {
    const flow = await writeFlow("parse.yaml", [{ name: "health", path: "/health" }]);
    const broken = await writeSpec("openapi: 3.0.0\npaths: [\n", "broken.yaml");
    const swagger = await writeSpec({ swagger: "2.0", paths: {} }, "swagger.json");
    for (const spec of [broken, swagger, join(workDir, "missing.json")]) {
      err.length = 0;
      expect(await runCommand([flow], options({ openapi: [spec] }))).toBe(2);
      expect(err.join("")).toContain("klaus: parse error:");
    }
    expect(out.join("")).toBe("");
  });

  it("--report html / github にも OpenAPI のカバレッジと違反を載せる", async () => {
    userBody = { id: "one" };
    const spec = await writeSpec();
    const flow = await writeFlow("report.yaml", [{ name: "user", path: "/users/1" }]);
    const html = join(workDir, "report.html");
    const md = join(workDir, "report.md");

    expect(
      await runCommand(
        [flow],
        options({ openapi: [spec], report: "html,github", reportFile: [html, md] }),
      ),
    ).toBe(4);

    const htmlText = await readFile(html, "utf-8");
    expect(htmlText).toContain("<h2>OpenAPI</h2>");
    expect(htmlText).toContain("OpenAPI violations");
    expect(htmlText).toContain("Uncovered operations (2)");
    const mdText = await readFile(md, "utf-8");
    expect(mdText).toContain("openapi: 1/3 operations covered (33.3%), 1 violation(s)");
    expect(mdText).toContain("openapi: uncovered: GET /health, GET /orders");
  });

  describe("klaus.config.yaml の run.openapi", () => {
    it("設定ファイルのあるディレクトリ基準の絶対パスになり、--openapi を指定すると置き換わる", async () => {
      await writeFile(
        join(workDir, "klaus.config.yaml"),
        "run:\n  openapi:\n    - specs/a.yaml\n    - ../b.yaml\n",
      );
      const config = await loadCliConfig(workDir);
      expect(config?.run?.openapi).toEqual([
        join(workDir, "specs", "a.yaml"),
        join(workDir, "..", "b.yaml"),
      ]);

      const base = options({ openapi: [] });
      expect(applyConfigToRunOptions(base, { openapi: "default" }, config).openapi).toEqual(
        config?.run?.openapi,
      );
      expect(
        applyConfigToRunOptions({ ...base, openapi: ["cli.yaml"] }, { openapi: "cli" }, config)
          .openapi,
      ).toEqual(["cli.yaml"]);
    });

    it("文字列でも書け、空の配列と未知の型は設定エラーになる", async () => {
      await writeFile(join(workDir, "klaus.config.yaml"), "run:\n  openapi: api.yaml\n");
      expect((await loadCliConfig(workDir))?.run?.openapi).toEqual([join(workDir, "api.yaml")]);
      await writeFile(join(workDir, "klaus.config.yaml"), "run:\n  openapi: []\n");
      await expect(loadCliConfig(workDir)).rejects.toThrow();
      await writeFile(join(workDir, "klaus.config.yaml"), "run:\n  openapi: 3\n");
      await expect(loadCliConfig(workDir)).rejects.toThrow();
    });
  });
});
