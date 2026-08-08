import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadEnvironment, resolveEnvironmentPath } from "../src/core/env.js";
import { ParseError } from "../src/core/errors.js";

describe("resolveEnvironmentPath", () => {
  it("cwd 基準で environments/<name>.yaml を解決する", () => {
    expect(resolveEnvironmentPath("/repo", "local")).toBe(
      join("/repo", "environments", "local.yaml"),
    );
  });

  it("environments/ の外を指す env 名は ParseError で拒否する(path traversal 防止)", () => {
    expect(() => resolveEnvironmentPath("/repo", "../../etc/secrets/prod")).toThrow(ParseError);
    expect(() => resolveEnvironmentPath("/repo", "../secret")).toThrow(ParseError);
  });
});

describe("loadEnvironment", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-env-"));
    await mkdir(join(dir, "environments"), { recursive: true });
    await writeFile(
      join(dir, "environments", "local.yaml"),
      "baseUrl: http://localhost:3000\n",
      "utf-8",
    );
    await writeFile(
      join(dir, "environments", "staging.yaml"),
      "baseUrl: https://staging.example.com\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("フロー定義の env を使って環境ファイルを読み込む", async () => {
    const env = await loadEnvironment(dir, "local");
    expect(env.baseUrl).toBe("http://localhost:3000");
  });

  it("envNameOverride がフロー定義の env より優先される", async () => {
    const env = await loadEnvironment(dir, "local", "staging");
    expect(env.baseUrl).toBe("https://staging.example.com");
  });

  it("env が未指定なら空オブジェクトを返す", async () => {
    const env = await loadEnvironment(dir, undefined);
    expect(env).toEqual({});
  });
});
