/**
 * ビルド成果物として JSON Schema ファイルを書き出す生成スクリプト。
 * ユーザー向け CLI サブコマンドではなく、ビルド時にのみ使う内部スクリプト
 * (tsup entry: src/cli/schema-gen.ts → dist/schema-gen.js。`node dist/schema-gen.js` として実行する)。
 *
 * 既定では npm パッケージ同梱物として dist/schema/*.json を書き出す。
 * `--docs` を付けると、ドキュメントサイト公開用に docs/public/schema/*.json にも同内容を追加で書き出す
 * (VitePress は docs/public/ 配下をそのままサイトルートの静的ファイルとして配信するため、
 * https://almondoo.github.io/klaus/schema/flow.schema.json で公開される)。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfigJsonSchema, buildFlowJsonSchema, buildRunReportJsonSchema } from "./schema.js";

// このファイルはビルド後 dist/schema-gen.js として実行されるため、
// import.meta.url の1つ上の階層がリポジトリルートになる(dist/ の親)。
const distDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(distDir, "..");

interface SchemaFile {
  filename: string;
  build: () => Record<string, unknown>;
}

const SCHEMA_FILES: readonly SchemaFile[] = [
  { filename: "flow.schema.json", build: buildFlowJsonSchema },
  { filename: "run-report.schema.json", build: buildRunReportJsonSchema },
  { filename: "klaus-config.schema.json", build: buildConfigJsonSchema },
];

/** JSON Schema オブジェクトを整形して1ファイルに書き出す(末尾改行付き) */
async function writeSchemaFile(
  outDir: string,
  filename: string,
  schema: Record<string, unknown>,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, filename), `${JSON.stringify(schema, null, 2)}\n`, "utf-8");
}

async function main(): Promise<void> {
  const includeDocs = process.argv.includes("--docs");

  const distSchemaDir = join(distDir, "schema");
  const docsSchemaDir = join(projectRoot, "docs", "public", "schema");

  for (const { filename, build } of SCHEMA_FILES) {
    const schema = build();
    await writeSchemaFile(distSchemaDir, filename, schema);
    console.log(`wrote ${join(distSchemaDir, filename)}`);
    if (includeDocs) {
      await writeSchemaFile(docsSchemaDir, filename, schema);
      console.log(`wrote ${join(docsSchemaDir, filename)}`);
    }
  }
}

await main();
