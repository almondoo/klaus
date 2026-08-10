import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildConfigJsonSchema,
  buildFlowJsonSchema,
  buildRunReportJsonSchema,
  schemaCommand,
} from "../../src/cli/schema.js";

describe("buildFlowJsonSchema", () => {
  it("JSON として parse できる JSON Schema を返す", () => {
    const json = buildFlowJsonSchema();
    const parsed = JSON.parse(JSON.stringify(json));
    expect(parsed.type).toBe("object");
  });

  it("steps など主要プロパティを含む", () => {
    const json = buildFlowJsonSchema() as {
      properties: { name: unknown; steps: { items: { properties: Record<string, unknown> } } };
    };
    expect(json.properties.name).toBeDefined();
    expect(json.properties.steps.items.properties.request).toBeDefined();
    expect(json.properties.steps.items.properties.ws).toBeDefined();
    // steps.items.use: フローファイル参照(materialize)によるステップ再利用
    expect(json.properties.steps.items.properties.use).toBeDefined();
  });

  it("assert.bodySchema プロパティを含む(レスポンスボディの JSON Schema 検証)", () => {
    const json = buildFlowJsonSchema() as {
      properties: {
        steps: {
          items: { properties: { assert: { properties: Record<string, unknown> } } };
        };
      };
    };
    expect(json.properties.steps.items.properties.assert.properties.bodySchema).toBeDefined();
  });

  it("superRefine 由来の排他制約が description の注記として含まれる", () => {
    const json = buildFlowJsonSchema() as {
      properties: {
        steps: {
          description?: string;
          items: {
            description?: string;
            properties: {
              request: { description?: string };
              ws: { properties: { url: { description?: string } } };
            };
          };
        };
      };
    };

    // step 名の一意性(flowSchema の superRefine)
    expect(json.properties.steps.description).toMatch(/unique/);
    // request/ws のどちらか一方(stepSchema の superRefine)
    expect(json.properties.steps.items.description).toMatch(/Exactly one/);
    // body/graphql の排他・method 必須(requestSchema の superRefine)
    expect(json.properties.steps.items.properties.request.description).toMatch(
      /mutually exclusive/,
    );
    // ws.url のスキーム制約(wsSchema の superRefine)
    expect(json.properties.steps.items.properties.ws.properties.url.description).toMatch(
      /ws:\/\/ or wss:\/\//,
    );
  });
});

describe("buildRunReportJsonSchema", () => {
  it("JSON として parse できる JSON Schema を返す", () => {
    const json = buildRunReportJsonSchema();
    const parsed = JSON.parse(JSON.stringify(json));
    expect(parsed.type).toBe("object");
  });

  it("version/status/summary/flows など run --json(v2)の主要プロパティを含む", () => {
    const json = buildRunReportJsonSchema() as {
      properties: {
        version: unknown;
        status: unknown;
        runId: unknown;
        summary: { properties: Record<string, unknown> };
        flows: {
          items: { properties: { steps: { items: { properties: Record<string, unknown> } } } };
        };
      };
    };
    expect(json.properties.version).toBeDefined();
    expect(json.properties.status).toBeDefined();
    expect(json.properties.runId).toBeDefined();
    expect(json.properties.summary.properties.passed).toBeDefined();
    expect(json.properties.flows.items.properties.steps.items.properties.assertions).toBeDefined();
  });
});

describe("buildConfigJsonSchema", () => {
  it("JSON として parse できる JSON Schema を返す", () => {
    const json = buildConfigJsonSchema();
    const parsed = JSON.parse(JSON.stringify(json));
    expect(parsed.type).toBe("object");
  });

  it("run/ui など主要プロパティを含む", () => {
    const json = buildConfigJsonSchema() as {
      properties: {
        run: { properties: Record<string, unknown> };
        ui: { properties: Record<string, unknown> };
      };
    };
    expect(json.properties.run.properties.env).toBeDefined();
    expect(json.properties.run.properties.report).toBeDefined();
    expect(json.properties.run.properties.reportFile).toBeDefined();
    expect(json.properties.run.properties.history).toBeDefined();
    expect(json.properties.run.properties.mask).toBeDefined();
    expect(json.properties.ui.properties.port).toBeDefined();
    expect(json.properties.ui.properties.host).toBeDefined();
    expect(json.properties.ui.properties.open).toBeDefined();
  });
});

describe("schemaCommand / target", () => {
  let stdoutSpy: string[];
  let writeSpy: typeof process.stdout.write;

  beforeEach(() => {
    stdoutSpy = [];
    writeSpy = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdoutSpy.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = writeSpy;
  });

  it("target 省略時は flow スキーマを出力する", async () => {
    const exitCode = await schemaCommand();
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutSpy.join(""));
    expect(parsed.properties.steps).toBeDefined();
  });

  it('target: "run-report" 指定時は run --json スキーマを出力する', async () => {
    const exitCode = await schemaCommand("run-report");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutSpy.join(""));
    expect(parsed.properties.summary).toBeDefined();
  });

  it('target: "config" 指定時は klaus.config.yaml のスキーマを出力する', async () => {
    const exitCode = await schemaCommand("config");
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutSpy.join(""));
    expect(parsed.properties.run).toBeDefined();
    expect(parsed.properties.ui).toBeDefined();
  });
});
