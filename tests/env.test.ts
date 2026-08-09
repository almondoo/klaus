import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EnvironmentNotFoundError,
  loadEnvironment,
  resolveEnvironmentPath,
  saveEnvironment,
} from "../src/core/env.js";
import { ParseError } from "../src/core/errors.js";

describe("resolveEnvironmentPath", () => {
  it("cwd 基準で environments/<name>.yaml を解決する", () => {
    expect(resolveEnvironmentPath("/repo", "local")).toBe(
      join("/repo", "environments", "local.yaml"),
    );
  });

  it("environments/ の外を指す env 名は ParseError で拒否する(path traversal 防止)", () => {
    expect(() => resolveEnvironmentPath("/repo", "../../etc/secrets/prod")).toThrow(ParseError);
    expect(() => resolveEnvironmentPath("/repo", "../secret")).toThrow(ParseError);
  });

  describe("上方探索", () => {
    const tmpRoot = join(process.cwd(), "tmp");
    let root: string;

    beforeEach(async () => {
      await mkdir(tmpRoot, { recursive: true });
      root = await mkdtemp(join(tmpRoot, "klaus-env-search-"));
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("cwd の親ディレクトリの environments/<name>.yaml を発見する", async () => {
      await mkdir(join(root, "environments"), { recursive: true });
      await writeFile(join(root, "environments", "local.yaml"), "baseUrl: http://localhost:3000\n");
      const subDir = join(root, "sub", "nested");
      await mkdir(subDir, { recursive: true });

      expect(resolveEnvironmentPath(subDir, "local")).toBe(
        join(root, "environments", "local.yaml"),
      );
    });

    it(".git を含む祖先ディレクトリで探索を打ち切り、それより上の environments/ は見つけない", async () => {
      await mkdir(join(root, "environments"), { recursive: true });
      await writeFile(join(root, "environments", "local.yaml"), "baseUrl: http://localhost:3000\n");
      const repoDir = join(root, "repo");
      await mkdir(join(repoDir, ".git"), { recursive: true });
      const subDir = join(repoDir, "sub");
      await mkdir(subDir, { recursive: true });

      expect(resolveEnvironmentPath(subDir, "local")).toBe(
        join(subDir, "environments", "local.yaml"),
      );
    });

    it("不正な env 名は探索を開始する前に ParseError で拒否する", async () => {
      const subDir = join(root, "sub", "nested");
      await mkdir(subDir, { recursive: true });

      expect(() => resolveEnvironmentPath(subDir, "../../etc/secrets/prod")).toThrow(ParseError);
    });

    it("どの祖先にも見つからない場合は cwd 基準のパスを返す", async () => {
      // root 自体に .git を置き、探索が実リポジトリ側まで及ばないようにする(hermetic にするため)。
      // これが無いと root(tmp/ 配下)からの上方探索が実リポジトリのルートまで届いてしまい、
      // 「実リポジトリの環境ファイル配置に environments/local.yaml が無い」という
      // 偶然の前提でしかテストが成立しなくなる
      await mkdir(join(root, ".git"), { recursive: true });
      const subDir = join(root, "sub", "nested");
      await mkdir(subDir, { recursive: true });

      expect(resolveEnvironmentPath(subDir, "local")).toBe(
        join(subDir, "environments", "local.yaml"),
      );
    });

    // Windows には process.getuid が存在せず、パーミッションビットの意味論も異なるため、
    // このユーザー/パーミッション検査自体が env.ts 側でスキップされる(Windows では意味を成さない)。
    it.skipIf(process.platform === "win32")(
      "cwd より上の祖先の environments/ が other-writable な場合は ParseError で拒否する",
      async () => {
        await mkdir(join(root, "environments"), { recursive: true });
        await writeFile(
          join(root, "environments", "local.yaml"),
          "baseUrl: http://localhost:3000\n",
        );
        await chmod(join(root, "environments"), 0o777);
        const subDir = join(root, "sub", "nested");
        await mkdir(subDir, { recursive: true });

        try {
          expect(() => resolveEnvironmentPath(subDir, "local")).toThrow(ParseError);
        } finally {
          await chmod(join(root, "environments"), 0o755);
        }
      },
    );

    it.skipIf(process.platform === "win32")(
      "startDir 自身の environments/ が other-writable でも解決される(検査は cwd より上の祖先のみに適用される)",
      async () => {
        await mkdir(join(root, "environments"), { recursive: true });
        await writeFile(
          join(root, "environments", "local.yaml"),
          "baseUrl: http://localhost:3000\n",
        );
        await chmod(join(root, "environments"), 0o777);

        try {
          expect(resolveEnvironmentPath(root, "local")).toBe(
            join(root, "environments", "local.yaml"),
          );
        } finally {
          await chmod(join(root, "environments"), 0o755);
        }
      },
    );

    it.skipIf(process.platform === "win32")(
      "祖先の environments/ が別ユーザー所有と判定される場合は ParseError で拒否する",
      async () => {
        await mkdir(join(root, "environments"), { recursive: true });
        await writeFile(
          join(root, "environments", "local.yaml"),
          "baseUrl: http://localhost:3000\n",
        );
        const subDir = join(root, "sub", "nested");
        await mkdir(subDir, { recursive: true });

        // process.getuid を実際の所有者(テストプロセス自身)とは異なる uid を返す関数に
        // 差し替え、uid 不一致の分岐を通す(tests/cli/run.test.ts の process.cwd 差し替えと同じ作法)。
        const getuidSpy = process.getuid;
        process.getuid = () => (getuidSpy ? getuidSpy() + 1 : 1);
        try {
          expect(() => resolveEnvironmentPath(subDir, "local")).toThrow(ParseError);
        } finally {
          // exactOptionalPropertyTypes 下では getuidSpy(() => number | undefined)をそのまま
          // 代入できないため、元の値(POSIX では常に関数)へ戻すことを明示するキャストを行う。
          process.getuid = getuidSpy as () => number;
        }
      },
    );
  });
});

describe("loadEnvironment", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-env-"));
    await mkdir(join(dir, "environments"), { recursive: true });
    await writeFile(
      join(dir, "environments", "local.yaml"),
      "baseUrl: http://localhost:3000\n",
      "utf-8",
    );
    await writeFile(
      join(dir, "environments", "staging.yaml"),
      "baseUrl: https://staging.example.com\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("フロー定義の env を使って環境ファイルを読み込む", async () => {
    const env = await loadEnvironment(dir, "local");
    expect(env.baseUrl).toBe("http://localhost:3000");
  });

  it("envNameOverride がフロー定義の env より優先される", async () => {
    const env = await loadEnvironment(dir, "local", "staging");
    expect(env.baseUrl).toBe("https://staging.example.com");
  });

  it("env が未指定なら空オブジェクトを返す", async () => {
    const env = await loadEnvironment(dir, undefined);
    expect(env).toEqual({});
  });
});

