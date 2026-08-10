import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type GenerateCommandOptions,
  type GenerateJsonReport,
  generateCommand,
} from "../../src/cli/generate.js";
import { validateFlowYaml } from "../../src/core/index.js";

const projectRoot = join(__dirname, "..", "..");
const tmpRoot = join(projectRoot, "tmp");
const fixturesDir = join(__dirname, "fixtures");
const sampleSpecPath = join(fixturesDir, "sample-openapi.yaml");
const invalidSpecPath = join(fixturesDir, "invalid-openapi.yaml");
const sharedSchemaSpecPath = join(fixturesDir, "shared-schema-openapi.yaml");
const swagger2SpecPath = join(fixturesDir, "swagger2-openapi.yaml");
const openapi31SpecPath = join(fixturesDir, "openapi-3.1.yaml");

describe("generateCommand", () => {
  let workDir: string;
  let stdoutSpy: string[];
  let stderrSpy: string[];
  let stdoutWriteSpy: typeof process.stdout.write;
  let stderrWriteSpy: typeof process.stderr.write;
  let cwdSpy: typeof process.cwd;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    workDir = await mkdtemp(join(tmpRoot, "klaus-generate-"));
    stdoutSpy = [];
    stderrSpy = [];
    stdoutWriteSpy = process.stdout.write;
    stderrWriteSpy = process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutSpy.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      stderrSpy.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    cwdSpy = process.cwd;
    process.cwd = () => workDir;
  });

  afterEach(async () => {
    process.stdout.write = stdoutWriteSpy;
    process.stderr.write = stderrWriteSpy;
    process.cwd = cwdSpy;
    await rm(workDir, { recursive: true, force: true });
  });

  function readJsonReport(): GenerateJsonReport {
    return JSON.parse(stdoutSpy.join("")) as GenerateJsonReport;
  }

  async function run(options: GenerateCommandOptions = { json: true }): Promise<number> {
    return generateCommand(sampleSpecPath, options);
  }

  it("operationId あり/なし・requestBody あり・パスパラメータありの spec から期待どおりのファイル群を生成し、全て validateFlowYaml を通る", async () => {
    const exitCode = await run();

    expect(exitCode).toBe(0);
    const report = readJsonReport();
    expect(report.version).toBe(1);
    expect(report.errors).toEqual([]);
    // operationId あり(GET /users -> listUsers, POST /users -> createUser)、
    // operationId なし(GET /users/{id} -> method-slug 形式)の3ファイル
    expect(report.generated.sort()).toEqual(
      ["api/create-user.yaml", "api/get-users-id.yaml", "api/list-users.yaml"].sort(),
    );
    expect(report.skipped).toEqual([]);

    for (const relativePath of report.generated) {
      const content = await readFile(join(workDir, relativePath), "utf-8");
      const validation = validateFlowYaml(content);
      expect(validation.valid, `${relativePath} should pass validateFlowYaml`).toBe(true);
    }
  });

  it("operationId のある GET には query パラメータの example が request.query に入る", async () => {
    await run();

    const content = await readFile(join(workDir, "api", "list-users.yaml"), "utf-8");
    const validation = validateFlowYaml(content);
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;
    expect(validation.flow.steps[0]?.request?.query).toEqual({ limit: "10" });
    expect(validation.flow.steps[0]?.request?.method).toBe("GET");
    expect(validation.flow.steps[0]?.request?.url).toBe("{{baseUrl}}/users");
    expect(validation.flow.steps[0]?.assert?.status).toBe(200);
  });

  it("requestBody のある POST には example の body と spec の content-type に合わせた Content-Type ヘッダーが入る", async () => {
    await run();

    const content = await readFile(join(workDir, "api", "create-user.yaml"), "utf-8");
    const validation = validateFlowYaml(content);
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;
    const step = validation.flow.steps[0];
    expect(step?.request?.method).toBe("POST");
    expect(step?.request?.body).toEqual({ name: "Alice", email: "alice@example.com" });
    expect(step?.request?.headers).toEqual({ "Content-Type": "application/json" });
    // 定義済みレスポンスのうち最小の 2xx (201) が採用される
    expect(step?.assert?.status).toBe(201);
  });

  it("operationId のないオペレーションは <method>-<slug> 形式のファイル名になり、パスパラメータは URL にそのまま残る", async () => {
    await run();

    const content = await readFile(join(workDir, "api", "get-users-id.yaml"), "utf-8");
    const validation = validateFlowYaml(content);
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;
    expect(validation.flow.steps[0]?.request?.url).toBe("{{baseUrl}}/users/{id}");
    // path パラメータは query に含めない
    expect(validation.flow.steps[0]?.request?.query).toBeUndefined();
    // 定義済みレスポンス(200, 404)のうち最小の 2xx(200)が採用される
    expect(validation.flow.steps[0]?.assert?.status).toBe(200);
  });

  it("生成される YAML の先頭行は $schema コメントである", async () => {
    await run();

    const content = await readFile(join(workDir, "api", "list-users.yaml"), "utf-8");
    expect(content.split("\n")[0]).toBe(
      "# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json",
    );
  });

  it("--out-dir で出力先ディレクトリを変更できる", async () => {
    const exitCode = await run({ json: true, outDir: "generated-flows" });

    expect(exitCode).toBe(0);
    const report = readJsonReport();
    expect(report.generated).toContain("generated-flows/list-users.yaml");
    await readFile(join(workDir, "generated-flows", "list-users.yaml"), "utf-8");
  });

  it("既存ファイルは上書きせず、skip として報告する", async () => {
    await mkdir(join(workDir, "api"), { recursive: true });
    await writeFile(join(workDir, "api", "list-users.yaml"), "name: keep me\nsteps: []\n", "utf-8");

    const exitCode = await run();

    expect(exitCode).toBe(0);
    const report = readJsonReport();
    expect(report.skipped).toContain("api/list-users.yaml");
    expect(report.generated).not.toContain("api/list-users.yaml");
    const preserved = await readFile(join(workDir, "api", "list-users.yaml"), "utf-8");
    expect(preserved).toBe("name: keep me\nsteps: []\n");
  });

  it("同一 components schema を複数の required 兄弟プロパティが $ref する場合、両方に required フィールドのプレースホルダが生成される(循環参照の誤検出防止)", async () => {
    const exitCode = await generateCommand(sharedSchemaSpecPath, { json: true });

    expect(exitCode).toBe(0);
    const report = readJsonReport();
    expect(report.errors).toEqual([]);
    expect(report.generated).toContain("api/create-order.yaml");

    const content = await readFile(join(workDir, "api", "create-order.yaml"), "utf-8");
    const validation = validateFlowYaml(content);
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;
    const body = validation.flow.steps[0]?.request?.body;
    // 2回目の参照(shippingAddress)が {} に潰れず、billingAddress と同様に city/zip を持つこと
    expect(body).toEqual({
      billingAddress: { city: "", zip: "" },
      shippingAddress: { city: "", zip: "" },
    });
  });

  it("OpenAPI 3.1(openapi: '3.1.0')の spec も 3.x として受理され、exit 0 で生成に成功する", async () => {
    const exitCode = await generateCommand(openapi31SpecPath, { json: true });

    expect(exitCode).toBe(0);
    const report = readJsonReport();
    expect(report.errors).toEqual([]);
    expect(report.generated).toContain("api/ping.yaml");

    const content = await readFile(join(workDir, "api", "ping.yaml"), "utf-8");
    const validation = validateFlowYaml(content);
    expect(validation.valid).toBe(true);
  });

  it("Swagger 2.0 spec(swagger: '2.0')は生成せず exit 2 になり、変換を促すメッセージが返る", async () => {
    const exitCode = await generateCommand(swagger2SpecPath, { json: true });

    expect(exitCode).toBe(2);
    const report = readJsonReport();
    expect(report.version).toBe(1);
    expect(report.generated).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]?.message).toMatch(/OpenAPI 3\.x/);
    expect(report.errors[0]?.message).toMatch(/Swagger 2\.0/);
  });

  it("不正な spec(paths が無い)は exit 2 になり、JSON モードではエラーレポートが stdout に出る", async () => {
    const exitCode = await generateCommand(invalidSpecPath, { json: true });

    expect(exitCode).toBe(2);
    const report = readJsonReport();
    expect(report.version).toBe(1);
    expect(report.generated).toEqual([]);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0]?.message).toMatch(/not a valid Openapi API definition/);
  });

  it("不正な spec は非 JSON(TTY)モードでは stderr にのみメッセージを出し、stdout には何も出さない", async () => {
    const isTtySpy = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      const exitCode = await generateCommand(invalidSpecPath, { json: false });

      expect(exitCode).toBe(2);
      expect(stdoutSpy.join("")).toBe("");
      expect(stderrSpy.join("")).toContain("invalid OpenAPI definition");
    } finally {
      process.stdout.isTTY = isTtySpy;
    }
  });

  it("非 JSON(TTY)モードでは generated/skipped がテキスト行として出力される", async () => {
    const isTtySpy = process.stdout.isTTY;
    process.stdout.isTTY = true;
    try {
      const exitCode = await run({ json: false });

      expect(exitCode).toBe(0);
      const output = stdoutSpy.join("");
      expect(output).toContain("generated: api/list-users.yaml");
      expect(output).toContain("generated: api/create-user.yaml");
      expect(output).toContain("generated: api/get-users-id.yaml");
    } finally {
      process.stdout.isTTY = isTtySpy;
    }
  });
});
