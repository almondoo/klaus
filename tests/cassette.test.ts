import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendCassetteEntry,
  type CassetteEntry,
  cassetteEntryToHttpResponse,
  cassetteFilePath,
  loadCassetteIndex,
} from "../src/core/cassette.js";
import { RuntimeError } from "../src/core/errors.js";

describe("loadCassetteIndex", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-cassette-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("カセットファイルが存在しない場合は replay 向けの案内を含む RuntimeError を投げる", async () => {
    await expect(loadCassetteIndex(dir)).rejects.toThrow(RuntimeError);
    await expect(loadCassetteIndex(dir)).rejects.toThrow(/--record/);
  });
});

describe("appendCassetteEntry", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;

  const entry: CassetteEntry = {
    v: 1,
    method: "GET",
    url: "http://example.com/ok",
    status: 200,
    headers: {},
    bodyText: "{}",
  };

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-cassette-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "カセットファイル(0o600)とディレクトリ(0o700)を所有者のみアクセス可能な権限で作成する",
    async () => {
      await appendCassetteEntry(dir, entry);

      const fileStat = await stat(cassetteFilePath(dir));
      const dirStat = await stat(dir);
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(dirStat.mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === "win32")(
    "既存の緩い権限のディレクトリ・ファイルは追記のたびに締め直す",
    async () => {
      // 先に緩い権限で作っておく(過去バージョンで作成された既存ファイルを模す)
      await appendCassetteEntry(dir, entry);
      const filePath = cassetteFilePath(dir);
      await chmod(dir, 0o755);
      await chmod(filePath, 0o644);

      await appendCassetteEntry(dir, entry);

      const fileStat = await stat(filePath);
      const dirStat = await stat(dir);
      expect(fileStat.mode & 0o777).toBe(0o600);
      expect(dirStat.mode & 0o777).toBe(0o700);
    },
  );
});

describe("cassetteEntryToHttpResponse", () => {
  function baseEntry(overrides: Partial<CassetteEntry> = {}): CassetteEntry {
    return {
      v: 1,
      method: "GET",
      url: "http://example.com/ok",
      status: 200,
      headers: { "content-type": "application/json" },
      bodyText: '{"ok":true}',
      ...overrides,
    };
  }

  it("content-type が application/json かつ有効な JSON なら body をパースする", () => {
    const response = cassetteEntryToHttpResponse(baseEntry());
    expect(response.body).toEqual({ ok: true });
    expect(response.durationMs).toBe(0);
  });

  it("content-type が application/json でも壊れた JSON なら body はテキストのままになる", () => {
    const response = cassetteEntryToHttpResponse(baseEntry({ bodyText: "{not valid json" }));
    expect(response.body).toBe("{not valid json");
    expect(response.bodyText).toBe("{not valid json");
  });

  it("content-type が JSON でない場合は body をパースせずテキストのまま返す", () => {
    const response = cassetteEntryToHttpResponse(
      baseEntry({ headers: { "content-type": "text/plain" }, bodyText: "plain text" }),
    );
    expect(response.body).toBe("plain text");
  });
});
