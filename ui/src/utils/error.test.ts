import { describe, expect, it } from "vitest";
import { queryErrorMessage } from "./error";

describe("queryErrorMessage", () => {
  it("returns the message of an Error", () => {
    expect(queryErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies a truthy non-Error value", () => {
    expect(queryErrorMessage("oops")).toBe("oops");
  });

  it("returns null for null or undefined", () => {
    expect(queryErrorMessage(null)).toBeNull();
    expect(queryErrorMessage(undefined)).toBeNull();
  });
});
