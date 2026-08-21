import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { program } from "../../src/cli/index.js";
import { AGENTS_MD } from "../../src/cli/init.js";
import { buildFlowJsonSchema } from "../../src/cli/schema.js";

/**
 * エージェント向けドキュメント(skills/klaus/SKILL.md、klaus init が生成する AGENTS.md テンプレート)が
 * 実装からドリフトしていないかを検知するテスト。ドキュメント内容そのものの網羅性は保証しないが、
 * 「コマンドが増えたのに一覧に載っていない」「誤った制約が書かれたまま残る」といった既知の劣化パターンを防ぐ。
 */

const skillMdPath = join(__dirname, "..", "..", "skills", "klaus", "SKILL.md");

describe("agent-facing docs drift guard", () => {
  it("登録済みの全コマンド名が SKILL.md と AGENTS.md テンプレートの両方に載っている", async () => {
    const skillMd = await readFile(skillMdPath, "utf-8");
    const commandNames = program.commands.map((c) => c.name());

    // generate/init/ui 等、将来コマンドが増えても自動で検知できるよう name() を動的に列挙する
    expect(commandNames.length).toBeGreaterThan(0);
    for (const name of commandNames) {
      expect(skillMd, `SKILL.md is missing command "${name}"`).toContain(`klaus ${name}`);
      expect(AGENTS_MD, `AGENTS_MD is missing command "${name}"`).toContain(`klaus ${name}`);
    }
  });

  it("安全機能/オプションの厳選リストが SKILL.md と AGENTS.md テンプレートの両方に載っている", async () => {
    const skillMd = await readFile(skillMdPath, "utf-8");
    // ここは網羅リストではなく意図的に絞ったキュレーションリスト
    // (docs は意図的に圧縮されているため、全オプションを網羅するテストにすると壊れやすくなる)
    const curatedTerms = ["--allow-protected", "$protected", "--record", "--replay"];

    for (const term of curatedTerms) {
      expect(skillMd, `SKILL.md is missing "${term}"`).toContain(term);
      expect(AGENTS_MD, `AGENTS_MD is missing "${term}"`).toContain(term);
    }
  });

  it("ステップ制約の正しい文言(request/ws/use)が AGENTS.md に含まれ、古い文言(request/ws のみ)がどこにも残っていない", async () => {
    const skillMd = await readFile(skillMdPath, "utf-8");
    const flowSchemaJson = JSON.stringify(buildFlowJsonSchema());

    const correctWording = /`request`, `ws`, or `use`/;
    const staleWording = /`request` or `ws`/;

    expect(AGENTS_MD).toMatch(correctWording);
    expect(skillMd).not.toMatch(staleWording);
    expect(AGENTS_MD).not.toMatch(staleWording);
    expect(flowSchemaJson).not.toMatch(staleWording);
  });
});
