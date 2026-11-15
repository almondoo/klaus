import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Claude Code プラグインのマニフェスト(.claude-plugin/)が package.json からドリフトしていないかを検知するテスト。
 * マニフェストの網羅的な検証は claude plugin validate に任せ、ここでは手で同期している値だけを守る。
 */

const root = join(__dirname, "..");

async function readJson(...segments: string[]) {
  return JSON.parse(await readFile(join(root, ...segments), "utf-8"));
}

describe("Claude Code plugin manifest drift guard", () => {
  it("plugin.json の license が package.json と一致し、name が klaus である", async () => {
    const pkg = await readJson("package.json");
    const plugin = await readJson(".claude-plugin", "plugin.json");

    expect(plugin.license).toBe(pkg.license);
    expect(plugin.name).toBe("klaus");
  });

  it("MCP サーバーは npx で package.json の name の @latest を mcp 付きで起動する", async () => {
    const pkg = await readJson("package.json");
    const plugin = await readJson(".claude-plugin", "plugin.json");
    const server = plugin.mcpServers.klaus;

    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", `${pkg.name}@latest`, "mcp"]);
  });

  it("marketplace.json はプラグインを1つだけ持ち、plugin.json の name と一致して ./ を指す", async () => {
    const plugin = await readJson(".claude-plugin", "plugin.json");
    const marketplace = await readJson(".claude-plugin", "marketplace.json");

    // ドキュメントのインストール ID(klaus@klaus)がこの name に依存する
    expect(marketplace.name).toBe("klaus");
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0].name).toBe(plugin.name);
    expect(marketplace.plugins[0].source).toBe("./");
  });
});
