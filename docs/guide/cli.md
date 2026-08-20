# CLI Reference

klaus has seven commands: `run` (executes flows), `ui` (launches the localhost web UI), `validate` (schema-validates flows), `schema` (prints a JSON Schema), `generate` (generates flows from an OpenAPI spec; see [Generating Flows from OpenAPI](./generate.md)), `init` (scaffolds a starting point), and `history` (inspects execution history).

## --help

Both `klaus --help` and `klaus run --help` end with a link to the docs site (this site; the Japanese version is under `/ja/`, not at the site root), a note that `klaus init` scaffolds a starting point, and a one-line exit code summary.

## klaus run

```
klaus run <files...> [options]
```

Passing multiple files runs them in sequence (glob expansion is left to the shell).

| Option | Description | Default |
|---|---|---|
| `--env <name>` | Overrides the flow definition's `env:` (cannot be combined with `--env-file`) | the flow's `env:` |
| `--env-file <path>` | Loads environment variables from an arbitrary YAML file path (relative to cwd or absolute), instead of a named environment under `environments/`. Overrides the flow definition's `env:`. Cannot be combined with `-e`/`--env` | — |
| `--var <key=value>` | Sets an ad-hoc template variable (repeatable; the value may itself contain `=`, only the first `=` is treated as the separator). Lands in the same namespace as environment file values (bare <code v-pre>{{name}}</code>), overriding same-named keys loaded from the environment | — |
| `--json` | Forces JSON output even on a TTY | — |
| `--text` | Forces text output even when not a TTY (cannot be combined with `--json`) | — |
| `--report <list>` | Comma-separated list of report formats to generate: `junit`, `tap` (e.g. `junit,tap`) | — |
| `--report-file <path>` | Output path for the report format(s) given via `--report` (repeatable; see below) | per-format default (see below) |
| `--no-history` | Disables writing to the history JSONL | history enabled |
| `--no-mask` | Disables secret masking in stdout output (JSON/text) | masking enabled |
| `--record <dir>` | Record mode: sends real HTTP requests and saves masked request/response pairs to a cassette in `<dir>` | — |
| `--replay <dir>` | Replay mode: serves HTTP responses from the cassette in `<dir>` instead of the network (unrecorded requests fail with exit code 3). Cannot be combined with `--record` | — |
| `--allow-protected` | Allow running against an environment file marked `$protected: true` (otherwise refused with exit code 3) | — |
| `--data <path>` | Run data-driven: for each row in this JSON/YAML data file, run all given flow files once (see "Data-driven runs" below) | — |
| `--tags <list>` | Comma-separated list of tags; only run flows whose `tags:` includes at least one of them (OR semantics; see "Tag-based flow selection" below) | — |
| `--exclude-tags <list>` | Comma-separated list of tags; drop flows whose `tags:` includes any of them. Takes precedence over `--tags` | — |

`--report` takes a comma-separated list of formats (entries are trimmed; each must be `junit` or `tap`). Passing an unknown or empty format entry prints an error to stderr and exits with 1. With N formats given to `--report`, `--report-file` must be passed either **exactly N times** (in the same order, pairing the 1st `--report-file` with the 1st format and so on) or **not at all** (in which case each format is written to its own default filename: `klaus-report.xml` for `junit`, `klaus-report.tap` for `tap`). Any other count — e.g. one `--report-file` for two formats — is rejected with an error and exits with 1 without writing any file. This generalizes the single-format behavior: `--report junit` alone still defaults to `klaus-report.xml`, unchanged from before. Passing `--json` and `--text` together, or `-e`/`--env` and `--env-file` together, also prints an error to stderr and exits with 1 (nothing is run). This `-e`/`--env` + `--env-file` conflict only fires for an `-e`/`--env` **typed on the command line**; a `run.env` default coming from `klaus.config.yaml` yields to an explicit `--env-file` instead of conflicting with it (see [Default CLI options](config.md)).

`--env-file` honors a `$protected: true` key in the loaded file exactly like a named environment: the run is refused with exit code 3 unless `--allow-protected` is also passed.

