import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectActor, resolveGitState } from "../../src/cli/audit.js";

describe("detectActor", () => {
  it("マーカー無しなら human", () => {
    expect(detectActor({})).toEqual({ kind: "human" });
  });

  it("CI 環境変数があれば ci(空・false・0 は無視する)", () => {
    expect(detectActor({ CI: "true" })).toEqual({ kind: "ci" });
    expect(detectActor({ CI: "1" })).toEqual({ kind: "ci" });
    expect(detectActor({ CI: "" })).toEqual({ kind: "human" });
    expect(detectActor({ CI: "false" })).toEqual({ kind: "human" });
    expect(detectActor({ CI: "0" })).toEqual({ kind: "human" });
  });

  it("CLAUDECODE があれば agent(name は claude-code)", () => {
    expect(detectActor({ CLAUDECODE: "1" })).toEqual({ kind: "agent", name: "claude-code" });
  });

  it("AI_AGENT があれば agent で、値をそのまま name にする(長すぎる値は切り詰める)", () => {
    expect(detectActor({ AI_AGENT: "some-agent_1-2-3" })).toEqual({
      kind: "agent",
      name: "some-agent_1-2-3",
    });
    expect(detectActor({ AI_AGENT: "x".repeat(300) }).name).toHaveLength(100);
  });

  it("agent と CI が両方ある場合は agent を優先する", () => {
    expect(detectActor({ CLAUDECODE: "1", CI: "true" }).kind).toBe("agent");
  });

  it("--actor の名前は推定した kind を保ったまま name だけを上書きする", () => {
    expect(detectActor({}, "alice")).toEqual({ kind: "human", name: "alice" });
    expect(detectActor({ CI: "true" }, "pipeline-7")).toEqual({ kind: "ci", name: "pipeline-7" });
    expect(detectActor({ CLAUDECODE: "1" }, "reviewer-bot")).toEqual({
      kind: "agent",
      name: "reviewer-bot",
    });
  });
});

describe("resolveGitState", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let repo: string;

  /** テスト用の一時リポジトリ内で git を実行する(グローバル設定に依存しないよう識別子と署名設定を明示する) */
  function git(...args: string[]) {
    execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repo, stdio: "ignore" },
    );
  }

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    repo = await mkdtemp(join(tmpRoot, "klaus-audit-git-"));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("コミット済みのクリーンなリポジトリでは commit と dirty: false を返す", async () => {
    git("init", "-q");
    await writeFile(join(repo, "a.txt"), "a\n", "utf-8");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");

    const state = await resolveGitState(repo);

    expect(state?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(state?.dirty).toBe(false);
  });

  it("追跡ファイルを変更すると dirty: true、未追跡ファイルだけなら dirty: false のまま", async () => {
    git("init", "-q");
    await writeFile(join(repo, "a.txt"), "a\n", "utf-8");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");

    await writeFile(join(repo, "untracked.txt"), "u\n", "utf-8");
    expect((await resolveGitState(repo))?.dirty).toBe(false);

    await writeFile(join(repo, "a.txt"), "changed\n", "utf-8");
    expect((await resolveGitState(repo))?.dirty).toBe(true);
  });

  it("コミットが無いリポジトリでは何も返さない(履歴の git フィールドを省くだけ)", async () => {
    git("init", "-q");

    expect(await resolveGitState(repo)).toBeUndefined();
  });

  it("作業ディレクトリが存在しないなど git の実行に失敗する場合も例外にせず undefined を返す", async () => {
    expect(await resolveGitState(join(repo, "does-not-exist"))).toBeUndefined();
  });
});
