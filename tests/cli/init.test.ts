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

  it("空のディレクトリに api/example.yaml と environments/local.yaml と AGENTS.md を生成する", async () => {
    const exitCode = await initCommand(workDir);

    expect(exitCode).toBe(0);
    const flowContent = await readFile(join(workDir, "api", "example.yaml"), "utf-8");
    const envContent = await readFile(join(workDir, "environments", "local.yaml"), "utf-8");
    const agentsContent = await readFile(join(workDir, "AGENTS.md"), "utf-8");
    expect(flowContent).toContain("name: example flow");
    expect(envContent).toContain("baseUrl:");
    expect(agentsContent).toContain("# AGENTS guide for klaus");
    expect(stdoutSpy.join("")).toContain("created: api/example.yaml");
    expect(stdoutSpy.join("")).toContain("created: environments/local.yaml");
    expect(stdoutSpy.join("")).toContain("created: AGENTS.md");
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
    // environments/local.yaml と AGENTS.md は既存ファイルが無いので通常どおり作成される
    await readFile(join(workDir, "environments", "local.yaml"), "utf-8");
    await readFile(join(workDir, "AGENTS.md"), "utf-8");
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

    const exitCode = await initCommand(workDir);

    expect(exitCode).toBe(0);
    const output = stdoutSpy.join("");
    expect(output).toContain("skipped (already exists): api/example.yaml");
    expect(output).toContain("skipped (already exists): environments/local.yaml");
    expect(output).toContain("skipped (already exists): AGENTS.md");
    expect(output).not.toContain("created:");
    expect(output).toContain("All target files already exist, so nothing was created.");
    // 既存の内容が保持されていること
    const preservedFlow = await readFile(join(workDir, "api", "example.yaml"), "utf-8");
    const preservedEnv = await readFile(join(workDir, "environments", "local.yaml"), "utf-8");
    const preservedAgents = await readFile(join(workDir, "AGENTS.md"), "utf-8");
    expect(preservedFlow).toBe("name: keep me\nsteps: []\n");
    expect(preservedEnv).toBe("baseUrl: https://keep.example.com\n");
    expect(preservedAgents).toBe("# keep me\n");
  });
});
