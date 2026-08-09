import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ValidateJsonReport, validateCommand } from "../../src/cli/validate.js";

const projectRoot = join(__dirname, "..", "..");
const tmpRoot = join(projectRoot, "tmp");

const VALID_FLOW_YAML = `
name: sample flow
steps:
  - name: step1
    request:
      method: GET
      url: "https://example.com"
`;

describe("validateCommand", () => {
  let workDir: string;
  let stdoutSpy: string[];
  let writeSpy: typeof process.stdout.write;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    workDir = await mkdtemp(join(tmpRoot, "klaus-validate-"));
    stdoutSpy = [];
    writeSpy = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdoutSpy.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = writeSpy;
    await rm(workDir, { recursive: true, force: true });
  });

  function readJsonReport(): ValidateJsonReport {
    return JSON.parse(stdoutSpy.join("")) as ValidateJsonReport;
  }

  it("正しいフロー定義は exit 0 になり、JSON に valid: true が含まれる", async () => {
    const filePath = join(workDir, "good.yaml");
    await writeFile(filePath, VALID_FLOW_YAML, "utf-8");

    const exitCode = await validateCommand([filePath], { json: true });

    expect(exitCode).toBe(0);
    const report = readJsonReport();
    expect(report.version).toBe(1);
    expect(report.files).toEqual([{ path: filePath, valid: true, errors: [] }]);
  });

  it("YAML 構文エラーは exit 2 になり、位置情報付きのエラーが1件返る", async () => {
    const filePath = join(workDir, "broken.yaml");
    await writeFile(filePath, "name: sample\nsteps: [\n", "utf-8");

    const exitCode = await validateCommand([filePath], { json: true });

    expect(exitCode).toBe(2);
    const report = readJsonReport();
    expect(report.files).toHaveLength(1);
    const [file] = report.files;
    expect(file?.valid).toBe(false);
    expect(file?.errors).toHaveLength(1);
    expect(file?.errors[0]?.message).toMatch(/YAML syntax error/);
  });

  it("スキーマ違反は修正例ヒント付きのエラーとして JSON に含まれる", async () => {
    const filePath = join(workDir, "invalid-schema.yaml");
    await writeFile(
      filePath,
      `
name: sample flow
steps:
  - name: step1
    request:
      url: "https://example.com"
`,
      "utf-8",
    );

    const exitCode = await validateCommand([filePath], { json: true });

    expect(exitCode).toBe(2);
    const report = readJsonReport();
    const [file] = report.files;
    expect(file?.valid).toBe(false);
    expect(file?.errors).toContainEqual(
      expect.objectContaining({
        path: "steps.0.request.method",
        hint: "example: method: GET",
      }),
    );
  });

  it("複数ファイルを渡すと valid/invalid が混在した結果を返し、1件でも不正なら exit 2", async () => {
    const goodPath = join(workDir, "good.yaml");
    const badPath = join(workDir, "bad.yaml");
    await writeFile(goodPath, VALID_FLOW_YAML, "utf-8");
    await writeFile(badPath, "name: sample\nsteps: []\n", "utf-8");

    const exitCode = await validateCommand([goodPath, badPath], { json: true });

    expect(exitCode).toBe(2);
    const report = readJsonReport();
    expect(report.files).toHaveLength(2);
    expect(report.files[0]).toEqual({ path: goodPath, valid: true, errors: [] });
    expect(report.files[1]?.valid).toBe(false);
    expect(report.files[1]?.errors[0]?.path).toBe("steps");
  });

  it("引数なしの場合はカレントディレクトリ以下のフロー候補 YAML を探索する", async () => {
    await mkdir(join(workDir, "flows"), { recursive: true });
    await mkdir(join(workDir, "environments"), { recursive: true });
    await writeFile(join(workDir, "flows", "example.yaml"), VALID_FLOW_YAML, "utf-8");
    // steps キーを持たない YAML は探索対象外(候補判定は server の listFlows と同じ仕様)
    await writeFile(
      join(workDir, "environments", "local.yaml"),
      "baseUrl: https://example.com\n",
      "utf-8",
    );

    const cwdSpy = process.cwd;
    process.cwd = () => workDir;
    try {
      const exitCode = await validateCommand([], { json: true });

      expect(exitCode).toBe(0);
      const report = readJsonReport();
      expect(report.files).toEqual([{ path: "flows/example.yaml", valid: true, errors: [] }]);
    } finally {
      process.cwd = cwdSpy;
    }
  });
});
