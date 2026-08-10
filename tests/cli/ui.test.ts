import { afterEach, describe, expect, it } from "vitest";
import { program } from "../../src/cli/index.js";
import { openBrowser } from "../../src/cli/ui.js";

describe("openBrowser", () => {
  let stderrSpy: typeof process.stderr.write | undefined;

  afterEach(() => {
    if (stderrSpy) {
      process.stderr.write = stderrSpy;
      stderrSpy = undefined;
    }
  });

  it("存在しない opener コマンドを指定してもプロセスをクラッシュさせず、stderr に警告を出す", async () => {
    stderrSpy = process.stderr.write;
    const chunks: string[] = [];
    let resolveWarning: () => void;
    const warningEmitted = new Promise<void>((resolve) => {
      resolveWarning = resolve;
    });
    process.stderr.write = ((chunk: string) => {
      chunks.push(chunk.toString());
      resolveWarning();
      return true;
    }) as typeof process.stderr.write;

    expect(() => {
      openBrowser("http://localhost:3000", {
        command: "definitely-not-a-real-binary-12345",
        args: [],
      });
    }).not.toThrow();

    // spawn の ENOENT は 'error' イベントとして非同期に emit されるため、警告出力を待つ
    await warningEmitted;

    const output = chunks.join("");
    expect(output).toContain("could not open a browser automatically");
    expect(output).toContain("--no-open");
  });
});

describe("ui コマンドの --port / --host 既定値", () => {
  // uiCommand は options.port / options.host をそのまま startServer へ渡すだけ(src/cli/ui.ts)なので、
  // 既定ポート固定化・--host 追加の要件は commander のオプション定義(既定値)を見れば検証できる。
  // startServer の実起動はポート衝突リスクがあるためここでは行わない。
  const uiCommand = program.commands.find((c) => c.name() === "ui");
  if (!uiCommand) throw new Error("ui command not found");

  it("--port 未指定時の既定値は 4884(ランダムポートではなく固定値)", () => {
    const portOption = uiCommand.options.find((o) => o.long === "--port");
    expect(portOption?.defaultValue).toBe(4884);
  });

  it("--host 未指定時の既定値は 127.0.0.1(従来どおり localhost のみ待受)", () => {
    const hostOption = uiCommand.options.find((o) => o.long === "--host");
    expect(hostOption?.defaultValue).toBe("127.0.0.1");
  });

  it("--host は短縮形 -H を持つ(-h は commander の --help 予約と衝突するため大文字)", () => {
    const hostOption = uiCommand.options.find((o) => o.long === "--host");
    expect(hostOption?.short).toBe("-H");
  });
});
