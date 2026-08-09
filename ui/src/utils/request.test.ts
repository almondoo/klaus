import { describe, expect, it } from "vitest";
import { parseRequestBody, rowsToRecord } from "./request";

describe("rowsToRecord", () => {
  it("converts rows with non-empty keys into a Record", () => {
    const result = rowsToRecord([
      { id: "1", key: "Content-Type", value: "application/json" },
      { id: "2", key: "X-Trace", value: "abc" },
    ]);
    expect(result).toEqual({ "Content-Type": "application/json", "X-Trace": "abc" });
  });

  it("drops rows whose key is empty or whitespace-only", () => {
    const result = rowsToRecord([
      { id: "1", key: "  ", value: "ignored" },
      { id: "2", key: "kept", value: "v" },
    ]);
    expect(result).toEqual({ kept: "v" });
  });

  it("returns undefined when there are no valid rows", () => {
    expect(rowsToRecord([])).toBeUndefined();
    expect(rowsToRecord([{ id: "1", key: "", value: "x" }])).toBeUndefined();
  });
});

describe("parseRequestBody", () => {
  it("returns undefined for empty or whitespace-only text", () => {
    expect(parseRequestBody("")).toBeUndefined();
    expect(parseRequestBody("   \n")).toBeUndefined();
  });

  it("parses valid JSON into an object", () => {
    expect(parseRequestBody('{"a":1}')).toEqual({ a: 1 });
  });

  it("parses valid JSON arrays and primitives", () => {
    expect(parseRequestBody("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseRequestBody("42")).toBe(42);
  });

  it("falls back to the raw string when JSON.parse fails", () => {
    expect(parseRequestBody("not json")).toBe("not json");
  });
});
