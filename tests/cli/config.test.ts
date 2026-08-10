import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyConfigToRunOptions,
  applyConfigToUiOptions,
  loadCliConfig,
} from "../../src/cli/config.js";
import type { RunCommandOptions } from "../../src/cli/run.js";
import type { UiCommandOptions } from "../../src/cli/ui.js";
import { ParseError } from "../../src/core/errors.js";

describe("loadCliConfig", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let root: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    root = await mkdtemp(join(tmpRoot, "klaus-cli-config-"));
    // 上方探索が実リポジトリ側まで及ばないよう境界にする(tests/env.test.ts と同じ理由)
    await mkdir(join(root, ".git"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("cwd 直下の klaus.config.yaml を読み込む", async () => {
    await writeFile(join(root, "klaus.config.yaml"), "run:\n  env: local\n", "utf-8");

    const config = await loadCliConfig(root);
    expect(config?.run?.env).toBe("local");
  });

  it("上方探索でサブディレクトリの祖先にある klaus.config.yaml を発見する", async () => {
    await writeFile(join(root, "klaus.config.yaml"), "run:\n  env: staging\n", "utf-8");
    const subDir = join(root, "sub", "nested");
    await mkdir(subDir, { recursive: true });

    const config = await loadCliConfig(subDir);
    expect(config?.run?.env).toBe("staging");
  });

  it(".git を含む祖先ディレクトリで探索を打ち切り、それより上の klaus.config.yaml は見つけない", async () => {
    await writeFile(join(root, "klaus.config.yaml"), "run:\n  env: outer\n", "utf-8");
    const repoDir = join(root, "repo");
    await mkdir(join(repoDir, ".git"), { recursive: true });
    const subDir = join(repoDir, "sub");
    await mkdir(subDir, { recursive: true });

    const config = await loadCliConfig(subDir);
    expect(config).toBeUndefined();
  });

  it("どの祖先にも見つからない場合は undefined を返す", async () => {
    const subDir = join(root, "sub", "nested");
    await mkdir(subDir, { recursive: true });

    const config = await loadCliConfig(subDir);
    expect(config).toBeUndefined();
  });

  it("不正な YAML はファイルパス付きの ParseError で拒否する", async () => {
    await writeFile(join(root, "klaus.config.yaml"), "run: [\n", "utf-8");

    await expect(loadCliConfig(root)).rejects.toThrow(ParseError);
    await expect(loadCliConfig(root)).rejects.toThrow(/klaus\.config\.yaml/);
  });

  it("未知キーを含むスキーマ違反はファイルパス付きの ParseError で拒否する", async () => {
    await writeFile(join(root, "klaus.config.yaml"), "run:\n  unknownKey: x\n", "utf-8");

    await expect(loadCliConfig(root)).rejects.toThrow(ParseError);
    await expect(loadCliConfig(root)).rejects.toThrow(/klaus\.config\.yaml/);
  });

  it("run.report が junit 以外の場合はスキーマ違反として拒否する", async () => {
    await writeFile(join(root, "klaus.config.yaml"), "run:\n  report: xml\n", "utf-8");

    await expect(loadCliConfig(root)).rejects.toThrow(ParseError);
  });

  it("ui.port が範囲外の場合はスキーマ違反として拒否する", async () => {
    await writeFile(join(root, "klaus.config.yaml"), "ui:\n  port: 0\n", "utf-8");

    await expect(loadCliConfig(root)).rejects.toThrow(ParseError);
  });

  it("klaus.config.yaml と同名のディレクトリが存在する場合、読み込み時のエラーとして ParseError を投げる", async () => {
    // existsSync はディレクトリでも true を返すため resolveConfigPath はこのパスを候補として
    // 採用してしまうが、続く readFile がディレクトリ read(EISDIR)で失敗する経路を確認する
    await mkdir(join(root, "klaus.config.yaml"), { recursive: true });

    await expect(loadCliConfig(root)).rejects.toThrow(ParseError);
    await expect(loadCliConfig(root)).rejects.toThrow(/failed to read file/);
  });

  it("どの祖先(.git を含む祖先・ファイルシステムルートのいずれも)にも klaus.config.yaml が無ければ undefined を返す", async () => {
    // 実在しない絶対パスを cwd として渡す。上方探索は existsSync ベースで、対象ディレクトリ自体の
    // 実在は問わないため、実ファイルシステムのルートまで安全に辿り着ける
    // (tests/env.test.ts の resolveEnvironmentPath("/repo", ...) と同じ手法)。
    const config = await loadCliConfig("/klaus-config-search-boundary-test/nested/dir");
    expect(config).toBeUndefined();
  });
});

describe("applyConfigToRunOptions", () => {
  function baseOptions(overrides: Partial<RunCommandOptions> = {}): RunCommandOptions {
    return {
      history: true,
      mask: true,
      reportFile: "klaus-report.xml",
      ...overrides,
    };
  }

  it("config が無ければ options をそのまま返す", () => {
    const options = baseOptions();
    expect(applyConfigToRunOptions(options, {}, undefined)).toBe(options);
  });

  it("config.run が無ければ options をそのまま返す", () => {
    const options = baseOptions();
    expect(applyConfigToRunOptions(options, {}, {})).toBe(options);
  });

  it("CLI で明示指定されなかったオプションには config の値を適用する", () => {
    const options = baseOptions();
    const merged = applyConfigToRunOptions(
      options,
      {
        env: "default",
        report: "default",
        reportFile: "default",
        history: "default",
        mask: "default",
      },
      {
        run: {
          env: "local",
          report: "junit",
          reportFile: "custom.xml",
          history: false,
          mask: false,
        },
      },
    );
    expect(merged).toEqual({
      history: false,
      mask: false,
      reportFile: "custom.xml",
      env: "local",
      report: "junit",
    });
  });

  it("CLI で明示指定されたオプションは config より優先される", () => {
    const options = baseOptions({ env: "cli-env" });
    const merged = applyConfigToRunOptions(options, { env: "cli" }, { run: { env: "config-env" } });
    expect(merged.env).toBe("cli-env");
  });

  it("--no-history / --no-mask の負論理も source 判定で自然に扱える", () => {
    // CLI で明示的に --no-history / --no-mask を指定した場合(source: cli)は config を上書きしない
    const explicitOptions = baseOptions({ history: false, mask: false });
    const explicitMerged = applyConfigToRunOptions(
      explicitOptions,
      { history: "cli", mask: "cli" },
      { run: { history: true, mask: true } },
    );
    expect(explicitMerged.history).toBe(false);
    expect(explicitMerged.mask).toBe(false);

    // CLI で未指定(source: default)の場合は config の値(false)が効く
    const defaultOptions = baseOptions();
    const defaultMerged = applyConfigToRunOptions(
      defaultOptions,
      { history: "default", mask: "default" },
      { run: { history: false, mask: false } },
    );
    expect(defaultMerged.history).toBe(false);
    expect(defaultMerged.mask).toBe(false);
  });
});

describe("applyConfigToUiOptions", () => {
  function baseOptions(overrides: Partial<UiCommandOptions> = {}): UiCommandOptions {
    return { open: true, ...overrides };
  }

  it("config が無ければ options をそのまま返す", () => {
    const options = baseOptions();
    expect(applyConfigToUiOptions(options, {}, undefined)).toBe(options);
  });

  it("CLI で明示指定されなかったオプションには config の値を適用する", () => {
    const options = baseOptions({ port: 4884, host: "127.0.0.1" });
    const merged = applyConfigToUiOptions(
      options,
      { port: "default", host: "default", open: "default" },
      { ui: { port: 5000, host: "0.0.0.0", open: false } },
    );
    expect(merged).toEqual({ port: 5000, host: "0.0.0.0", open: false });
  });

  it("CLI で明示指定されたオプションは config より優先される", () => {
    const options = baseOptions({ port: 6000 });
    const merged = applyConfigToUiOptions(options, { port: "cli" }, { ui: { port: 5000 } });
    expect(merged.port).toBe(6000);
  });

  it("--no-open の負論理も source 判定で自然に扱える", () => {
    const explicitOptions = baseOptions({ open: false });
    const explicitMerged = applyConfigToUiOptions(
      explicitOptions,
      { open: "cli" },
      { ui: { open: true } },
    );
    expect(explicitMerged.open).toBe(false);

    const defaultOptions = baseOptions();
    const defaultMerged = applyConfigToUiOptions(
      defaultOptions,
      { open: "default" },
      { ui: { open: false } },
    );
    expect(defaultMerged.open).toBe(false);
  });
});
