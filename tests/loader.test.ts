import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParseError } from "../src/core/errors.js";
import {
  loadEnvironmentFile,
  loadFlow,
  parseEnvironmentYaml,
  parseFlowYaml,
  validateFlowFile,
  validateFlowYaml,
} from "../src/core/loader.js";

// yaml の parse を差し替えられるようにモック化する(toParseError の
// 「YAMLParseError/ZodError 以外」フォールバック分岐は通常の YAML/スキーマ検証では
// 到達できないため、parse 自体が想定外のエラーを投げるケースを再現する)
vi.mock("yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yaml")>();
  return { ...actual, parse: vi.fn(actual.parse) };
});
const { parse: mockedParseYaml } = await import("yaml");

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

describe("parseFlowYaml / toParseError のフォールバック分岐", () => {
  it("YAMLParseError/ZodError 以外の Error は message をそのまま ParseError にする", () => {
    vi.mocked(mockedParseYaml).mockImplementationOnce(() => {
      throw new Error("unexpected failure from yaml parser");
    });
    try {
      parseFlowYaml("name: sample", "flow.yaml");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).message).toContain("unexpected failure from yaml parser");
    }
  });

  it("Error インスタンスでない値が投げられた場合は String() 化して ParseError にする", () => {
    vi.mocked(mockedParseYaml).mockImplementationOnce(() => {
      throw "raw string thrown by parser";
    });
    try {
      parseFlowYaml("name: sample", "flow.yaml");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).message).toContain("raw string thrown by parser");
    }
  });
});

describe("parseFlowYaml / 未知キー(strict 化)", () => {
  it("フロー直下の未知キーは ParseError になり、パスとキー名を含む", () => {
    const yaml = `
name: sample
unknownTopLevel: true
steps:
  - name: step1
    request:
      method: GET
      url: "https://example.com"
`;
    try {
      parseFlowYaml(yaml, "flow.yaml");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      const message = (error as ParseError).message;
      expect(message).toContain("schema validation failed");
      expect(message).toContain("unknownTopLevel");
    }
  });

  it("typo したキー(asssert)は step のパス付きで ParseError になる", () => {
    const yaml = `
name: sample
steps:
  - name: step1
    request:
      method: GET
      url: "https://example.com"
    asssert:
      status: 200
`;
    try {
      parseFlowYaml(yaml, "flow.yaml");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      const message = (error as ParseError).message;
      expect(message).toContain("steps.0");
      expect(message).toContain("asssert");
    }
  });
});

describe("validateFlowYaml / 未知キーのヒント", () => {
  it("未知キーの issue に typo の可能性を示すヒントが付く", () => {
    const yaml = `
name: sample
steps:
  - name: step1
    request:
      method: GET
      url: "https://example.com"
    asssert:
      status: 200
`;
    const result = validateFlowYaml(yaml);
    expect(result.valid).toBe(false);
    if (result.valid) return;

    const issue = result.errors.find((e) => e.message.includes("asssert"));
    expect(issue).toBeDefined();
    expect(issue?.hint).toMatch(/typo/);
    expect(issue?.hint).toContain("asssert");
  });
});

