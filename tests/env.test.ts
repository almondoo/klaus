import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EnvironmentNotFoundError,
  isProtectedEnvironment,
  loadEnvironment,
  resolveEnvironmentPath,
  saveEnvironment,
  toTemplateVariables,
} from "../src/core/env.js";
import { ParseError } from "../src/core/errors.js";
import { environmentSchema } from "../src/core/schema.js";

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

describe("resolveEnvironmentPath / シンボリックリンク境界(isRealPathWithinDir)", () => {
  const tmpRoot = join(process.cwd(), "tmp");
  let root: string;
  let outsideRoot: string;

  beforeEach(async () => {
    await mkdir(tmpRoot, { recursive: true });
    root = await mkdtemp(join(tmpRoot, "klaus-env-symlink-"));
    outsideRoot = await mkdtemp(join(tmpRoot, "klaus-env-symlink-outside-"));
    // 上方探索が実リポジトリ側まで及ばないよう境界にする(resolveEnvironmentPath の他テストと同様の理由)
    await mkdir(join(root, ".git"), { recursive: true });
    await mkdir(join(root, "environments"), { recursive: true });
    await writeFile(
      join(root, "environments", "local.yaml"),
      "baseUrl: http://localhost:3000\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it("environments/ 配下のシンボリックリンクが境界外を指す場合は ParseError で拒否する(readFile が追随する前に検知する)", async () => {
    await writeFile(join(outsideRoot, "secret.yaml"), "apiKey: leaked\n", "utf-8");
    await symlink(join(outsideRoot, "secret.yaml"), join(root, "environments", "prod.yaml"));

    expect(() => resolveEnvironmentPath(root, "prod")).toThrow(ParseError);
  });

  it("environments/ 配下の通常ファイル(シンボリックリンクでない)は従来どおり解決される", () => {
    expect(resolveEnvironmentPath(root, "local")).toBe(join(root, "environments", "local.yaml"));
  });

  it("environments/<name>.yaml がまだ存在しない場合(新規作成前)も境界チェックを通過する(saveEnvironment の新規ファイルケース)", () => {
    expect(resolveEnvironmentPath(root, "brand-new")).toBe(
      join(root, "environments", "brand-new.yaml"),
    );
  });

  it("cwd 自身がシンボリックリンク経由で到達される場合でも誤って拒否しない(境界ディレクトリの realpath 解決)", async () => {
    const linkedCwd = join(tmpRoot, `klaus-env-symlink-link-${process.pid}-${Date.now()}`);
    await symlink(root, linkedCwd, "dir");
    try {
      expect(resolveEnvironmentPath(linkedCwd, "local")).toBe(
        join(linkedCwd, "environments", "local.yaml"),
      );
    } finally {
      await rm(linkedCwd, { force: true });
    }
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

  describe("envFilePath(--env-file 相当)", () => {
    it("environments/ の外にある任意パスの環境ファイルを、上方探索・境界チェックを経ずに直接読み込む", async () => {
      const outsideDir = await mkdtemp(join(tmpRoot, "klaus-env-outside-"));
      try {
        const filePath = join(outsideDir, "custom.yaml");
        await writeFile(filePath, "baseUrl: https://outside.example.com\n", "utf-8");

        const env = await loadEnvironment(dir, undefined, undefined, filePath);

        expect(env.baseUrl).toBe("https://outside.example.com");
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it("envNameOverride より優先される", async () => {
      const outsideDir = await mkdtemp(join(tmpRoot, "klaus-env-outside-"));
      try {
        const filePath = join(outsideDir, "custom.yaml");
        await writeFile(filePath, "baseUrl: https://from-file.example.com\n", "utf-8");

        const env = await loadEnvironment(dir, "local", "staging", filePath);

        expect(env.baseUrl).toBe("https://from-file.example.com");
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it("相対パスは cwd 引数基準で解決する(process.cwd() は使わない)", async () => {
      // dir(cwd 引数)には無く process.cwd()(テストプロセスの実行位置)直下にだけ同名ファイルが
      // 存在するケースを作ることで、誤って process.cwd() を基準に解決していないことを検証する。
      const relativeName = "relative-env.yaml";
      await writeFile(
        join(dir, relativeName),
        "baseUrl: https://from-cwd-arg.example.com\n",
        "utf-8",
      );
      const decoyPath = join(process.cwd(), relativeName);
      await writeFile(decoyPath, "baseUrl: https://from-process-cwd.example.com\n", "utf-8");
      try {
        const env = await loadEnvironment(dir, undefined, undefined, relativeName);
        expect(env.baseUrl).toBe("https://from-cwd-arg.example.com");
      } finally {
        await rm(decoyPath, { force: true });
      }
    });

    it("存在しないパスを指定すると ParseError になる", async () => {
      await expect(
        loadEnvironment(dir, undefined, undefined, join(dir, "no-such-file.yaml")),
      ).rejects.toThrow(ParseError);
    });

    it("$protected: true のファイルも通常どおり読み込む(拒否は runner 側の checkEnvironmentAllowed の責務)", async () => {
      const outsideDir = await mkdtemp(join(tmpRoot, "klaus-env-outside-"));
      try {
        const filePath = join(outsideDir, "protected.yaml");
        await writeFile(filePath, "$protected: true\nbaseUrl: https://prod.example.com\n", "utf-8");

        const env = await loadEnvironment(dir, undefined, undefined, filePath);

        expect(isProtectedEnvironment(env)).toBe(true);
        expect(env.baseUrl).toBe("https://prod.example.com");
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });
  });
});

describe("isProtectedEnvironment / toTemplateVariables", () => {
  // Environment は environmentSchema(オブジェクト + catchall)の推論型のため、$protected(boolean)を
  // 含むオブジェクトリテラルをそのまま渡すと索引シグネチャ(string)との不整合で型検査に失敗する。
  // 実行時の検証を担う environmentSchema.parse(引数は unknown)経由で Environment 値を作る。
  it("$protected: true の環境を保護対象と判定する", () => {
    const environment = environmentSchema.parse({
      $protected: true,
      baseUrl: "http://localhost:3000",
    });
    expect(isProtectedEnvironment(environment)).toBe(true);
  });

  it("$protected が無い/false の環境は保護対象と判定しない", () => {
    expect(
      isProtectedEnvironment(environmentSchema.parse({ baseUrl: "http://localhost:3000" })),
    ).toBe(false);
    expect(isProtectedEnvironment(environmentSchema.parse({ $protected: false }))).toBe(false);
  });

  it("toTemplateVariables は $protected を変数マップから除外する", () => {
    const environment = environmentSchema.parse({
      $protected: true,
      baseUrl: "http://localhost:3000",
    });
    const variables = toTemplateVariables(environment);
    expect(variables).toEqual({ baseUrl: "http://localhost:3000" });
    expect(Object.hasOwn(variables, "$protected")).toBe(false);
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

  it("$protected: true の既存ファイルに対して values に $protected が無くても削除しない(保護の黙った解除を防ぐ)", async () => {
    await writeFile(
      join(dir, "environments", "protected.yaml"),
      "$protected: true\nbaseUrl: http://localhost:3000\napiKey: old-secret\n",
      "utf-8",
    );

    // UI 編集経路を模し、$protected を含まない values(apiKey は削除、baseUrl は更新)を渡す
    await saveEnvironment(dir, "protected", { baseUrl: "http://localhost:4000" });

    const content = await readFile(join(dir, "environments", "protected.yaml"), "utf-8");
    expect(content).toContain("$protected: true");
    expect(content).toContain("baseUrl: http://localhost:4000");
    expect(content).not.toContain("apiKey");
  });
});
