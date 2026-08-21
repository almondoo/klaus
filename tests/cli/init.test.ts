import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initCommand } from "../../src/cli/init.js";
import { loadFlow } from "../../src/core/index.js";

const projectRoot = join(__dirname, "..", "..");
const tmpRoot = join(projectRoot, "tmp");

describe("initCommand", () => {
  let workDir: string;
  let stdoutSpy: string[];
  let writeSpy: typeof process.stdout.write;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    workDir = await mkdtemp(join(tmpRoot, "klaus-init-"));
    stdoutSpy = [];
    writeSpy = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdoutSpy.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = writeSpy;
    await rm(workDir, { recursive: true, force: true });
  });

  it("空のディレクトリに api/example.yaml と environments/local.yaml と AGENTS.md と .klaus/.gitignore を生成する", async () => {
    const exitCode = await initCommand(workDir);

    expect(exitCode).toBe(0);
    const flowContent = await readFile(join(workDir, "api", "example.yaml"), "utf-8");
    const envContent = await readFile(join(workDir, "environments", "local.yaml"), "utf-8");
    const agentsContent = await readFile(join(workDir, "AGENTS.md"), "utf-8");
    const gitignoreContent = await readFile(join(workDir, ".klaus", ".gitignore"), "utf-8");
    expect(flowContent).toContain("name: example flow");
    expect(flowContent).toContain(
      "# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json",
    );
    expect(envContent).toContain("baseUrl:");
    expect(agentsContent).toContain("# AGENTS guide for klaus");
    expect(gitignoreContent).toBe("*\n");
    expect(stdoutSpy.join("")).toContain("created: api/example.yaml");
    expect(stdoutSpy.join("")).toContain("created: environments/local.yaml");
    expect(stdoutSpy.join("")).toContain("created: AGENTS.md");
    expect(stdoutSpy.join("")).toContain(`created: ${join(".klaus", ".gitignore")}`);
  });

  it("生成される AGENTS.md にはコマンド体系・YAML スキーマ要点・exit code 表・ディレクトリ規約が含まれる", async () => {
    await initCommand(workDir);

    const agentsContent = await readFile(join(workDir, "AGENTS.md"), "utf-8");
    expect(agentsContent).toContain("klaus run <files...>");
    expect(agentsContent).toContain("klaus init");
    expect(agentsContent).toContain("klaus ui");
    expect(agentsContent).toContain("{{env.X}}");
    expect(agentsContent).toContain("| 0 | all passed |");
    expect(agentsContent).toContain("| 4 | assertion failure |");
    expect(agentsContent).toContain(".klaus/history/<YYYY-MM-DD>.jsonl");
    // api/ = 単発チェック、flows/ = シナリオの使い分けが記載されていること
    expect(agentsContent).toContain("## Directory convention");
    expect(agentsContent).toContain("`api/` holds single-step checks");
    expect(agentsContent).toContain("`flows/` holds multi-step scenarios");
  });

  it("生成される AGENTS.md にはエージェント実行環境向けの注意書き(klaus ui の長時間実行・Codex CLI のネットワーク制限)が含まれる", async () => {
    await initCommand(workDir);

    const agentsContent = await readFile(join(workDir, "AGENTS.md"), "utf-8");
    expect(agentsContent).toContain("## Notes for agent environments");
    expect(agentsContent).toContain("waits forever");
    expect(agentsContent).toContain("run it in the background with an explicit timeout");
    expect(agentsContent).toContain("network_access = true");
    expect(agentsContent).toContain("~/.codex/config.toml");
  });

  it("生成される AGENTS.md には assert の運用指針(未指定時に HTTP 500 でも passed になる旨・最低 assert.status を書くべき旨)が含まれる", async () => {
    await initCommand(workDir);

    const agentsContent = await readFile(join(workDir, "AGENTS.md"), "utf-8");
    expect(agentsContent).toContain("## Assert operating guidance");
    expect(agentsContent).toContain("even on HTTP 500");
    expect(agentsContent).toContain("assert.status");
  });

  it("生成される AGENTS.md には保護環境($protected / --allow-protected)の説明が含まれる", async () => {
    await initCommand(workDir);

    const agentsContent = await readFile(join(workDir, "AGENTS.md"), "utf-8");
    expect(agentsContent).toContain("--allow-protected");
    expect(agentsContent).toContain("$protected: true");
  });

  it("生成した api/example.yaml は klaus のローダー(loadFlow)を通る", async () => {
    await initCommand(workDir);

    const flow = await loadFlow(join(workDir, "api", "example.yaml"));

    expect(flow.name).toBe("example flow");
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0]?.request?.method).toBe("GET");
    expect(flow.steps[0]?.request?.url).toBe("https://example.com");
    expect(flow.steps[0]?.assert?.status).toBe(200);
  });

  it("既存ファイルは上書きせず、スキップとして報告する", async () => {
    await mkdir(join(workDir, "api"), { recursive: true });
    await writeFile(join(workDir, "api", "example.yaml"), "name: keep me\nsteps: []\n", "utf-8");

    const exitCode = await initCommand(workDir);

    expect(exitCode).toBe(0);
    const preserved = await readFile(join(workDir, "api", "example.yaml"), "utf-8");
    expect(preserved).toBe("name: keep me\nsteps: []\n");
    expect(stdoutSpy.join("")).toContain("skipped (already exists): api/example.yaml");
    // environments/local.yaml と AGENTS.md と .klaus/.gitignore は既存ファイルが無いので通常どおり作成される
    await readFile(join(workDir, "environments", "local.yaml"), "utf-8");
    await readFile(join(workDir, "AGENTS.md"), "utf-8");
    await readFile(join(workDir, ".klaus", ".gitignore"), "utf-8");
  });

  it("既存の .klaus/.gitignore は上書きせず、スキップとして報告する", async () => {
    await mkdir(join(workDir, ".klaus"), { recursive: true });
    await writeFile(join(workDir, ".klaus", ".gitignore"), "!keep-me\n", "utf-8");

    const exitCode = await initCommand(workDir);

    expect(exitCode).toBe(0);
    const preserved = await readFile(join(workDir, ".klaus", ".gitignore"), "utf-8");
    expect(preserved).toBe("!keep-me\n");
    expect(stdoutSpy.join("")).toContain(
      `skipped (already exists): ${join(".klaus", ".gitignore")}`,
    );
  });

  it("生成対象のファイルが全て既存の場合は何も作成せず、その旨のメッセージのみ出す", async () => {
    await mkdir(join(workDir, "api"), { recursive: true });
    await mkdir(join(workDir, "environments"), { recursive: true });
    await writeFile(join(workDir, "api", "example.yaml"), "name: keep me\nsteps: []\n", "utf-8");
    await writeFile(
      join(workDir, "environments", "local.yaml"),
      "baseUrl: https://keep.example.com\n",
      "utf-8",
    );
    await writeFile(join(workDir, "AGENTS.md"), "# keep me\n", "utf-8");
    await mkdir(join(workDir, ".klaus"), { recursive: true });
    await writeFile(join(workDir, ".klaus", ".gitignore"), "!keep-me\n", "utf-8");

    const exitCode = await initCommand(workDir);

    expect(exitCode).toBe(0);
    const output = stdoutSpy.join("");
    expect(output).toContain("skipped (already exists): api/example.yaml");
    expect(output).toContain("skipped (already exists): environments/local.yaml");
    expect(output).toContain("skipped (already exists): AGENTS.md");
    expect(output).toContain(`skipped (already exists): ${join(".klaus", ".gitignore")}`);
    expect(output).not.toContain("created:");
    expect(output).toContain("All target files already exist, so nothing was created.");
    // 既存の内容が保持されていること
    const preservedFlow = await readFile(join(workDir, "api", "example.yaml"), "utf-8");
    const preservedEnv = await readFile(join(workDir, "environments", "local.yaml"), "utf-8");
    const preservedAgents = await readFile(join(workDir, "AGENTS.md"), "utf-8");
    const preservedGitignore = await readFile(join(workDir, ".klaus", ".gitignore"), "utf-8");
    expect(preservedFlow).toBe("name: keep me\nsteps: []\n");
    expect(preservedEnv).toBe("baseUrl: https://keep.example.com\n");
    expect(preservedAgents).toBe("# keep me\n");
    expect(preservedGitignore).toBe("!keep-me\n");
  });
});
