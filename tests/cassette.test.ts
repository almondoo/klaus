import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CassetteEntry,
  cassetteEntryToHttpResponse,
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
