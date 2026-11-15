---
name: klaus
description: Use when writing, validating, or running klaus flow YAML files (API request/assertion definitions), generating flows from an OpenAPI spec, or inspecting klaus execution history — e.g. adding an API check under api/, building a multi-step scenario under flows/, or debugging a failing klaus run. Also use whenever a task involves calling or verifying an HTTP API in a repo that contains klaus flow files (api/, flows/, environments/, .klaus/), even if the user never mentions klaus by name.
---

# klaus

klaus is an API testing CLI that defines request flows in YAML and runs execution, assertions, and history tracking. It has no runtime dependency on this skill; this file only documents how to author and operate it.

## Commands

- `klaus run <files...>`: run flow definition YAML files
  - `--env <name>`: overrides the flow's env with the values in environments/<name>.yaml (mutually exclusive with `--env-file`)
  - `--env-file <path>`: load env variables from an arbitrary YAML file instead of a named environment (mutually exclusive with `-e/--env`)
  - `--var <key=value>`: set an ad-hoc template variable (repeatable); overrides same-named env values but is NOT masked as a secret — use an OS environment variable with `{{env.X}}` for real secrets
  - `--json`: force JSON output even when running on a TTY
  - `--report <list>` / `--report-file <path>`: comma-separated additional report formats, `junit`, `tap`, `html` (one self-contained file) and/or `github` (Markdown job summary written to `$GITHUB_STEP_SUMMARY`, or `klaus-report.md`, plus `::error` annotations when `GITHUB_ACTIONS=true`) (e.g. `--report junit,tap`); `--report-file` is repeatable, one per format in the same order (defaults: `klaus-report.xml` / `klaus-report.tap` / `klaus-report.html`)
  - `--no-history`: disable writing to the execution history (.klaus/history/*.jsonl)
  - `--no-mask` shows secrets on stdout (history and report files stay masked); without it `Cookie` / `Set-Cookie` header values are always `***` in output. `--actor <name>` names the actor in history
  - `--allow-protected`: lets the run target a `$protected` environment — an operator decision, never something to add to get past a refusal
  - `--data <path>`: data-driven run — a JSON/YAML file of rows; runs every given flow once per row, row values land in the template env namespace, and each result gets a 1-based `iteration` number
  - `--tags <list>` / `--exclude-tags <list>`: comma-separated flow-level tag filters (OR semantics for `--tags`; `--exclude-tags` wins on overlap)
  - `--jobs <n>`: run up to `n` execution units (flow, or flow x data-row when `--data` is set) in parallel, 1-32, default 1; steps within one flow stay sequential; cannot combine with `--record`
  - `--dry-run`: send nothing; print each step's expanded request plus whether the guards would refuse it (`guard.status`: allowed / refused / undetermined); variables that depend on an earlier step's capture stay as `{{name}}` and are listed in `unresolved`; exits 3 if any step would be refused or fails to expand; cannot combine with `--record`/`--replay`/`--report`; use it to check a flow against `guard.allowedHosts` and `$protected` before running
  - `-u, --update-snapshots`: for `assert.snapshot`, rewrite baselines that differ or are missing and remove obsolete entries — the explicit way to accept a changed response, so use it only when the change is intended; it is never read from `klaus.config.yaml` and cannot combine with `--dry-run`/`--replay`/`--ci`
  - `--ci`: for `assert.snapshot`, a missing baseline fails instead of being recorded (also the default when the `CI` environment variable is truthy)
  - `--openapi <path>` (repeatable; default from `run.openapi` in `klaus.config.yaml`): validate every HTTP response against an OpenAPI 3.0/3.1 document (YAML/JSON, local files and local `$ref`s only) and report operation coverage; a violation (status not described, content-type not declared, required header missing, body breaks the schema) fails the step (`kind: "openapi"`, exit 4), and an unreadable document exits 2 before anything runs
  - `--openapi-base-url <url>` (an extra server URL when matching requests), `--openapi-strict` (unmatched requests, undocumented statuses, and unvalidatable responses fail), `--openapi-coverage-min <percent>` (exit 4 when fewer operations were called); all need `--openapi`, and the last two cannot combine with `--dry-run` (which only reports the planned coverage)
  - `--record <dir>`: record real HTTP request/response pairs (masked) to a cassette in `<dir>` while still hitting the network
  - `--replay <dir>`: replay HTTP responses from the cassette in `<dir>` instead of the network, for deterministic offline runs; unrecorded requests fail with exit code 3; mutually exclusive with `--record`
- `klaus req <method> <url>`: send one ad-hoc HTTP request without a flow file — use this instead of `curl` when exploring an API, because it is guarded (`guard.allowedHosts`, `$protected`), secret-masked, and leaves a history entry that `klaus history show` can read
  - `-H, --header <name:value>` / `--query <key=value>` (both repeatable) / `--body <json>` or `--body @<file>` (file must be inside the cwd; input that is not valid JSON is sent as a raw string)
  - `-e, --env <name>` / `--env-file <path>` / `--var <key=value>` / `--timeout <ms>` / `--no-history` / `--no-mask` / `--json` / `--text` / `--actor <name>`; templates (`{{var}}`, `{{env.X}}`) work in the URL, headers, and body
  - Exit 0 whenever a response arrives (any HTTP status; there are no assertions), 3 on a send error or a guard refusal, 2 on invalid input. There is no `--allow-protected`
  - JSON output (non-TTY default) is `{version, status, startedAt, durationMs, request, response, historyRef?, ...}` with bodies truncated to 500 characters; fetch the full text with `klaus history show <historyRef.runId> --step request`
- `klaus validate [files...]`: schema-validate flow YAML without executing (with no arguments, discovers and validates all flows; errors carry a fix-example hint)
- `klaus schema`: print the flow YAML's JSON Schema to stdout (useful for editor completion and improving flow generation accuracy); a project-level `klaus.config.yaml` can set per-project defaults for `run`/`ui` options (schema via `klaus schema --target config`)
- `klaus history`: list execution history (`--flow <name>` / `--failed` (assertion failures only) / `--status <passed|failed|skipped|error,...>` (e.g. `error` for guard refusals; not with `--failed`) / `--last <n>` / `--fields <csv>`; the default output is a summary without bodies)
- `klaus history show <runId> [--step <name>]`: fetch the (masked) history entries as JSON. A snapshot assertion's `candidate` (a full response copy) is left out of `klaus history` and of `show` for a whole run; it is included only with `--step`
- `klaus promote <runId...>`: turn recorded history into a re-runnable flow YAML with assertions inferred from the observed responses (`--assert status|schema|values|all`, default `schema` = status + content-type + `bodySchema`)
  - Writes `api/<name>.yaml` (one step) or `flows/<name>.yaml` (several) and never overwrites an existing file unless `--force`; `-o, --out <path>` (must stay inside the cwd) / `--stdout` change the destination
  - Masked values (`***`) become `{{env.TODO_*}}` placeholders listed in the output — set them as OS environment variables before running; `--base-url-var <name>` replaces every URL origin with `{{name}}` and prints the value for the environment file
  - A distinctive value (UUID, or 8+ characters with a digit) from an earlier JSON response that reappears in a later request becomes a `capture` plus a `{{name}}` reference (`--no-chain` disables it); each inferred link is listed in the output, so check them
  - Skips steps with no response (guard refusals, `error`), skipped steps, and WebSocket steps, and says why; several run IDs are concatenated in order
  - Safety: recorded values containing a literal `{{` are refused (exit 2) unless `--allow-template-literals` (klaus has no escape for `{{`, so such a value, e.g. `{{env.X}}` echoed by a hostile server, would be expanded when the flow runs); values under sensitive keys/headers (`password`, `apiKey`, `authorization`, `cookie`, ...) and token-like values (JWTs, `sk_...`, long random strings) become `{{env.TODO_*}}` placeholders listed in `redacted`; the output always carries a NOTICE to review the file for sensitive data before committing; a symbolic link as the output path is refused
  - Exit 1 on invalid arguments or an unknown run (like `klaus history show`), 2 when the content cannot be promoted safely (existing output file, unsafe output path, template literal, masked key, nothing promotable)
- `klaus diff [<runA> <runB>]`: compare two recorded runs per step (status, HTTP status, response headers, response body as a structural JSON diff or a line diff, and request changes reported separately)
  - Run IDs are exact matches; `latest` / `previous` need `--flow <name>`, and `klaus diff --flow <name>` alone compares the previous run with the latest
  - `--ignore-path <jsonpath>` (repeatable; `$.id`, `$.items[*].createdAt`, `$..updatedAt`) hides volatile fields, `--ignore-header <name>` / `--no-default-ignores` control the header list, `--duration-threshold <ms>` includes duration changes, `--max-differences <n>` / `--max-value-length <n>` bound the output
  - Exit 0 when there are no differences, 4 when there are, 1 for an unknown run or invalid arguments (like `klaus history show`). Secrets are stored as `***`, so a changed secret value is invisible
- `klaus snapshot list [runId]` / `klaus snapshot accept <runId> [--step <name>]`: review the `assert.snapshot` mismatches recorded for a run (default: the latest run with snapshot assertions), and write them as the new baseline from the masked responses stored in history
  - Only files under a `__snapshots__` directory inside the cwd are written (symbolic links are refused); check `git diff` on them afterwards
  - `accept` without `--step` takes every pending snapshot of the run; exit 1 for an unknown run or when nothing is pending, 2 when a snapshot file is corrupt or cannot be written safely
- `klaus mock <dir>`: serve the responses recorded with `klaus run --record <dir>` from a local HTTP server (default `127.0.0.1:4885`, nothing is forwarded to the network; unmatched requests get 404); `--port <n>` / `--cors` / `--delay <ms>` / `--ignore-query` / `--sequence` / `--origin <url>` / `--json`; waits until Ctrl+C like `klaus ui`, so run it in the background; exit 2 for a missing or invalid cassette
- `klaus generate <spec>`: generate flow YAML skeletons from an OpenAPI 3.x spec
- `klaus init`: generate a minimal flows/environments/AGENTS.md starting point in the current directory (existing files are never overwritten)
- `klaus ui`: launch the localhost Web UI (runner + viewer) — starts a server and waits forever; do not launch it as part of a validate/run workflow
- `klaus mcp [--read-only]`: run a stdio Model Context Protocol server that exposes klaus as `klaus_*` tools (list/validate/dry-run/run flows, single requests, history, diff, snapshots, promote); an MCP client starts it with command `klaus` and args `["mcp"]`. It waits on stdin, so do not launch it from a shell yourself

Non-TTY output (pipes, CI, agent execution, etc.) is automatically JSON. Result data goes to stdout; diagnostic messages such as parse errors go to stderr. The `run` JSON output is failure-focused (passed steps are summarized only) and bodies are truncated to 500 characters. Fetch the full text via each step's `historyRef` (`{date, runId, step}`) using `klaus history show <runId> --step <name>`.

## Workflow

1. Write or edit a flow YAML file. Start the file with a `$schema` comment so editors can validate as you type:
   `# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json`
2. `klaus validate <file>` — catches schema errors before spending time on a real HTTP call.
3. `klaus run <file>` — executes it. Check the exit code (table below) to decide where to look next.
4. On failure, use `klaus history show <runId> --step <name>` to see the full (not truncated) request/response for the failing step.
5. If a step is refused by a guardrail (exit 3: `host "X" is not in guard.allowedHosts`, or a `$protected` environment), stop and report it to the user. Check what the flow would do with `klaus run --dry-run`; do not edit `guard.allowedHosts` or the `$protected` marker, pass `--allow-protected`, or switch to `curl` to get past it.

### Explore, lock in, then diff

The whole loop is: `klaus req` (explore) -> `klaus promote` (lock in as a flow) -> `klaus run` (with `assert.snapshot` / `--openapi` where useful) -> `klaus diff` / `klaus snapshot` (review changes).

1. Explore the API with `klaus req` (or a flow without `assert`). Pass secrets as `{{env.X}}` so they are masked in history.
2. `klaus promote <runId...>` (take the run IDs from `historyRef` / `klaus history`) to turn the evidence into a flow, set the `TODO_*` environment variables it lists, then `klaus validate` and `klaus run` the generated file to confirm it passes. Review the inferred assertions, capture links, and the replaced sensitive values before committing the file.
3. For responses that should not change, add `assert.snapshot` (with `ignore` for volatile fields), run once locally to record the baseline, and commit the `__snapshots__` file. A later change then fails with a diff; if the change is intended, accept it with `klaus run -u` or `klaus snapshot accept <runId>` and review the git diff.
4. To check responses against the API's OpenAPI document, add `--openapi <spec>` (no flow change needed). The JSON `openapi` summary lists the `uncovered` operations and the `unmatched` requests (often a base URL that differs from the document's `servers`: pass `--openapi-base-url`); `--openapi-coverage-min` turns low coverage into exit 4. With `--tags` the coverage is `partial`.
5. After changing the API or the flow, run it again and use `klaus diff --flow "<flow name>" --ignore-path '$.id'` (add the other volatile fields) to see exactly what changed; exit 4 means the runs differ.

## YAML schema essentials

- flow: `name` (required) / `env` (optional, overridable with `--env`) / `steps` (one or more, name must be unique within the flow) / `tags` (optional, non-empty strings, matched by `klaus run --tags`/`--exclude-tags`; no step-level tags)
- step: alongside `name`, exactly one of `request` / `ws` / `use` is required (mutually exclusive). `capture` / `assert` / `sse` / `if` / `retry` / `continueOnError` are optional (`use` also excludes `sse`)
- use: path (relative to the flow file) to a single-step flow file whose request/sse/assert are reused as this step's; `name` and `capture` come from this step, and an `assert` written here is merged additively with the referenced step's
- request: `method` (omittable only when `graphql` is set, defaults to POST) / `url` / `headers` / `query` (key-value, merged into the URL's query string; `query` wins on key collision) / `body` / `graphql` / `form` / `multipart` / `bodyFile` (at most one of them) / `auth` (`basic` / `bearer` / `oauth2`, or `none`; the flow-level `http.auth` is the default) / `timeoutMs` (defaults to 30000ms). A top-level `http:` sets `followRedirects` / `maxRedirects` / `cookies` for the flow; proxy and TLS can only be set in `klaus.config.yaml`
- capture: extract variables from the response body via JSONPath — nested fields and array indexes work (e.g. `{ token: "$.data.token", firstId: "$.items[0].id" }`); object forms `{header: X-Id}`, `{cookie: sid}` (needs `http.cookies`), `{regex: "id=(\\d+)", group: 1}` (over the body text) and `{status: true}`. `assert.status` also takes `[200, 201]` or `"2xx"`; header/body matchers add `gt`/`gte`/`lt`/`lte`/`length`/`type`/`oneOf`
- `assert.snapshot`: `true`, or `{ ignore: [JSONPath...], include: [status|headers|body], headers: [names], name }` — compares the masked response with the baseline in `__snapshots__/<flow file>.snap.json` next to the flow file (key: step name, plus ` #<iteration>` with `--data`, plus ` :: <name>`). A changed response fails with a structural diff (`state: "mismatch"`, exit 4); a missing baseline is written on a local run (`state: "written"`) but fails with `state: "missing"` in CI or with `--ci`; it is also not written implicitly when targeting a `$protected` environment or in `--replay`. Put volatile fields (ids, timestamps) in `ignore` so the baseline does not churn. HTTP steps only (SSE/WebSocket steps fail). Baselines are committed files holding response bodies with only declared secrets masked — review them before committing. The `run` JSON output gets a `snapshots` summary (`matched` / `written` / `updated` / `mismatched` / `missing` / `obsolete` / `files`)
- `if`: a condition string gating the step (e.g. `steps.create.status == "passed"`, `captures.userId != "0"`); only `==`/`!=` against a literal, no `{{...}}` rendering; false makes the step `skipped` (no request, no retry); a malformed expression or unknown reference makes it `error`
- `retry`: `{ count: 1-100, intervalMs: 0-600000 (default 1000) }` — retries the whole step while its outcome is `failed`/`error`; `count` is the number of retries *after* the first attempt, so at most `count + 1` executions happen, and only the final attempt is recorded
- `continueOnError: true`: subsequent steps still run after this step ends `failed`/`error` (the step itself, and the flow/run, still report that failure)
- `{{var}}` resolution order: (1) the step's capture variables, then (2) values from environments; at the CLI level, `--var` overrides same-named environment values, and `--data` row values override both. `{{env.X}}` references OS environment variable X (a runtime error if undefined)

## Assert operating guidance

- `assert` is optional, but without it a request that sends and gets a response passes (exit 0) even on HTTP 500.
- In an AI verification loop (implement → run → fix → rerun), always write at least `assert.status` — exit code 4 only works as a failure signal when an assert exists.
- Recommended two-phase flow: explore without `assert` and observe via `klaus history show`, then lock in assertions before entering the verification loop.

## Exit codes

| code | meaning |
|---|---|
| 0 | all passed |
| 1 | general error (invalid CLI arguments, unexpected exception) |
| 2 | definition file parse error (also an unreadable `--openapi` document) |
| 3 | runtime error (connection failure, timeout, capture failure, a step refused by `$protected` or `guard.allowedHosts`, etc.) |
| 4 | assertion failure (also an OpenAPI violation, or coverage below `--openapi-coverage-min`) |

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

- When the klaus MCP tools (`klaus_*`, served by `klaus mcp`) are available in your session, prefer them over shelling out to the CLI. Guardrails apply and MCP has no option to turn them off: output is always masked, `guard.allowedHosts` in `klaus.config.yaml` limits where requests can be sent (a request without `env` is not covered by environment protection, so that list is the control), and a refused request comes back as an error with an `errorCode` such as `guard.allowed-hosts` or `guard.protected`. Never try to get around a refusal; tell the user, who can change `klaus.config.yaml` or run `klaus run --allow-protected` from a terminal themselves.
- `klaus ui` starts a server and then waits forever; do not launch it unless the task specifically calls for the web UI, and if launched, run it in the background with an explicit timeout.
- OpenAI Codex CLI disables sandbox network access by default, which makes `klaus run`'s HTTP requests fail. Set `network_access = true` under `[sandbox_workspace_write]` in `~/.codex/config.toml` to allow them.
- Mark production-like environments with `$protected: true` in the environment YAML; `klaus run` then refuses to execute against them (exit code 3) unless `--allow-protected` is explicitly passed. `$protected: readonly` is milder: GET / HEAD / OPTIONS run, every other method (and WebSocket) is refused without the flag.
- `guard.allowedHosts` in `klaus.config.yaml` restricts the hosts requests may be sent to (a refusal is exit code 3: `host "X" is not in guard.allowedHosts`). There is no CLI flag to bypass it; do not edit the list or pass `--allow-protected` just to get past a refusal, ask the user instead.
- When exploring an API, send requests with `klaus req` rather than `curl`/`wget`: those bypass `guard.allowedHosts`, `$protected`, secret masking, and the history. Pass secrets as `{{env.X}}` (for example `-H "Authorization: Bearer {{env.TOKEN}}"`), never as literals, so they are masked.
- `klaus ui` cannot write protected environments (403) and a refused run there tells you to use `klaus run --allow-protected` yourself; history entries record `env` / `file` / `actor` / `git`, and `klaus run --actor <name>` / `klaus req --actor <name>` names the actor.
- Only values referenced via `{{env.X}}` are treated as secrets and masked as "***" in history; captured values and `--env-file` values are recorded unmasked (see SECURITY.md) — never print raw secret values yourself regardless.

## Division of labor with Claude Code hooks

- `klaus validate` (static, no network) is a good fit for a PostToolUse hook — it's fast and surfaces failures back to the agent immediately, though like all PostToolUse hooks it cannot prevent the write itself (the tool has already run; only stderr is fed back to the agent).
- `klaus run` performs real HTTP round-trips, so wiring it directly into PostToolUse is discouraged (it can't block, only warns, and would re-run on every edit). Run it from a Stop hook instead, or in CI.
