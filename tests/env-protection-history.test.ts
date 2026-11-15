import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  executeSingleRequest,
  flowSchema,
  readAllHistoryEntries,
  runLoadedFlows,
} from "../src/core/index.js";
import { closeServer, listenEphemeral } from "./support/net.js";

/**
 * 保護された環境($protected)で書かれた履歴エントリには envProtection が記録される。
 * 名前付き環境でも --env-file でも、CLI・UI・MCP のどの入口でも、拒否のエントリでも付き、保護なしでは付かない。
 */

const tmpRoot = join(process.cwd(), "tmp");
let fixture: Server;
let baseUrl = "";
let base = "";

beforeAll(async () => {
  fixture = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  ({ baseUrl } = await listenEphemeral(fixture));
  await mkdir(tmpRoot, { recursive: true });
});

afterAll(async () => {
  await closeServer(fixture);
});

beforeEach(async () => {
  base = await mkdtemp(join(tmpRoot, "klaus-env-protection-"));
  await mkdir(join(base, "environments"), { recursive: true });
  await mkdir(join(base, "secrets"), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function writeEnv(relPath: string, protectedLine: string): Promise<string> {
  const filePath = join(base, relPath);
  await writeFile(
    filePath,
    `${protectedLine}baseUrl: ${baseUrl}\ntoken: tok-value-1234\n`,
    "utf-8",
  );
  return filePath;
}

const request = { method: "GET" as const, url: "{{baseUrl}}/ok" };

function loadedFlow(env?: string) {
  return [
    {
      filePath: join(base, "api", "f.yaml"),
      flow: flowSchema.parse({
        name: "f",
        ...(env !== undefined ? { env } : {}),
        steps: [{ name: "get", request }],
      }),
    },
  ];
}

describe("履歴エントリの envProtection", () => {
  it("名前付きの保護環境(readonly)での単発リクエストに protected 種別が記録される", async () => {
    await writeEnv("environments/ro.yaml", "$protected: readonly\n");

    await executeSingleRequest({ request, cwd: base, envName: "ro", history: true });

    const [entry] = await readAllHistoryEntries(base);
    expect(entry).toMatchObject({ env: "ro", envProtection: "readonly", status: "passed" });
  });

  it("--env-file(秘密のディレクトリ)の保護環境でのフロー実行に記録される(allowProtected で通した true も)", async () => {
    const envFilePath = await writeEnv("secrets/vault.yaml", "$protected: true\n");

    await runLoadedFlows(loadedFlow(), {
      cwd: base,
      envFilePath,
      allowProtected: true,
      history: true,
    });

    const [entry] = await readAllHistoryEntries(base);
    expect(entry).toMatchObject({
      env: "vault.yaml",
      envProtection: "protected",
      status: "passed",
    });
  });

  it("入口(CLI 相当・ui・mcp)に依らず記録され、拒否されたステップのエントリにも付く", async () => {
    await writeEnv("environments/prod.yaml", "$protected: true\n");

    for (const entryPoint of [undefined, "ui", "mcp"] as const) {
      await runLoadedFlows(loadedFlow(), {
        cwd: base,
        envNameOverride: "prod",
        entryPoint,
        history: true,
      });
    }
    await executeSingleRequest({
      request,
      cwd: base,
      envName: "prod",
      entryPoint: "mcp",
      history: true,
    });

    const entries = await readAllHistoryEntries(base);
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        env: "prod",
        envProtection: "protected",
        errorCode: "guard.protected",
      });
    }
  });

  it("フロー自身の env: が保護環境のときも記録される", async () => {
    await writeEnv("environments/ro.yaml", "$protected: readonly\n");

    await runLoadedFlows(loadedFlow("ro"), { cwd: base, history: true });

    const [entry] = await readAllHistoryEntries(base);
    expect(entry).toMatchObject({ env: "ro", envProtection: "readonly" });
  });

  it("保護されていない環境・環境なしのエントリには付かない", async () => {
    await writeEnv("environments/dev.yaml", "");
    const plain = await writeEnv("secrets/plain.yaml", "$protected: false\n");

    await executeSingleRequest({ request, cwd: base, envName: "dev", history: true });
    await executeSingleRequest({
      request: { method: "GET", url: `${baseUrl}/ok` },
      cwd: base,
      history: true,
    });
    await runLoadedFlows(loadedFlow(), { cwd: base, envFilePath: plain, history: true });

    const entries = await readAllHistoryEntries(base);
    expect(entries).toHaveLength(3);
    for (const entry of entries) expect(entry).not.toHaveProperty("envProtection");
  });
});
