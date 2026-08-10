import type { Command } from "commander";
import { describe, expect, it } from "vitest";
import { program } from "../../src/cli/index.js";

/**
 * outputHelp() は addHelpText で追加したテキストも含めて書き出す
 * (helpInformation() は組み込みヘルプ本文のみで addHelpText 分を含まない)。
 * writeOut を差し替えて出力を文字列として捕捉する。
 */
function captureHelpOutput(command: Command): string {
  let captured = "";
  command.configureOutput({ writeOut: (str) => (captured += str) });
  command.outputHelp();
  return captured;
}

describe("--help", () => {
  it("ルートヘルプの末尾に docs サイト・klaus init・exit code の要約を含む", () => {
    const help = captureHelpOutput(program);
    expect(help).toContain("https://almondoo.github.io/klaus/");
    expect(help).toContain("/ja/");
    expect(help).toContain("klaus init");
    expect(help).toContain(
      "0=success / 1=unexpected error / 2=invalid definition / 3=runtime error / 4=assertion failure",
    );
  });

  it("run サブコマンドのヘルプ末尾にも docs サイト・exit code の要約を含む", () => {
    const runCommand = program.commands.find((c) => c.name() === "run");
    expect(runCommand).toBeDefined();
    const help = runCommand ? captureHelpOutput(runCommand) : "";
    expect(help).toContain("https://almondoo.github.io/klaus/");
    expect(help).toContain(
      "0=success / 1=unexpected error / 2=invalid definition / 3=runtime error / 4=assertion failure",
    );
  });
});