describe("saveEnvironment", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let dir: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    dir = await mkdtemp(join(tmpRoot, "klaus-env-save-"));
    // 上方探索が実リポジトリ側まで及ばないよう境界にする(resolveEnvironmentPath のテストと同様の理由)
    await mkdir(join(dir, ".git"), { recursive: true });
    await mkdir(join(dir, "environments"), { recursive: true });
    await writeFile(
      join(dir, "environments", "local.yaml"),
      "# base URL\nbaseUrl: http://localhost:3000 # 開発用\napiKey: old-secret\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("値を更新しつつ既存のコメントを保持する", async () => {
    await saveEnvironment(dir, "local", {
      baseUrl: "http://localhost:4000",
      apiKey: "old-secret",
    });

    const content = await readFile(join(dir, "environments", "local.yaml"), "utf-8");
    expect(content).toContain("# base URL");
    expect(content).toContain("baseUrl: http://localhost:4000 # 開発用");
    expect(content).toContain("apiKey: old-secret");
  });

  it("values に無い既存キーを削除する", async () => {
    await saveEnvironment(dir, "local", { baseUrl: "http://localhost:3000" });

    const content = await readFile(join(dir, "environments", "local.yaml"), "utf-8");
    expect(content).not.toContain("apiKey");
  });

  it("environments/ の外を指す env 名は ParseError で拒否する(path traversal 防止)", async () => {
    await expect(saveEnvironment(dir, "../../etc/secrets/prod", { baseUrl: "x" })).rejects.toThrow(
      ParseError,
    );
  });

  it("対象ファイルが存在しない場合は EnvironmentNotFoundError を投げる(新規作成はスコープ外)", async () => {
    await expect(saveEnvironment(dir, "missing", { baseUrl: "x" })).rejects.toThrow(
      EnvironmentNotFoundError,
    );
  });
});
