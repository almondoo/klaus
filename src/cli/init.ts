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

/**
 * 生成する AGENTS.md の内容。
 * AI コーディングエージェントが docs サイトやソースコードを読まずに klaus を使えるよう、
 * コマンド体系・YAML スキーマ要点・exit code 表を圧縮して1ファイルにまとめたもの。
 * コマンド一覧は将来の追加(validate / history 等)に備え、後から行を足しやすい箇条書きにしてある。
 */
const AGENTS_MD = `# klaus 向け AGENTS ガイド

klaus は YAML でリクエストフローを定義し、実行・アサーション・履歴管理を行う API 検証 CLI です。

## コマンド

- \`klaus run <files...>\`: フロー定義 YAML を実行する
  - \`--env <name>\`: environments/<name>.yaml の値で flow の env を上書きする
  - \`--json\`: TTY 実行時でも JSON 出力を強制する
  - \`--report junit\` / \`--report-file <path>\`: JUnit XML レポートを追加出力する
  - \`--no-history\`: 実行履歴(.klaus/history/*.jsonl)への書き込みを無効化する
- \`klaus validate [files...]\`: 実行なしでフロー YAML のスキーマ検証のみ行う(引数なしで全フローを探索検証。エラーには修正例ヒント付き)
- \`klaus schema\`: フロー YAML の JSON Schema を stdout に出力する(エディタ補完・フロー生成の精度向上に使う)
- \`klaus history\`: 実行履歴を一覧する(\`--flow <name>\` / \`--failed\` / \`--last <n>\` / \`--fields <csv>\`。既定はボディを含まない要約)
- \`klaus history show <runId> [--step <name>]\`: 履歴エントリの全文(マスク済み)を JSON で取得する
- \`klaus init\`: flows/environments/AGENTS.md の最小雛形をカレントディレクトリに生成する(既存ファイルは上書きしない)
- \`klaus ui\`: localhost Web UI(ランナー + ビューア)を起動する
- 上記が現時点の全コマンド。今後コマンドが増える場合はこの下に追記される

非 TTY(パイプ・CI・エージェント実行など)では自動的に JSON 出力になる。結果データは stdout、パースエラー等の診断メッセージは stderr に出る。run の JSON は failure-focused(成功ステップは要約のみ)かつボディは 500 文字で truncate される。全文は各ステップの \`historyRef\`(\`{date, runId, step}\`)を使い \`klaus history show <runId> --step <name>\` で取得する。

## YAML スキーマ要点

- flow: \`name\`(必須)/ \`env\`(任意、--env で上書き可)/ \`steps\`(1件以上、name はフロー内で一意)
- step: \`name\` に加え \`request\` と \`ws\` はどちらか一方が必須(排他)。任意で \`capture\` / \`assert\` / \`sse\`
- request: \`method\`(graphql 指定時のみ省略可、既定 POST)/ \`url\` / \`headers\` / \`query\`(key-value。URL のクエリ文字列へマージされ、同名キーは query 側が優先)/ \`body\`(\`graphql\` と排他)/ \`timeoutMs\`(既定 30000ms)
- capture: レスポンス body に対する JSONPath で変数を取り出す(例: \`{ token: "$.data.token" }\`)
- \`{{var}}\` の解決順: ①ステップの capture 変数 → ②environments の値。\`{{env.X}}\` は OS 環境変数 X を参照する(未定義なら実行時エラー)

## exit code

| code | 意味 |
|---|---|
| 0 | 全件成功 |
| 1 | 一般エラー(不正な CLI 引数・予期しない例外) |
| 2 | 定義ファイルのパースエラー |
| 3 | 実行時エラー(接続不能・タイムアウト・キャプチャ失敗等) |
| 4 | アサーション失敗 |

判定ルール: 実行前に全ファイルをパース検証し、1件でも失敗すれば exit 2(何も実行しない)。実行後、runtime エラー(status "error")を含むフローがあれば exit 3、なければアサーション失敗(status "failed")があれば exit 4、全成功なら exit 0(3 と 4 が混在する場合は 3 を優先)。exit code だけで故障箇所を判別できる: 2 なら定義を直す、3 なら対象 API の起動状態を見る、4 ならアサーション内容とレスポンスを比較する。

## 履歴

実行結果は \`.klaus/history/<YYYY-MM-DD>.jsonl\` に自動追記される(\`--no-history\` で無効化可)。\`{{env.X}}\` 等で参照した値はシークレットとみなされ、履歴には "***" でマスクされて記録される。

## 最小フロー例

\`\`\`yaml
name: example flow
steps:
  - name: get-example
    request:
      method: GET
      url: "https://example.com"
    assert:
      status: 200
\`\`\`

environments/local.yaml に \`baseUrl: https://example.com\` を置けば、上記 url を \`"{{baseUrl}}"\` として参照できる。
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
  { relativePath: "AGENTS.md", content: AGENTS_MD },
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