describe("validateFlowYaml / hintForIssue の各分岐", () => {
  it("request.body と request.graphql の排他違反にヒントが付く", () => {
    const yaml = `
name: sample
steps:
  - name: step1
    request:
      method: POST
      url: "https://example.com"
      body: { a: 1 }
      graphql:
        query: "{ ok }"
`;
    const result = validateFlowYaml(yaml);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const issue = result.errors.find((e) => e.path === "steps.0.request.graphql");
    expect(issue?.message).toContain("mutually exclusive");
    expect(issue?.hint).toBe("example: keep either body or graphql, not both");
  });

  it("step.request と step.ws の排他違反にヒントが付く", () => {
    const yaml = `
name: sample
steps:
  - name: step1
    request:
      method: GET
      url: "https://example.com"
    ws:
      url: "wss://example.com/socket"
`;
    const result = validateFlowYaml(yaml);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const issue = result.errors.find((e) => e.path === "steps.0.ws");
    expect(issue?.message).toContain("mutually exclusive");
    expect(issue?.hint).toBe("example: keep either request or ws, not both");
  });

  it("step.request / step.ws のどちらも指定されていない場合にヒントが付く", () => {
    const yaml = `
name: sample
steps:
  - name: step1
`;
    const result = validateFlowYaml(yaml);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const issue = result.errors.find((e) => e.path === "steps.0.request");
    expect(issue?.message).toContain("is required");
    expect(issue?.hint).toBe("example: add either request: or ws: to the step");
  });

  it("ws.url が ws:// / wss:// 以外のスキームだとヒントが付く", () => {
    const yaml = `
name: sample
steps:
  - name: step1
    ws:
      url: "http://example.com/socket"
`;
    const result = validateFlowYaml(yaml);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const issue = result.errors.find((e) => e.path === "steps.0.ws.url");
    expect(issue?.message).toContain("ws:// or wss://");
    expect(issue?.hint).toBe('example: url: "wss://example.com/socket"');
  });

  it("request.url が欠落している場合は https の例をヒントに出す", () => {
    const yaml = `
name: sample
steps:
  - name: step1
    request:
      method: GET
`;
    const result = validateFlowYaml(yaml);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const issue = result.errors.find((e) => e.path === "steps.0.request.url");
    expect(issue?.hint).toBe('example: url: "https://example.com"');
  });

  it("ws.url が欠落している場合は wss の例をヒントに出す", () => {
    const yaml = `
name: sample
steps:
  - name: step1
    ws: {}
`;
    const result = validateFlowYaml(yaml);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const issue = result.errors.find((e) => e.path === "steps.0.ws.url");
    expect(issue?.hint).toBe('example: url: "wss://example.com/socket"');
  });

  it("step 名の重複にヒントが付く", () => {
    const yaml = `
name: sample
steps:
  - name: step1
    request:
      method: GET
      url: "https://example.com"
  - name: step1
    request:
      method: GET
      url: "https://example.com"
`;
    const result = validateFlowYaml(yaml);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const issue = result.errors.find((e) => e.path === "steps.1.name");
    expect(issue?.message).toContain("duplicated");
    expect(issue?.hint).toBe("example: give this step a unique name, e.g. step2");
  });

  it("どのヒントにも該当しない issue には hint が付かない", () => {
    const yaml = `
name: ""
steps:
  - name: step1
    request:
      method: GET
      url: "https://example.com"
`;
    const result = validateFlowYaml(yaml);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    const issue = result.errors.find((e) => e.path === "name");
    expect(issue).toBeDefined();
    expect(issue?.hint).toBeUndefined();
  });
});

describe("validateFlowFile", () => {
  it("存在しないファイルは valid:false になり、読み取り失敗のメッセージを含む", async () => {
    const result = await validateFlowFile(join(process.cwd(), "tmp", "does-not-exist.yaml"));
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors[0]?.message).toContain("failed to read file");
  });
});

describe("parseEnvironmentYaml", () => {
  it("Record<string,string> を返す", () => {
    const env = parseEnvironmentYaml("baseUrl: http://localhost:3000\n");
    expect(env.baseUrl).toBe("http://localhost:3000");
  });

  it("不正な YAML は ParseError になる", () => {
    const invalidYaml = "baseUrl: [\n";
    try {
      parseEnvironmentYaml(invalidYaml, "env.yaml");
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).message).toContain("env.yaml");
      expect((error as ParseError).message).toMatch(/YAML syntax error/);
    }
  });
});

describe("loadEnvironmentFile", () => {
  it("存在しないファイルは ParseError になる", async () => {
    const tmpRoot = join(process.cwd(), "tmp");
    await mkdir(tmpRoot, { recursive: true });
    await expect(loadEnvironmentFile(join(tmpRoot, "missing-env.yaml"))).rejects.toThrow(
      ParseError,
    );
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
