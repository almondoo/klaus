import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toDisplayPath } from "../src/core/path-guard.js";

describe("toDisplayPath", () => {
  it("cwd 相対の / 区切りパスに変換する", () => {
    const cwd = join("/", "work", "project");
    expect(toDisplayPath(cwd, join(cwd, "flows", "sub", "a.yaml"))).toBe("flows/sub/a.yaml");
  });

  it("cwd の外のパスは .. を含む相対パスになる", () => {
    const cwd = join("/", "work", "project");
    expect(toDisplayPath(cwd, join("/", "work", "other", "b.yaml"))).toBe("../other/b.yaml");
  });
});
