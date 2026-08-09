import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectYamlFiles, discoverFlowCandidates } from "../src/core/discovery.js";

const projectRoot = join(__dirname, "..");
const tmpRoot = join(projectRoot, "tmp");

describe("collectYamlFiles", () => {
  it("存在しないディレクトリを渡すと例外を投げずに空配列を返す", async () => {
    const result = await collectYamlFiles(join(tmpRoot, "klaus-discovery-nonexistent-dir"));
    expect(result).toEqual([]);
  });
});

describe("discoverFlowCandidates", () => {
  let workDir: string;
  let unreadablePath: string | undefined;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    workDir = await mkdtemp(join(tmpRoot, "klaus-discovery-"));
    unreadablePath = undefined;
  });

  afterEach(async () => {
    // rm --force での削除を確実にするため、権限を落としたファイルは戻してから削除する
    if (unreadablePath) await chmod(unreadablePath, 0o644);
    await rm(workDir, { recursive: true, force: true });
  });

  it("steps キーを持つ YAML のみを候補として返す", async () => {
    await writeFile(join(workDir, "flow.yaml"), "name: f\nsteps:\n  - name: s\n", "utf-8");
    await writeFile(join(workDir, "not-flow.yaml"), "baseUrl: https://example.com\n", "utf-8");

    const result = await discoverFlowCandidates(workDir);
    expect(result).toEqual([join(workDir, "flow.yaml")]);
  });

  it("YAML 構文が壊れているファイルは例外を投げず候補から除外する", async () => {
    await writeFile(join(workDir, "broken.yaml"), "steps: [\n", "utf-8");

    const result = await discoverFlowCandidates(workDir);
    expect(result).toEqual([]);
  });

  it("読み取り権限が無いファイルは例外を投げず候補から除外する", async () => {
    unreadablePath = join(workDir, "unreadable.yaml");
    await writeFile(unreadablePath, "name: f\nsteps:\n  - name: s\n", "utf-8");
    await chmod(unreadablePath, 0o000);

    const result = await discoverFlowCandidates(workDir);
    expect(result).toEqual([]);
  });
});
