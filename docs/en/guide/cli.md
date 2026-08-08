# CLI Reference

klaus has two commands: `run` (executes flows) and `ui` (launches the localhost web UI).

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
認証フロー (/path/to/auth-flow.yaml)
  PASS login (200, 6ms)
  FAIL get-me (200, 3ms)
    body $.email: expected "a@example.com" but got "b@example.com"
  SKIP logout (前ステップの失敗によりスキップ)

1 flow, 3 steps: 1 passed, 1 failed, 1 skipped (12ms)
```

- Line types: `PASS` / `FAIL` (the failed assertion's expected/actual, with the response body truncated to about 500 characters) / `SKIP` (with a reason) / `ERROR` (the runtime error message)
- On a TTY, output is ANSI-colored (pass=green / fail=red / skip=yellow). No color when non-TTY or with `--json`

### JSON Output (for machines)

After execution completes, a single JSON object (pretty-printed with 2-space indentation) is written to stdout. There is no incremental output.

```jsonc
{
  "version": 1,          // schema version of the output
  "runId": "<uuid>",
  "startedAt": "2026-08-08T…",
  "durationMs": 123,
  "status": "passed",    // "passed" | "failed" | "error"
  "flows": [
    {
      "name": "認証フロー",
      "file": "…",
      "status": "passed",
      "durationMs": 120,
      "steps": [
        {
          "name": "login",
          "status": "passed",   // "passed" | "failed" | "skipped" | "error"
          "durationMs": 6,
          "request": { "method": "POST", "url": "…", "headers": {}, "body": {} },
          "response": { "status": 200, "headers": {}, "body": {} },
          "assertions": [ { "ok": true, "kind": "status", "expected": 200, "actual": 200, "message": "…" } ]
        }
      ]
    }
  ]
}
```

For SSE / WebSocket steps, `response.body` is undefined; received data instead goes into the `events` (SSE) / `wsMessages` (WS) fields.

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

## klaus ui

```
klaus ui [-p <n>] [--no-open]
```

| Option | Description | Default |
|---|---|---|
| `-p`, `--port <n>` | The port to listen on | automatically selects a free port |
| `--no-open` | Suppresses automatically opening the browser | opens automatically |

On startup, a URL with a token (`http://127.0.0.1:<port>/?token=…`) is printed to stdout and opened in the default browser. Press Ctrl+C to stop it. For the server's features, security model, and HTTP API, see [localhost UI](ui.md).
