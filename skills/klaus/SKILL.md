---
name: klaus
description: Use when writing, validating, or running klaus flow YAML files (API request/assertion definitions) or inspecting klaus execution history — e.g. adding an API check under api/, building a multi-step scenario under flows/, or debugging a failing klaus run.
---

# klaus

klaus is an API testing CLI that defines request flows in YAML and runs execution, assertions, and history tracking. It has no runtime dependency on this skill; this file only documents how to author and operate it.

## Commands

- `klaus run <files...>`: run flow definition YAML files
  - `--env <name>`: overrides the flow's env with the values in environments/<name>.yaml
  - `--json`: force JSON output even when running on a TTY
  - `--report junit` / `--report-file <path>`: also write a JUnit XML report
  - `--no-history`: disable writing to the execution history (.klaus/history/*.jsonl)
- `klaus validate [files...]`: schema-validate flow YAML without executing (with no arguments, discovers and validates all flows; errors carry a fix-example hint)
- `klaus schema`: print the flow YAML's JSON Schema to stdout (useful for editor completion and improving flow generation accuracy)
- `klaus history`: list execution history (`--flow <name>` / `--failed` / `--last <n>` / `--fields <csv>`; the default output is a summary without bodies)
- `klaus history show <runId> [--step <name>]`: fetch the full (masked) history entries as JSON
- `klaus generate <spec>`: generate flow YAML skeletons from an OpenAPI 3.x spec
- `klaus init`: generate a minimal flows/environments/AGENTS.md starting point in the current directory (existing files are never overwritten)
- `klaus ui`: launch the localhost Web UI (runner + viewer) — starts a server and waits forever; do not launch it as part of a validate/run workflow

Non-TTY output (pipes, CI, agent execution, etc.) is automatically JSON. Result data goes to stdout; diagnostic messages such as parse errors go to stderr. The `run` JSON output is failure-focused (passed steps are summarized only) and bodies are truncated to 500 characters. Fetch the full text via each step's `historyRef` (`{date, runId, step}`) using `klaus history show <runId> --step <name>`.

## Workflow

1. Write or edit a flow YAML file. Start the file with a `$schema` comment so editors can validate as you type:
   `# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json`
2. `klaus validate <file>` — catches schema errors before spending time on a real HTTP call.
3. `klaus run <file>` — executes it. Check the exit code (table below) to decide where to look next.
4. On failure, use `klaus history show <runId> --step <name>` to see the full, unmasked-by-length request/response for the failing step.

## YAML schema essentials

- flow: `name` (required) / `env` (optional, overridable with `--env`) / `steps` (one or more, name must be unique within the flow)
- step: alongside `name`, exactly one of `request` or `ws` is required (mutually exclusive). `capture` / `assert` / `sse` are optional
- request: `method` (omittable only when `graphql` is set, defaults to POST) / `url` / `headers` / `query` (key-value, merged into the URL's query string; `query` wins on key collision) / `body` (mutually exclusive with `graphql`) / `timeoutMs` (defaults to 30000ms)
- capture: extract variables from the response body via JSONPath (e.g. `{ token: "$.data.token" }`)
- `{{var}}` resolution order: (1) the step's capture variables, then (2) values from environments. `{{env.X}}` references OS environment variable X (a runtime error if undefined)

## Assert operating guidance

- `assert` is optional, but without it a request that sends and gets a response passes (exit 0) even on HTTP 500.
- In an AI verification loop (implement → run → fix → rerun), always write at least `assert.status` — exit code 4 only works as a failure signal when an assert exists.
- Recommended two-phase flow: explore without `assert` and observe via `klaus history show`, then lock in assertions before entering the verification loop.

## Exit codes

| code | meaning |
|---|---|
| 0 | all passed |
| 1 | general error (invalid CLI arguments, unexpected exception) |
| 2 | definition file parse error |
| 3 | runtime error (connection failure, timeout, capture failure, etc.) |
| 4 | assertion failure |

Decision rule: all files are parse-validated before execution; if even one fails, exit 2 (nothing is run). After execution, exit 3 if any flow has a runtime error (status "error"), otherwise exit 4 if there's an assertion failure (status "failed"), otherwise exit 0 for all passed (when both 3 and 4 apply, 3 takes priority).

## Directory convention

klaus doesn't care where flow YAML files live, but by convention: `api/` holds single-step checks of one endpoint, and `flows/` holds multi-step scenarios that chain requests via `capture`. Place new files accordingly.

## Minimal flow example

```yaml
# api/example.yaml
# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json
name: example flow
steps:
  - name: get-example
    request:
      method: GET
      url: "{{baseUrl}}"
    assert:
      status: 200
```

Place `baseUrl: https://example.com` in `environments/local.yaml`, then run with `klaus run api/example.yaml --env local`.

## Notes for agent environments

- `klaus ui` starts a server and then waits forever; do not launch it unless the task specifically calls for the web UI, and if launched, run it in the background with an explicit timeout.
- OpenAI Codex CLI disables sandbox network access by default, which makes `klaus run`'s HTTP requests fail. Set `network_access = true` under `[sandbox_workspace_write]` in `~/.codex/config.toml` to allow them.
- Values referenced via `{{env.X}}` etc. are treated as secrets and recorded in history masked as "***"; never print raw secret values yourself.

## Division of labor with Claude Code hooks

- `klaus validate` (static, no network) is a good fit for a PostToolUse hook — it's fast and surfaces failures back to the agent immediately, though like all PostToolUse hooks it cannot prevent the write itself (the tool has already run; only stderr is fed back to the agent).
- `klaus run` performs real HTTP round-trips, so wiring it directly into PostToolUse is discouraged (it can't block, only warns, and would re-run on every edit). Run it from a Stop hook instead, or in CI.
