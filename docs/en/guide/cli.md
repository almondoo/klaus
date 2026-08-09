# CLI Reference

klaus has six commands: `init` (scaffolds a starting point), `run` (executes flows), `validate` (schema-validates flows), `schema` (prints a JSON Schema), `ui` (launches the localhost web UI), and `history` (inspects execution history).

## --help

Both `klaus --help` and `klaus run --help` end with a link to the docs site (this site; the Japanese version is at the site root, not under `/en/`), a note that `klaus init` scaffolds a starting point, and a one-line exit code summary.

## klaus init

```
klaus init
```

Takes no options. Generates a minimal starting point in the current directory.

| Generated file | Contents |
|---|---|
| `flows/example.yaml` | A single GET to `https://example.com` with a status-200 assertion (with English comments) |
| `environments/local.yaml` | A minimal environment file with a `baseUrl` |
| `AGENTS.md` | A guide for AI coding agents, compressing the command set, YAML schema essentials, and the exit code table into about 50 lines |

Existing files are never overwritten — they're skipped, with a message printed to stdout. Any needed directories are created automatically. Always exits 0. If at least one file was generated, a hint for the next command is printed at the end: `klaus run flows/example.yaml -e local`

## klaus run

```
klaus run <files...> [options]
```

Passing multiple files runs them in sequence (glob expansion is left to the shell).

| Option | Description | Default |
|---|---|---|
| `--env <name>` | Overrides the flow definition's `env:` | the flow's `env:` |
| `--json` | Forces JSON output even on a TTY | — |
| `--report junit` | Generates a JUnit XML report | — |
| `--report-file <path>` | Output path for the report | `klaus-report.xml` |
| `--no-history` | Disables writing to the history JSONL | history enabled |

Passing a value other than `junit` to `--report` prints an error to stderr and exits with 1.

## Output Modes

- **Auto-detection**: text if stdout is a TTY, JSON if non-TTY (pipe / agent execution / CI). `--json` forces JSON even on a TTY
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
- On a TTY, output is ANSI-colored (pass=green / fail=red / skip=yellow). No color when non-TTY or with `--json`

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
- **historyRef**: when history recording is enabled (i.e. `--no-history` was not passed), every step (including passed ones) gets a `historyRef: { date, runId, step }`. Fetch the full detail with `klaus history show <runId> --step <step>` (see [klaus history](#klaus-history) / [Execution History](history.md)). `historyRef` is omitted entirely when run with `--no-history`
- For SSE / WebSocket steps, `response.body` is absent; received data instead goes into the `events` (SSE) / `wsMessages` (WS) fields

### JUnit Report

With `--report junit`, an XML file is written to `--report-file` where each flow becomes a `<testsuite>` and each step a `<testcase>`. It can be combined with either the text or JSON stdout output independently. Special characters are XML-escaped.

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

Prints one line per file: `OK` (valid) or `NG` (invalid), followed by the error list for `NG` files. A one-line fix-example hint is attached only for the main error cases (invalid/missing `method`, `request`/`ws` exclusivity or requiredness, `body`/`graphql` exclusivity, an invalid `ws` URL scheme, a missing `url`, an empty `steps`, and duplicate step names).

```
OK   flows/login.yaml
NG   flows/broken.yaml
  - steps.0.request.method: request.method is required unless request.graphql is set
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
          "hint": "example: method: GET"
        }
      ]
    }
  ]
}
```

`errors[].path` is the zod issue path joined with dots (an empty string when the issue can't be located, e.g. a YAML syntax error). `hint` is only present for the main cases (it can be undefined).

Exit code is **0** if every file is valid, and **2** if at least one has a YAML syntax error or schema violation. Unexpected exceptions exit with 1, same as `run`.

## klaus schema

```
klaus schema [-t <target>]
```

| Option | Description | Default |
|---|---|---|
| `-t`, `--target <target>` | The schema to print: `flow` (the flow definition YAML) or `run-report` (the `run --json` output payload) | `flow` |

Prints the JSON Schema (generated from the zod schema, 2-space pretty-printed) to stdout only — nothing is written to disk.

Both schemas are also published as static files: `https://almondoo.github.io/klaus/schema/flow.schema.json` and `https://almondoo.github.io/klaus/schema/run-report.schema.json`, and bundled in the npm package at `node_modules/@almondoo/klaus/dist/schema/*.json`.

The `version` field of the `run --json` payload is a plain literal (currently `2`), independent of the package version. It is bumped only when a change to this schema would break existing consumers (a field is removed, a field's type changes, or its meaning changes) — purely additive changes such as a new optional field do not bump it. Consumers should branch on `version` rather than assume the current shape is permanent.

The `request`/`ws` exclusivity and requiredness, the `body`/`graphql` exclusivity, `method` being required unless `graphql` is set, the `ws.url` scheme constraint, and step name uniqueness are all custom validations expressed via zod's `superRefine` and can't be represented in JSON Schema, so they're instead noted in the `description` of the relevant subschema. Always exits 0.

## klaus ui

```
klaus ui [-p <n>] [--no-open]
```

| Option | Description | Default |
|---|---|---|
| `-p`, `--port <n>` | The port to listen on | automatically selects a free port |
| `--no-open` | Suppresses automatically opening the browser | opens automatically |

On startup, a URL with a token (`http://127.0.0.1:<port>/?token=…`) is printed to stdout and opened in the default browser. Press Ctrl+C to stop it. For the server's features, security model, and HTTP API, see [localhost UI](ui.md).

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
