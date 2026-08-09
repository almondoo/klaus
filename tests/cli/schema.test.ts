import { describe, expect, it } from "vitest";
import { buildFlowJsonSchema } from "../../src/cli/schema.js";

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
