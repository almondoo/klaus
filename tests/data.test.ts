import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDataFile } from "../src/core/data.js";
import { ParseError } from "../src/core/errors.js";

describe("loadDataFile", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-data-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("有効な JSON 配列を読み込む", async () => {
    const filePath = join(dir, "rows.json");
    await writeFile(filePath, JSON.stringify([{ name: "alice" }, { name: "bob" }]), "utf-8");

    const rows = await loadDataFile(filePath);

    expect(rows).toEqual([{ name: "alice" }, { name: "bob" }]);
  });

  it("有効な YAML 配列を読み込む", async () => {
    const filePath = join(dir, "rows.yaml");
    await writeFile(filePath, "- name: alice\n- name: bob\n", "utf-8");

    const rows = await loadDataFile(filePath);

    expect(rows).toEqual([{ name: "alice" }, { name: "bob" }]);
  });

  it(".yml 拡張子でも読み込む", async () => {
    const filePath = join(dir, "rows.yml");
    await writeFile(filePath, "- name: alice\n", "utf-8");

    const rows = await loadDataFile(filePath);

    expect(rows).toEqual([{ name: "alice" }]);
  });

  it("スカラー4種(string/number/boolean/null)の値をすべて保持する", async () => {
    const filePath = join(dir, "rows.json");
    await writeFile(
      filePath,
      JSON.stringify([{ str: "a", num: 1, bool: true, nil: null }]),
      "utf-8",
    );

    const rows = await loadDataFile(filePath);

    expect(rows).toEqual([{ str: "a", num: 1, bool: true, nil: null }]);
  });

  it("非対応の拡張子は ParseError で拒否する", async () => {
    const filePath = join(dir, "rows.csv");
    await writeFile(filePath, "name\nalice\n", "utf-8");

    await expect(loadDataFile(filePath)).rejects.toThrow(ParseError);
  });

  it("存在しないファイルはパスを含む ParseError になる", async () => {
    const filePath = join(dir, "missing.json");

    await expect(loadDataFile(filePath)).rejects.toThrow(ParseError);
    try {
      await loadDataFile(filePath);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).message).toContain(filePath);
    }
  });

  it("配列でないドキュメントはエラーになる", async () => {
    const filePath = join(dir, "rows.json");
    await writeFile(filePath, JSON.stringify({ name: "alice" }), "utf-8");

    await expect(loadDataFile(filePath)).rejects.toThrow(ParseError);
  });

  it("値がネストしたオブジェクトの行はエラーになる", async () => {
    const filePath = join(dir, "rows.json");
    await writeFile(filePath, JSON.stringify([{ nested: { a: 1 } }]), "utf-8");

    await expect(loadDataFile(filePath)).rejects.toThrow(ParseError);
  });

  it("空配列はエラーになる", async () => {
    const filePath = join(dir, "rows.json");
    await writeFile(filePath, "[]", "utf-8");

    await expect(loadDataFile(filePath)).rejects.toThrow(ParseError);
  });
});
