/**
 * dist/ を丸ごと削除するクリーンスクリプト。
 *
 * tsup 側は clean: false にしている(dist/ui を巻き添えで消さないため)。
 * その代償として、エントリを削除・リネームした際に古い成果物が dist/ に残り続け、
 * package.json の files: ["dist"] によって publish に同梱されうる。
 * リリース用のフルビルド(build:all)では必ずこのスクリプトで dist/ を空にしてから
 * ビルドし直すことで、その事故を防ぐ。
 */
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(projectRoot, "dist");

await rm(distDir, { recursive: true, force: true });
console.log(`cleaned: ${distDir}`);
