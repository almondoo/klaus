import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ParseError } from "../src/core/errors.js";
import { loadFlow, parseEnvironmentYaml, parseFlowYaml } from "../src/core/loader.js";

describe("parseFlowYaml", () => {
  it("正しい YAML を Flow に変換する", () => {
    const yaml = `
name: sample
steps:
  - name: step1
    request:
      method: GET
      url: "https://example.com"
`;
    const flow = parseFlowYaml(yaml);
    expect(flow.name).toBe("sample");
    expect(flow.steps).toHaveLength(1);
  });

  it("YAML 構文エラーは ParseError になり、位置情報を含む", () => {
    const invalidYaml = "name: sample\nsteps: [\n";
    try {
      parseFlowYaml(invalidYaml, "broken.yaml");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).message).toContain("broken.yaml");
      // 実際に line/column が含まれることを検証する
      expect((error as ParseError).message).toMatch(/line \d+, column \d+/);
    }
  });

  it("スキーマ違反は ParseError になる", () => {
    const yaml = `
name: sample
steps: []
`;
    expect(() => parseFlowYaml(yaml, "invalid-schema.yaml")).toThrow(ParseError);
  });
});

describe("parseEnvironmentYaml", () => {
  it("Record<string,string> を返す", () => {
    const env = parseEnvironmentYaml("baseUrl: http://localhost:3000\n");
    expect(env.baseUrl).toBe("http://localhost:3000");
  });
});

describe("loadFlow", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-loader-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("ファイルを読み込んで検証する", async () => {
    const filePath = join(dir, "flow.yaml");
    await writeFile(
      filePath,
      `
name: file flow
steps:
  - name: step1
    request:
      method: GET
      url: "https://example.com"
`,
      "utf-8",
    );

    const flow = await loadFlow(filePath);
    expect(flow.name).toBe("file flow");
  });

  it("存在しないファイルは ParseError になる", async () => {
    await expect(loadFlow(join(dir, "missing.yaml"))).rejects.toThrow(ParseError);
  });
});
