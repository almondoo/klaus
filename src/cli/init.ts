import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * `klaus init` サブコマンドの実装。
 * カレントディレクトリに flows/environments の最小構成(サンプル1件ずつ)を生成する。
 * 既存ファイルは上書きしない(スキップして stdout に報告するのみ)。
 */

/** 生成するサンプルのフロー定義。src/core/schema.ts の flowSchema / requestSchema を満たす最小形 */
const EXAMPLE_FLOW_YAML = `# klaus のフロー定義ファイル。name と steps(1件以上)を持つ
name: example flow
steps:
  # 1ステップ = 1リクエスト。name はフロー内で一意である必要がある
  - name: get-example
    request:
      method: GET # HTTP メソッド
      url: "https://example.com" # リクエスト先 URL({{変数名}} で environments の値を埋め込める)
    assert:
      status: 200 # レスポンスの HTTP ステータスコードを検証する
`;

/** 生成するサンプルの環境ファイル。src/core/schema.ts の environmentSchema(string -> string)を満たす最小形 */
const LOCAL_ENVIRONMENT_YAML = `# klaus run --env local で参照される環境変数ファイル(値はすべて文字列)
# フロー内では {{baseUrl}} のように参照できる。用途に応じて自由にキーを追加・変更してよい
baseUrl: https://example.com
`;

interface ScaffoldFile {
  /** cwd からの相対パス(表示・書き込み双方に使う) */
  relativePath: string;
  content: string;
}

const EXAMPLE_FLOW_RELATIVE_PATH = join("flows", "example.yaml");

const SCAFFOLD_FILES: ScaffoldFile[] = [
  { relativePath: EXAMPLE_FLOW_RELATIVE_PATH, content: EXAMPLE_FLOW_YAML },
  { relativePath: join("environments", "local.yaml"), content: LOCAL_ENVIRONMENT_YAML },
];

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * init コマンド本体。
 * 既存ファイルは絶対に上書きせず、スキップとして扱う(データ消失防止)。
 * 例外(ディレクトリ作成・書き込み失敗など)はそのまま呼び出し元へ投げる
 * (呼び出し元で exit 1 に変換する契約。run.ts / ui.ts と同様)。
 */
export async function initCommand(cwd: string = process.cwd()): Promise<number> {
  const created: string[] = [];
  const skipped: string[] = [];

  for (const file of SCAFFOLD_FILES) {
    const fullPath = join(cwd, file.relativePath);
    if (await fileExists(fullPath)) {
      skipped.push(file.relativePath);
      continue;
    }
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, file.content, "utf-8");
    created.push(file.relativePath);
  }

  for (const relativePath of created) {
    process.stdout.write(`作成しました: ${relativePath}\n`);
  }
  for (const relativePath of skipped) {
    process.stdout.write(`スキップしました(既に存在します): ${relativePath}\n`);
  }

  if (created.length > 0) {
    process.stdout.write(
      `\n雛形の生成が完了しました。次のコマンドで実行できます:\n  klaus run ${EXAMPLE_FLOW_RELATIVE_PATH} -e local\n`,
    );
  } else {
    process.stdout.write(
      "\n生成対象のファイルはすべて既に存在するため、何も作成しませんでした。\n",
    );
  }

  return 0;
}
