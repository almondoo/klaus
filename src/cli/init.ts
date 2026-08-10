import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileExists } from "./fs-utils.js";

/**
 * `klaus init` サブコマンドの実装。
 * カレントディレクトリに api/environments の最小構成(サンプル1件ずつ)を生成する。
 * サンプルは単発チェック(1 ステップ)のため、api/=単発チェック・flows/=シナリオという
 * ディレクトリ規約(examples/README.md 参照)に合わせて api/ 配下に置く。
 * 既存ファイルは上書きしない(スキップして stdout に報告するのみ)。
 */

/** 生成するサンプルのフロー定義。src/core/schema.ts の flowSchema / requestSchema を満たす最小形 */
const EXAMPLE_FLOW_YAML = `# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json
# klaus flow definition file. Has a name and one or more steps
name: example flow
steps:
  # 1 step = 1 request. name must be unique within the flow
  - name: get-example
    request:
      method: GET # HTTP method
      url: "https://example.com" # request URL ({{varName}} interpolates values from environments)
    assert:
      status: 200 # verify the response HTTP status code
`;

/** 生成するサンプルの環境ファイル。src/core/schema.ts の environmentSchema(string -> string、予約キー $protected 以外)を満たす最小形 */
const LOCAL_ENVIRONMENT_YAML = `# Environment variable file referenced by klaus run --env local (all values are strings)
# Flows can reference these as {{baseUrl}}. Add or change keys freely as needed
baseUrl: https://example.com
`;

/**
 * 生成する AGENTS.md の内容。
 * AI コーディングエージェントが docs サイトやソースコードを読まずに klaus を使えるよう、
 * コマンド体系・YAML スキーマ要点・exit code 表を圧縮して1ファイルにまとめたもの。
 * コマンド一覧は将来の追加(validate / history 等)に備え、後から行を足しやすい箇条書きにしてある。
 */
