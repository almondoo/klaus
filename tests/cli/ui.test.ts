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

  /**
   * commandOverride を省略すると内部の resolveOpener(プラットフォーム別のデフォルト opener)を通る。
   * darwin(このテスト実行機の実プラットフォーム)は実在する "open" コマンドを spawn してしまい
   * 実際にブラウザが開いてしまう(テストの副作用として望ましくない)ため、darwin 以外の
   * プラットフォーム分岐(win32/その他)のみを process.platform の一時差し替えで検証する。
   * 対象コマンド(cmd/xdg-open)は実行環境に実在しうる(CI の ubuntu には xdg-open がある)ため、
   * PATH も実在しないディレクトリに差し替えて、どの OS でも決定的に ENOENT にする。
   */
  it.each([
    { platform: "win32", expectedCommand: "cmd" },
    { platform: "linux", expectedCommand: "xdg-open" },
  ])(
    "commandOverride 省略時、process.platform = $platform では $expectedCommand を opener として使う(実在しないため ENOENT で警告に留まる)",
    async ({ platform }) => {
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

      const originalPlatform = process.platform;
      const originalPath = process.env.PATH;
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      process.env.PATH = "/nonexistent-path-for-enoent-test";
      try {
        expect(() => {
          openBrowser("http://localhost:3000");
        }).not.toThrow();

        await warningEmitted;
      } finally {
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        process.env.PATH = originalPath;
      }

      const output = chunks.join("");
      expect(output).toContain("could not open a browser automatically");
    },
  );
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
