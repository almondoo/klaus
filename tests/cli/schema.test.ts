import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
});