`--var` values are **not** registered as secrets and are **not** masked in output, unlike <code v-pre>{{env.X}}</code> (OS environment variable references). If a value is a real secret, pass it through an OS environment variable and reference it as <code v-pre>{{env.X}}</code> instead, so it benefits from the masking described in [Execution History](history.md).

`--env` / `--report` / `--report-file` / `--no-history` / `--no-mask` can have their defaults set via `klaus.config.yaml`. `--var`, `--env-file`, `--data`, `--tags`, and `--exclude-tags` cannot — see [Default CLI options](config.md).

### Tag-based flow selection (`--tags` / `--exclude-tags`)

Flow definitions may declare `tags: [smoke, auth]` at the top level (see [Flow Definition Reference](flow-definition.md#tags)). `--tags` and `--exclude-tags` each take a comma-separated list (entries are trimmed; an empty entry after trimming — e.g. a leading/trailing/doubled comma — is rejected with a non-zero exit and no stack trace).

- **`--tags`**: keeps a flow if it has **at least one** of the given tags (OR semantics). Omitted → no filtering by inclusion (every flow passes this stage)
- **`--exclude-tags`**: drops a flow if it has **any** of the given tags, applied after the `--tags` stage. Omitted → nothing is excluded. When a flow matches both `--tags` and `--exclude-tags`, **exclusion wins**
- **Untagged flows** (no `tags:` field): they match none of `--tags`, so they are dropped whenever `--tags` is given; they match none of `--exclude-tags` either, so they are kept when only `--exclude-tags` is given
- **Filtered-out flows never run**: a flow dropped by tag filtering does not reach the runner at all, so it produces no entry in the JSON/JUnit output and no execution-history row — this is different from a `skipped` step, which is recorded (see [Flow Behavior on Step Failure](flow-definition.md#flow-behavior-on-step-failure))
- **Zero matches is an error**: if filtering leaves no flows to run, `klaus run` prints `no flows match the specified tags` to stderr and exits with **1**, without running anything. This is intentional — a silently-green empty run in CI would hide a typo in a tag name
- **Combined with `--data`**: filtering happens first, before the data-driven row expansion — so the row × flow iteration only covers the flows that survived filtering
- Not settable via `klaus.config.yaml` (see above)

### Data-driven runs (`--data`)

`--data <path>` runs every given flow file once **per row** in a JSON or YAML data file (Newman-style data-driven execution). The data file must be an array of objects; each value must be a scalar (string / number / boolean / null) — nested objects/arrays are rejected, and there is no CSV support (JSON/YAML only, chosen to avoid adding a new dependency; see the schema doc comment in `src/core/data.ts` for the full rationale). An empty array is also rejected.

- **Iteration order**: rows are the outer loop and flows are the inner loop — `flowA(row1)`, `flowB(row1)`, `flowA(row2)`, `flowB(row2)`, ... (iteration-major order, matching Newman's collection-runner semantics)
- **Variable injection**: each row's values land in the same template env namespace as `--var` and the environment file (bare <code v-pre>{{name}}</code>), overriding same-named keys from `--var`, which in turn overrides the environment file. Capture variable resolution is unaffected (captures still resolve before the env namespace, per the existing precedence rule)
- **Value coercion**: `number`/`boolean` row values are stringified with `String(value)` before injection, same as capture values. A key whose value is `null` is **not injected at all** — referencing it in a template then fails with the usual unresolved-variable error (this is intentional, not a bug)
- **Not masked**: like `--var`, row values are not registered as secrets and are not masked in output — use <code v-pre>{{env.X}}</code> (an OS environment variable) for real secrets
- **Aggregation**: all iterations' flow results sit flat in the same run — a failure in any iteration fails the run as a whole (same `aggregateStatus` / exit-code rules as a normal multi-flow run)
- **Reporting**: when `--data` is used, each flow result carries a 1-based `iteration` number. This surfaces as: the `iteration` field on each flow entry in the `--json` output (additive; `version` stays `2`), an `(iteration N)` suffix on the JUnit `<testsuite name="...">` (the `classname` on each `<testcase>` stays the plain flow name), an `(iteration N)` suffix on the text-output flow header, and an `iteration` field on each execution-history JSONL entry (additive; `v` stays `1`)

## Output Modes

- **Auto-detection**: text if stdout is a TTY, JSON if non-TTY (pipe / agent execution / CI). `--json` forces JSON even when non-TTY, and `--text` forces text even when not a TTY (the two cannot be combined)
- **Result data goes to stdout; diagnostic messages (parse errors, warnings) go to stderr** — the two are kept separate

### Text Output (for humans)

Output is streamed incrementally as each step completes. Successes get a single-line summary; details are shown only on failure (full detail remains available in the history JSONL).

```
auth flow (/path/to/auth-flow.yaml)
  PASS login (200, 6ms)
  FAIL get-me (200, 3ms)
    body $.email: expected "a@example.com" but got "b@example.com"
  SKIP logout: skipped because a previous step failed

1 flow, 3 steps: 1 passed, 1 failed, 1 skipped (12ms)
```

- Line types: `PASS` / `FAIL` (the failed assertion's expected/actual, with the response body truncated to about 500 characters) / `SKIP` (with a reason) / `ERROR` (the runtime error message)
- On a TTY, output is ANSI-colored (pass=green / fail=red / skip=yellow). No color with `--json`. The `NO_COLOR` (disable colors) and `FORCE_COLOR` (enable colors even off-TTY; `FORCE_COLOR=0` disables) environment variables are also honored, but making `FORCE_COLOR` take effect off-TTY requires `--text` to force text output in the first place (without it, non-TTY defaults to JSON output, which never reaches the colored text path)
- Control characters found in `FAIL` detail lines and `ERROR` messages (sourced from the response body) are converted to visible escapes (`\n` / `\r` / `\t` / `\xNN`) before being printed. Newlines are included in this so that a response body can't be used to forge a fake `PASS` line or otherwise spoof terminal output

### JSON Output (for machines)

After execution completes, a single compact JSON object (no pretty-printing, one line) is written to stdout. There is no incremental output.
The structure is **failure-focused** to keep the token count low for agents: steps that `passed` collapse to a
one-line summary of just `name` / `status` / `durationMs`, while `failed` / `error` / `skipped` steps carry the
full detail (request/response snapshots, assertions, etc).

```jsonc
{
  "version": 2,            // schema version of the output
  "runId": "<uuid>",
  "startedAt": "2026-08-08T…",
  "durationMs": 123,
  "status": "passed",      // "passed" | "failed" | "error"
  "summary": { "flows": 1, "steps": 2, "passed": 1, "failed": 1, "error": 0, "skipped": 0 },
  "flows": [
    {
      "name": "auth flow",
      "file": "…",
      "status": "failed",
      "durationMs": 120,
      "steps": [
        {
          // passed steps are a one-line summary only (historyRef is only added when history recording is enabled)
          "name": "login",
          "status": "passed",
          "durationMs": 6,
          "historyRef": { "date": "2026-08-08", "runId": "<uuid>", "step": "login" }
        },
        {
          // failed/error/skipped steps carry full detail
          "name": "get-me",
          "status": "failed",
          "durationMs": 4,
          "historyRef": { "date": "2026-08-08", "runId": "<uuid>", "step": "get-me" },
          "startedAt": "2026-08-08T…",
          "request": { "method": "GET", "url": "…", "headers": {}, "body": "…" },
          "response": { "status": 200, "headers": {}, "body": "…" },
          "assertions": [ { "ok": false, "kind": "status", "expected": 200, "actual": 401, "message": "…" } ]
        }
      ]
    }
  ]
}
```

- **Truncation**: the `body` of request/response snapshots in the detail (JSON bodies are stringified first), the `data` of SSE `events`, and the `data` of WS `wsMessages` are all truncated to about 500 characters (same rule as the text output). The full untruncated JSON body is only available from history
- Secrets sourced from <code v-pre>{{env.X}}</code> are masked by default (same rules as the history JSONL and `--report junit`, URL-encoded forms included (encodeURIComponent, form-urlencoded, and the encodeURI form used to approximate WHATWG URL normalization) as well as JSON-escaped forms; see [Execution History](history.md) for details). Pass `--no-mask` to disable masking for this JSON output only (the history JSONL and JUnit file output are always masked)
- Control-character escaping (as done in text output and JUnit reports) is **not** applied here — values are printed as-is
- **historyRef**: when history recording is enabled (i.e. `--no-history` was not passed), every step (including passed ones) gets a `historyRef: { date, runId, step }`. Fetch the full detail with `klaus history show <runId> --step <step>` (see [klaus history](#klaus-history) / [Execution History](history.md)). `historyRef` is omitted entirely when run with `--no-history`
- For SSE / WebSocket steps, `response.body` is absent; received data instead goes into the `events` (SSE) / `wsMessages` (WS) fields

### JUnit Report

With `--report junit`, an XML file is written to `--report-file` where each flow becomes a `<testsuite>` and each step a `<testcase>`. It can be combined with either the text or JSON stdout output independently. Special characters are XML-escaped.

Secrets sourced from <code v-pre>{{env.X}}</code> are masked using the same rules as history (URL-encoded forms included (encodeURIComponent, form-urlencoded, and the encodeURI form used to approximate WHATWG URL normalization) as well as JSON-escaped forms; see [Execution History](history.md) for details). This masking is also applied by default to the stdout text / JSON output (including `--json`). Pass `--no-mask` to disable masking on the stdout side only — the history JSONL and JUnit file output are always masked and are unaffected by `--no-mask`. Control characters sourced from the response body are converted to visible escapes (`\xNN`), except for the tab/LF/CR that XML 1.0 permits. **This control-character escaping applies only to the JUnit report and text output; it is not applied to the JSON output** (including `--json`).

### TAP Report

With `--report tap`, a [TAP version 13](https://testanything.org/) file is written to `--report-file`: a `1..N` plan line (N = total step count across all flows) followed by one `ok`/`not ok` line per step, in execution order, named `<flowName> > <stepName>`. A `skipped` step is reported as `ok` with a `# SKIP <reason>` directive (TAP has no separate "skip" line type). A `failed`/`error` step is reported as `not ok`, followed by one `# ...` diagnostic comment per failed assertion (or the runtime error message for `error` steps). Newlines and `#` in flow/step names or diagnostic messages are escaped so they cannot break the line-oriented TAP format.

Masking follows the same rules as the JUnit report (secrets from <code v-pre>{{env.X}}</code>, masked before control-character sanitization, unaffected by `--no-mask`).

Pass a comma-separated list to `--report` (e.g. `--report junit,tap`) to generate both formats in one run — see the `--report`/`--report-file` pairing rule above.

## Exit code

| code | Meaning |
|---|---|
| 0 | All passed |
| 1 | General error (invalid CLI arguments, unexpected exception) |
| 2 | Definition file parse error |
| 3 | Runtime error (connection failure, timeout, capture failure, etc.) |
| 4 | Assertion failure |

Details of the decision rules:

1. **All files are parse-validated before execution.** If even one has a parse error, nothing is run; the filename and reason are printed to stderr and it exits with 2
2. A parse error in an environment file (`environments/*.yaml`) encountered during execution also results in exit 2
3. After execution: if any flow contains a runtime error (status "error"), exit **3**; otherwise if there's an assertion failure (status "failed"), exit **4**; if everything passed, exit **0**. When both 3 and 4 apply, 3 takes priority
4. A failure to write the history JSONL only produces a warning on stderr — it does not affect step results or the exit code

An agent (such as Claude Code) can identify where things went wrong from the exit code alone: 2 means fix the definition, 3 means check whether the target API is up, and 4 means compare the assertion against the response.

## klaus ui

```
klaus ui [-p <n>] [-H <host>] [--no-open]
```

| Option | Description | Default |
|---|---|---|
| `-p`, `--port <n>` | The port to listen on | `4884` (fixed) |
| `-H`, `--host <host>` | The host to listen on | `127.0.0.1` |
| `--no-open` | Suppresses automatically opening the browser | opens automatically |

On startup, a URL with a token (`http://127.0.0.1:<port>/?token=…`) is printed to stdout and opened in the default browser. Press Ctrl+C to stop it. For the server's features, security model, and HTTP API, see [localhost UI](ui.md).

`--port` / `--host` / `--no-open` can have their defaults set via `klaus.config.yaml`. See [Default CLI options](config.md).

On a shared multi-user host, this token-bearing URL is passed as an argument to the browser-launch command, so it may be readable by other local users via the process list. On such hosts, pass `--no-open` and open the printed URL yourself instead.

### Using it with docker-compose

To use `klaus ui` inside a container, keep the default port (`4884`) so the port mapping can be pinned, and pass `--host 0.0.0.0` so it's reachable from outside the container.

```yaml
services:
  klaus:
    image: your-klaus-image
    command: ["klaus", "ui", "--host", "0.0.0.0", "--no-open"]
    ports:
      - "4884:4884"
```

`--host 0.0.0.0` makes the server reachable from other hosts on the network (the printed URL still shows `127.0.0.1` as an openable address, with a `(listening on 0.0.0.0)` note appended). Anyone who knows the token-bearing URL can access the UI/API, so be careful about handling it: don't expose it to untrusted networks and don't share the URL.

## klaus validate

```
klaus validate [files...] [options]
```

Schema-validates flow definition YAML only — it never executes anything or makes network calls. Environment files (`environments/*.yaml`) are out of scope.

| Option | Description | Default |
|---|---|---|
| `--json` | Forces JSON output even on a TTY | — |

- **With arguments**: validates only the given files
- **Without arguments**: recursively walks the current directory and validates flow candidate YAML files (top-level `steps` key, same discovery rules and excluded directories as `GET /api/flows` used by `klaus ui`)

Output mode follows the same rule as `run` (text on a TTY, JSON on non-TTY or with `--json`; results go to stdout, diagnostics to stderr).

### Text output

Prints one line per file: `OK` (valid) or `NG` (invalid), followed by the error list for `NG` files. A one-line fix-example hint is attached only for the main error cases (invalid/missing `method`, `request`/`ws` exclusivity or requiredness, `body`/`graphql` exclusivity, an invalid `ws` URL scheme, a missing `url`, an empty `steps`, and duplicate step names). When the issue's location can be resolved to a YAML node, `(line N)` is appended to the end of the error location (the column number is not included in text output).

```
OK   flows/login.yaml
NG   flows/broken.yaml
  - steps.0.request.method (line 6): request.method is required unless request.graphql is set
    example: method: GET
```

### JSON output

```jsonc
{
  "version": 1,
  "files": [
    {
      "path": "flows/broken.yaml",
      "valid": false,
      "errors": [
        {
          "path": "steps.0.request.method",
          "message": "request.method is required unless request.graphql is set",
          "hint": "example: method: GET",
          "line": 6,
          "column": 7
        }
      ]
    }
  ]
}
```

`errors[].path` is the zod issue path joined with dots (an empty string when the issue can't be located, e.g. a YAML syntax error). `hint` is only present for the main cases (it can be undefined). `line` / `column` are the 1-based line/column of the YAML node the issue's `path` points to; they're omitted when the node can't be resolved (they can be undefined).

Exit code is **0** if every file is valid, and **2** if at least one has a YAML syntax error or schema violation. Unexpected exceptions exit with 1, same as `run`.

## klaus schema

```
klaus schema [-t <target>]
```

| Option | Description | Default |
|---|---|---|
| `-t`, `--target <target>` | The schema to print: `flow` (the flow definition YAML), `run-report` (the `run --json` output payload), or `config` ([klaus.config.yaml](config.md)) | `flow` |

Prints the JSON Schema (generated from the zod schema, 2-space pretty-printed) to stdout only — nothing is written to disk.

Each schema is also published as a static file: `https://almondoo.github.io/klaus/schema/flow.schema.json`, `https://almondoo.github.io/klaus/schema/run-report.schema.json`, and `https://almondoo.github.io/klaus/schema/klaus-config.schema.json`, and bundled in the npm package at `node_modules/@almondoo/klaus/dist/schema/*.json`.

The `version` field of the `run --json` payload is a plain literal (currently `2`), independent of the package version. It is bumped only when a change to this schema would break existing consumers (a field is removed, a field's type changes, or its meaning changes) — purely additive changes such as a new optional field do not bump it. Consumers should branch on `version` rather than assume the current shape is permanent.

The `request`/`ws` exclusivity and requiredness, the `body`/`graphql` exclusivity, `method` being required unless `graphql` is set, the `ws.url` scheme constraint, and step name uniqueness are all custom validations expressed via zod's `superRefine` and can't be represented in JSON Schema, so they're instead noted in the `description` of the relevant subschema. Always exits 0.

## klaus init

```
klaus init
```

Takes no options. Generates a minimal starting point in the current directory.

| Generated file | Contents |
|---|---|
| `api/example.yaml` | A single GET to `https://example.com` with a status-200 assertion (with English comments) |
| `environments/local.yaml` | A minimal environment file with a `baseUrl` |
| `AGENTS.md` | A guide for AI coding agents, compressing the command set, YAML schema essentials, assert operating guidance, exit code table, and the api/flows directory convention into about 50 lines |

Existing files are never overwritten — they're skipped, with a message printed to stdout. Any needed directories are created automatically. Always exits 0. If at least one file was generated, a hint for the next command is printed at the end: `klaus run api/example.yaml -e local`

`AGENTS.md` also includes notes for agent execution environments: don't launch `klaus ui` casually — run it in the background with explicit timeout management if you do — and OpenAI Codex CLI disables sandbox network access by default, which can make `klaus run`'s HTTP requests fail (set `network_access = true` under `[sandbox_workspace_write]` in `~/.codex/config.toml` to allow them).

## klaus history

Inspect execution history (`.klaus/history/*.jsonl`) from the CLI without starting the browser UI. By default the output is limited to a small set of fields so agents aren't flooded with large response bodies. See [Execution History](history.md) for the file conventions and schema.

### Listing (klaus history)

```
klaus history [options]
```

| Option | Description | Default |
|---|---|---|
| `--flow <name>` | Filter by flow name (exact match) | — |
| `--failed` | Only entries whose status is failed | — |
| `--last <n>` | Number of entries to fetch | 20 |
| `--fields <csv>` | Comma-separated list of fields to output | `startedAt,runId,flow,step,status,durationMs` |
| `--json` | Forces JSON output even on a TTY | — |

Output mode follows the same TTY convention as `klaus run`: a concise text table (one line per entry) when stdout is a TTY, and a compact JSON array when non-TTY (pipe / agent execution) or with `--json`. Passing `request` / `response` / `assertions` etc. to `--fields` lets you opt into the request/response bodies that are excluded by default.

```
$ klaus history --last 5 --fields step,status,durationMs
step     status  durationMs
get-me   failed  3
login    passed  6
```

```
$ klaus history --json --failed
[{"startedAt":"2026-08-08T…","runId":"<uuid>","flow":"auth flow","step":"get-me","status":"failed","durationMs":3}]
```

### Detail view (klaus history show)

```
klaus history show <runId> [--step <name>]
```

Prints every history entry matching the given `runId`, exactly as stored (secrets already masked), as a JSON array (always JSON, regardless of TTY). Pass `--step` to narrow it down to a single step. If nothing matches, an error is printed to stderr and it exits with 1.

```
$ klaus history show 3fa1c2e0-... --step get-me
[{"v":1,"runId":"3fa1c2e0-...","flow":"auth flow","step":"get-me","status":"failed", …}]
```

The intended workflow is to use the `runId` / `step` from `klaus history`'s list output, then drill into the entries that need full detail with this command.