const AGENTS_MD = `# AGENTS guide for klaus

klaus is an API testing CLI that defines request flows in YAML and runs execution, assertions, and history tracking.

## Commands

- \`klaus run <files...>\`: run flow definition YAML files
  - \`--env <name>\`: overrides the flow's env with the values in environments/<name>.yaml
  - \`--json\`: force JSON output even when running on a TTY
  - \`--report junit\` / \`--report-file <path>\`: also write a JUnit XML report
  - \`--no-history\`: disable writing to the execution history (.klaus/history/*.jsonl)
  - \`--allow-protected\`: required to run against an environment marked \`$protected: true\` (otherwise refused with exit code 3)
- \`klaus validate [files...]\`: schema-validate flow YAML without executing (with no arguments, discovers and validates all flows; errors carry a fix-example hint)
- \`klaus schema\`: print the flow YAML's JSON Schema to stdout (useful for editor completion and improving flow generation accuracy)
- \`klaus history\`: list execution history (\`--flow <name>\` / \`--failed\` / \`--last <n>\` / \`--fields <csv>\`; the default output is a summary without bodies)
- \`klaus history show <runId> [--step <name>]\`: fetch the full (masked) history entries as JSON
- \`klaus init\`: generate a minimal flows/environments/AGENTS.md starting point in the current directory (existing files are never overwritten)
- \`klaus ui\`: launch the localhost Web UI (runner + viewer)
- This is the full command list as of now; future commands will be appended below

Non-TTY output (pipes, CI, agent execution, etc.) is automatically JSON. Result data goes to stdout; diagnostic messages such as parse errors go to stderr. The \`run\` JSON output is failure-focused (passed steps are summarized only) and bodies are truncated to 500 characters. Fetch the full text via each step's \`historyRef\` (\`{date, runId, step}\`) using \`klaus history show <runId> --step <name>\`.

## YAML schema essentials

- flow: \`name\` (required) / \`env\` (optional, overridable with --env) / \`steps\` (one or more, name must be unique within the flow)
- step: alongside \`name\`, exactly one of \`request\` or \`ws\` is required (mutually exclusive). \`capture\` / \`assert\` / \`sse\` are optional
- request: \`method\` (omittable only when \`graphql\` is set, defaults to POST) / \`url\` / \`headers\` / \`query\` (key-value, merged into the URL's query string; \`query\` wins on key collision) / \`body\` (mutually exclusive with \`graphql\`) / \`timeoutMs\` (defaults to 30000ms)
- capture: extract variables from the response body via JSONPath (e.g. \`{ token: "$.data.token" }\`)
- \`{{var}}\` resolution order: (1) the step's capture variables, then (2) values from environments. \`{{env.X}}\` references OS environment variable X (a runtime error if undefined)

## Assert operating guidance

- \`assert\` is optional, but without it a request that sends and gets a response passes (exit 0) even on HTTP 500.
- In an AI verification loop (implement → run → fix → rerun), always write at least \`assert.status\` — exit code 4 only works as a failure signal when an assert exists.
- Recommended two-phase flow: explore without \`assert\` and observe via \`klaus history show\`, then lock in assertions before entering the verification loop.

## Notes for agent environments

- \`klaus ui\` starts a server and then waits forever; agents should not launch it by default. If you do launch it, run it in the background with an explicit timeout.
- OpenAI Codex CLI disables sandbox network access by default, which makes \`klaus run\`'s HTTP requests fail. Set \`network_access = true\` under \`[sandbox_workspace_write]\` in \`~/.codex/config.toml\` to allow them.
- Mark environment files you don't want an agent to run against by default (e.g. production) with \`$protected: true\` in the environment YAML. \`klaus run\` then refuses to run against that environment (exit code 3) unless \`--allow-protected\` is explicitly passed. \`klaus ui\` / the server API never pass this flag, so protected environments are always refused there.

## Exit codes

| code | meaning |
|---|---|
| 0 | all passed |
| 1 | general error (invalid CLI arguments, unexpected exception) |
| 2 | definition file parse error |
| 3 | runtime error (connection failure, timeout, capture failure, etc.) |
| 4 | assertion failure |

Decision rule: all files are parse-validated before execution; if even one fails, exit 2 (nothing is run). After execution, exit 3 if any flow has a runtime error (status "error"), otherwise exit 4 if there's an assertion failure (status "failed"), otherwise exit 0 for all passed (when both 3 and 4 apply, 3 takes priority). The exit code alone identifies where to look: 2 means fix the definition, 3 means check whether the target API is up, and 4 means compare the assertion against the response.

## History

Execution results are automatically appended to \`.klaus/history/<YYYY-MM-DD>.jsonl\` (disable with \`--no-history\`). Values referenced via \`{{env.X}}\` etc. are treated as secrets and recorded in history masked as "***".

## Directory convention

klaus doesn't care where flow YAML files live, but by convention: \`api/\` holds single-step checks of one endpoint, and \`flows/\` holds multi-step scenarios that chain requests via \`capture\`. Place new files accordingly.

## Minimal flow example

\`\`\`yaml
# api/example.yaml
name: example flow
steps:
  - name: get-example
    request:
      method: GET
      url: "https://example.com"
    assert:
      status: 200
\`\`\`

Place \`baseUrl: https://example.com\` in environments/local.yaml, and the url above can be written as \`"{{baseUrl}}"\`.
`;

interface ScaffoldFile {
  /** cwd からの相対パス(表示・書き込み双方に使う) */
  relativePath: string;
  content: string;
}

const EXAMPLE_FLOW_RELATIVE_PATH = join("api", "example.yaml");

const SCAFFOLD_FILES: ScaffoldFile[] = [
  { relativePath: EXAMPLE_FLOW_RELATIVE_PATH, content: EXAMPLE_FLOW_YAML },
  { relativePath: join("environments", "local.yaml"), content: LOCAL_ENVIRONMENT_YAML },
  { relativePath: "AGENTS.md", content: AGENTS_MD },
];

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
    process.stdout.write(`created: ${relativePath}\n`);
  }
  for (const relativePath of skipped) {
    process.stdout.write(`skipped (already exists): ${relativePath}\n`);
  }

  if (created.length > 0) {
    process.stdout.write(
      `\nScaffolding complete. Run it with:\n  klaus run ${EXAMPLE_FLOW_RELATIVE_PATH} -e local\n`,
    );
  } else {
    process.stdout.write("\nAll target files already exist, so nothing was created.\n");
  }

  return 0;
}
