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
 * tests/cli/agent-docs.test.ts のドリフト検知テストから参照するため export している。
 */
export const AGENTS_MD = `# AGENTS guide for klaus

klaus is an API testing CLI that defines request flows in YAML and runs execution, assertions, and history tracking.

## Commands

- \`klaus run <files...>\`: run flow definition YAML files
  - \`--env <name>\`: overrides the flow's env with the values in environments/<name>.yaml
  - \`--json\`: force JSON output even when running on a TTY
  - \`--report <list>\` / \`--report-file <path>\`: also write additional report formats, \`junit\`, \`tap\`, \`html\`, and/or \`github\` (comma-separated)
  - \`--no-history\`: disable writing to the execution history (.klaus/history/*.jsonl)
  - \`--allow-protected\`: required to run against an environment marked \`$protected: true\`, and to send anything other than GET/HEAD/OPTIONS to one marked \`$protected: readonly\` (otherwise refused with exit code 3)
  - \`--dry-run\`: send nothing; print each step's expanded request plus whether the guards would refuse it (variables that depend on an earlier capture stay as \`{{name}}\`; exits 3 if any step would be refused); cannot combine with \`--record\`/\`--replay\`/\`--report\`
  - \`-u, --update-snapshots\` / \`--ci\`: for \`assert.snapshot\` (below). \`-u\` rewrites baselines that differ or are missing and removes obsolete ones; it is the explicit way to accept a changed response, so only use it when the change is intended. \`--ci\` (or a truthy \`CI\` environment variable) makes a missing baseline a failure instead of recording it. \`-u\` cannot be set in \`klaus.config.yaml\` and cannot combine with \`--dry-run\`/\`--replay\`/\`--ci\`
  - \`--openapi <path>\` (repeatable; \`run.openapi\` in \`klaus.config.yaml\` sets the default): validate every HTTP response against an OpenAPI 3.0/3.1 document (local files only) and report which operations were called. A violation fails the step (exit 4), an unreadable document exits 2. \`--openapi-base-url <url>\` adds a server URL for matching requests, \`--openapi-strict\` fails unmatched requests and undocumented statuses, \`--openapi-coverage-min <percent>\` fails the run (exit 4) when fewer operations were called (the last two cannot combine with \`--dry-run\`)
  - \`--record <dir>\` / \`--replay <dir>\`: record real HTTP request/response pairs to a cassette in \`<dir>\`, or replay them offline instead of hitting the network (mutually exclusive; \`--record\` cannot combine with \`--jobs\` > 1)
- \`klaus req <method> <url>\`: send one ad-hoc HTTP request without a flow file; use this instead of \`curl\` when exploring an API, because it is guarded (\`guard.allowedHosts\`, \`$protected\`), secret-masked, and leaves a history entry that \`klaus history show\` can read
  - \`-H, --header <name:value>\` / \`--query <key=value>\` (both repeatable) / \`--body <json>\` or \`--body @<file>\` (the file must be inside the cwd; input that is not valid JSON is sent as a raw string)
  - \`-e, --env <name>\` / \`--env-file <path>\` / \`--var <key=value>\` / \`--timeout <ms>\` / \`--no-history\` / \`--no-mask\` / \`--json\` / \`--text\` / \`--actor <name>\`
  - Exit 0 whenever a response arrives (any HTTP status; there are no assertions), 3 on a send error or a guard refusal, 2 on invalid input. There is no \`--allow-protected\`
- \`klaus validate [files...]\`: schema-validate flow YAML without executing (with no arguments, discovers and validates all flows; errors carry a fix-example hint)
- \`klaus schema\`: print the flow YAML's JSON Schema to stdout (useful for editor completion and improving flow generation accuracy)
- \`klaus history\`: list execution history (\`--flow <name>\` / \`--failed\` (assertion failures only) / \`--status <passed|failed|skipped|error,...>\` (e.g. \`error\` for guard refusals; not with \`--failed\`) / \`--last <n>\` / \`--fields <csv>\`; the default output is a summary without bodies)
- \`klaus history show <runId> [--step <name>]\`: fetch the (masked) history entries as JSON (a snapshot assertion's \`candidate\` response copy is included only with \`--step\`)
- \`klaus promote <runId...>\`: turn recorded history into a re-runnable flow YAML with inferred assertions (\`--assert status|schema|values|all\`; never overwrites an existing file without \`--force\`); masked values become \`{{env.TODO_*}}\` placeholders to set before running
- \`klaus diff [<runA> <runB>]\`: compare two recorded runs per step (\`latest\` / \`previous\` need \`--flow <name>\`; \`--ignore-path <jsonpath>\` hides volatile fields); exit 0 when identical, 4 when they differ, 2 for an unknown run
- \`klaus snapshot list [runId]\` / \`klaus snapshot accept <runId> [--step <name>]\`: review the \`assert.snapshot\` mismatches recorded for a run, and write them as the new baseline from the masked responses in history (only \`__snapshots__\` files are written; review the git diff afterwards). \`accept\` exits 1 when there is nothing pending
- \`klaus mock <dir>\`: serve the responses recorded with \`klaus run --record <dir>\` from a local HTTP server (default port 4885; unmatched requests get 404); waits until stopped, so run it in the background; exit 2 for a missing or invalid cassette
- \`klaus generate <spec>\`: generate flow YAML skeletons from an OpenAPI spec (\`--out-dir <dir>\`, default \`api\`; \`--json\`)
- \`klaus init\`: generate a minimal flows/environments/AGENTS.md starting point in the current directory (existing files are never overwritten)
- \`klaus ui\`: launch the localhost Web UI (runner + viewer)
- \`klaus mcp [--read-only]\`: run a stdio Model Context Protocol server that exposes klaus as \`klaus_*\` tools; an MCP client starts it with command \`klaus\` and args \`["mcp"]\`. It waits on stdin, so do not launch it from a shell yourself
- This covers the main workflow; run \`klaus --help\` for the full command/flag surface

Non-TTY output (pipes, CI, agent execution, etc.) is automatically JSON. Result data goes to stdout; diagnostic messages such as parse errors go to stderr. The \`run\` JSON output is failure-focused (passed steps are summarized only) and bodies are truncated to 500 characters. Fetch the full text via each step's \`historyRef\` (\`{date, runId, step}\`) using \`klaus history show <runId> --step <name>\`.

## YAML schema essentials

- flow: \`name\` (required) / \`env\` (optional, overridable with --env) / \`steps\` (one or more, name must be unique within the flow)
- step: alongside \`name\`, exactly one of \`request\`, \`ws\`, or \`use\` is required (mutually exclusive). \`capture\` / \`assert\` / \`sse\` / \`if\` / \`retry\` / \`continueOnError\` are optional
- request: \`method\` (omittable only when \`graphql\` is set, defaults to POST) / \`url\` / \`headers\` / \`query\` (key-value, merged into the URL's query string; \`query\` wins on key collision) / \`body\`, \`graphql\`, \`form\`, \`multipart\`, \`bodyFile\` (at most one of them) / \`auth\` (\`basic\` / \`bearer\` / \`oauth2\`) / \`timeoutMs\` (defaults to 30000ms). A top-level \`http:\` sets \`followRedirects\` / \`cookies\`; proxy and TLS live only in \`klaus.config.yaml\`
- capture: extract variables from the response body via JSONPath (e.g. \`{ token: "$.data.token" }\`)
- \`assert.snapshot\` (\`true\` or \`{ ignore, include, headers, name }\`): compare the masked response with a baseline stored in \`__snapshots__/<flow file>.snap.json\` next to the flow file. A changed response fails the step with a structural diff (exit 4); a missing baseline is recorded on the first local run but fails in CI. List volatile fields (ids, timestamps) in \`ignore\` (JSONPath such as \`$.items[*].id\`) so the baseline does not churn. Baselines are committed files: they hold response bodies with only declared secrets masked, so review them before committing
- \`{{var}}\` resolution order: (1) the step's capture variables, then (2) values from environments. \`{{env.X}}\` references OS environment variable X (a runtime error if undefined)

## Recommended workflow

1. Explore with \`klaus req\` (secrets as \`{{env.X}}\`), then \`klaus promote <runId...>\` to turn the recorded evidence into a flow; review its inferred assertions and \`TODO_*\` placeholders.
2. \`klaus validate\`, then \`klaus run\` it. Add \`assert.snapshot\` for responses that must not change and \`--openapi <spec>\` to check responses against the API's OpenAPI document.
3. After a change, run again and review with \`klaus diff --flow <name>\` / \`klaus snapshot list\`; accept a snapshot change only when it is intended.
4. A refusal by \`guard.allowedHosts\` or \`$protected\` (exit 3) is a decision for the user: do not edit the guard settings or the \`$protected\` marker, pass \`--allow-protected\`, or fall back to \`curl\` to get past it. Use \`klaus run --dry-run\` to check beforehand.

## Assert operating guidance

- \`assert\` is optional, but without it a request that sends and gets a response passes (exit 0) even on HTTP 500.
- In an AI verification loop (implement → run → fix → rerun), always write at least \`assert.status\` — exit code 4 only works as a failure signal when an assert exists.
- Recommended two-phase flow: explore without \`assert\` and observe via \`klaus history show\`, then lock in assertions before entering the verification loop.

## Notes for agent environments

- When the klaus MCP tools (\`klaus_*\`, served by \`klaus mcp\`) are available in your session, prefer them over shelling out to the CLI. Guardrails apply and MCP has no option to turn them off: output is always masked, \`guard.allowedHosts\` in \`klaus.config.yaml\` limits where requests can be sent (a request without \`env\` is not covered by environment protection, so that list is the control), and a refused request comes back as an error with an \`errorCode\` such as \`guard.allowed-hosts\` or \`guard.protected\`. Never try to get around a refusal; tell the user, who can change \`klaus.config.yaml\` or run \`klaus run --allow-protected\` from a terminal themselves.
- When exploring an API, send requests with \`klaus req\` rather than \`curl\`/\`wget\`: those bypass \`guard.allowedHosts\`, \`$protected\`, secret masking, and the history. Pass secrets as \`{{env.X}}\` (for example \`-H "Authorization: Bearer {{env.TOKEN}}"\`), never as literals, so they are masked.
- \`klaus ui\` starts a server and then waits forever; agents should not launch it by default. If you do launch it, run it in the background with an explicit timeout.
- OpenAI Codex CLI disables sandbox network access by default, which makes \`klaus run\`'s HTTP requests fail. Set \`network_access = true\` under \`[sandbox_workspace_write]\` in \`~/.codex/config.toml\` to allow them.
- Mark environment files you don't want an agent to run against by default (e.g. production) with \`$protected\` in the environment YAML. With \`$protected: true\`, \`klaus run\` refuses to run against that environment at all (exit code 3) unless \`--allow-protected\` is explicitly passed. With \`$protected: readonly\`, GET/HEAD/OPTIONS are allowed without the flag, while other methods and WebSocket steps are refused (exit code 3); a GET carrying a method-override header (\`X-HTTP-Method-Override\` etc.) is refused too. \`klaus ui\` / the server API never pass \`--allow-protected\`: single requests are allowed only for safe methods on \`readonly\` environments (and refused on \`true\`), and saving to a protected environment from the UI returns 403.
- \`guard.allowedHosts\` in \`klaus.config.yaml\` restricts which hosts requests may be sent to (applies to \`klaus run\` and \`klaus ui\`). A request to any other host is refused with exit code 3 and the message \`host "X" is not in guard.allowedHosts\`. There is no CLI flag to bypass it. Do not widen the list yourself to get past a refusal; ask the user.

## Exit codes

| code | meaning |
|---|---|
| 0 | all passed |
| 1 | general error (invalid CLI arguments, unexpected exception) |
| 2 | definition file parse error (also an unreadable \`--openapi\` document) |
| 3 | runtime error (connection failure, timeout, capture failure, a step refused by \`$protected\` or \`guard.allowedHosts\`, etc.) |
| 4 | assertion failure |

Decision rule: all files are parse-validated before execution; if even one fails, exit 2 (nothing is run). After execution, exit 3 if any flow has a runtime error (status "error"), otherwise exit 4 if there's an assertion failure (status "failed"), otherwise exit 0 for all passed (when both 3 and 4 apply, 3 takes priority). With \`--openapi\`, a response that violates the document is an assertion failure (4) and an unreadable document is a definition error (2). The exit code alone identifies where to look: 2 means fix the definition, 3 means check whether the target API is up, and 4 means compare the assertion against the response.

## History

Execution results are automatically appended to \`.klaus/history/<YYYY-MM-DD>.jsonl\` (disable with \`--no-history\`). Only values referenced via \`{{env.X}}\` are treated as secrets and masked as "***" in history; captured values and \`--env-file\` values are recorded unmasked (see SECURITY.md).

## Directory convention

klaus doesn't care where flow YAML files live, but by convention: \`api/\` holds single-step checks of one endpoint, and \`flows/\` holds multi-step scenarios that chain requests via \`capture\`. Place new files accordingly.

## Minimal flow example

\`\`\`yaml
# api/example.yaml
# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json
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

/**
 * .klaus/ 配下(history/cassette 等の実行時生成物)を丸ごと無視する cargo 方式の自己完結 .gitignore。
 * 利用者自身の .gitignore に触れずとも、生成物が誤ってコミットされないようにする。
 */
const KLAUS_DIR_GITIGNORE = `*\n`;

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
  { relativePath: join(".klaus", ".gitignore"), content: KLAUS_DIR_GITIGNORE },
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
