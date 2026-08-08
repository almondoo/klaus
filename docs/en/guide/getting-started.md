# Getting Started with klaus

> [!summary] What this document covers
> A tutorial for first-time klaus users. It takes the shortest path from installation through creating a flow, running it, and reading the results. For an exhaustive field-by-field reference, see [flow-definition](flow-definition.md).

## Installation

```bash
npm install -g @almondoo/klaus
```

`package.json`'s `engines` field requires Node.js `>=22.19.0` (`bin` points the `klaus` command at `dist/cli.js`).

## Scaffolding with klaus init

After installing, run this in your project directory to generate a minimal starting point:

```bash
klaus init
```

This creates `flows/example.yaml` (a sample flow that issues a single GET to `https://example.com` and asserts a 200 status) and `environments/local.yaml` (a minimal environment file with a `baseUrl`) in the current directory. It takes no options. Existing files are never overwritten — they're skipped instead — and any needed directories are created automatically. Once done, it prints a hint for the next command:

```bash
klaus run flows/example.yaml -e local
```

The sections below walk through writing a flow definition by hand, to explain what's inside this scaffold.

## Creating a Minimal Flow

A klaus flow definition follows a "1 YAML file = 1 flow (a sequence of steps run in order)" structure. Place the YAML file anywhere you like in your project (by convention it's often placed under `api/`, but since `klaus run` takes the file path directly as an argument, it can live anywhere).

```yaml
# api/hello.yaml
name: hello flow
steps:
  - name: get-hello
    request:
      method: GET
      url: "http://localhost:3000/hello"
    assert:
      status: 200
```

## Running It

```bash
klaus run api/hello.yaml
```

If stdout is a TTY (a normal terminal), you get human-readable text output.

```
hello flow (api/hello.yaml)
  PASS get-hello (200, 12ms)

1 flow, 1 step: 1 passed (12ms)
```

- A successful step prints only a single `PASS <name> (<status>, <durationMs>ms)` line
- Details (failed assertion messages, error messages) are shown only for failures (`FAIL`) or runtime errors (`ERROR`)
- A summary line follows at the end, showing the flow count, step count, and the breakdown (passed / failed / error / skipped)

When piped, or when invoked from an agent (such as Claude Code running Bash), stdout is not a TTY, so output automatically switches to JSON (passing `--json` forces the same format regardless). For details on the JSON structure and exit codes, see [cli](cli.md).

## Chaining with Variables (login → me)

A common real-world pattern: log in to obtain a token, then use it in the Authorization header of subsequent requests.

```yaml
# api/auth-flow.yaml
name: auth flow
env: local          # See environments/local.yaml
steps:
  - name: login
    request:
      method: POST
      url: "{{baseUrl}}/login"
      headers:
        Content-Type: application/json
      body:
        email: "{{testEmail}}"
        password: "{{env.TEST_PASSWORD}}"   # References an OS environment variable
    capture:
      token: "$.token"                      # Captured via JSONPath
    assert:
      status: 200
      body:
        - path: "$.token"
          exists: true

  - name: get-me
    request:
      method: GET
      url: "{{baseUrl}}/me"
      headers:
        Authorization: "Bearer {{token}}"   # References the previous step's capture
    assert:
      status: 200
      body:
        - path: "$.email"
          equals: "{{testEmail}}"
```

## Creating an environments/ File

`env: local` resolves `environments/local.yaml` by searching upward starting from klaus's current working directory at run time (the cwd from which `klaus run` was invoked, not the location of the flow file itself). Starting at the cwd, klaus walks up through each parent directory, checking for `environments/local.yaml` directly under it. The search stops (inclusively checking that directory first) at the first ancestor directory containing a `.git` entry, or at the filesystem root — whichever comes first. This means running `klaus run` from a subdirectory of your project still finds the project root's `environments/` (the search never crosses into another repository).

```yaml
# environments/local.yaml
baseUrl: http://localhost:3000
testEmail: test@example.com
```

All environment file values are strings, and can be referenced as template variables (<code v-pre>{{...}}</code>) such as <code v-pre>{{baseUrl}}</code>. Secrets (passwords, etc.) should not be hard-coded into environment files — reference an OS environment variable instead with <code v-pre>{{env.TEST_PASSWORD}}</code> (passed in as, e.g., `TEST_PASSWORD=xxx klaus run ...`).

Behavior when `env:` is not specified, or `environments/<name>.yaml` isn't found in any ancestor directory:

- If the flow definition has no `env:` and `--env` is not passed either, the flow runs with no environment variables (an empty object)
- If a name is given via `env:` or `--env` but the corresponding file can't be found, this is a parse error (exit code 2)

`--env <name>` on the CLI overrides the flow definition's `env:`.

## Reading the Results

- **PASS**: The step succeeded. Only the status code and duration are shown
- **FAIL**: The request itself completed, but one or more assertions didn't match. The failed assertion's message is shown in `expected ... but got ...` form
- **ERROR**: The request could not be completed — connection failure, timeout, template variable resolution failure, JSONPath capture failure, etc.
- **SKIP**: A preceding step in the same flow ended in FAIL or ERROR, so this step was not run and was skipped (`skipped because a previous step failed`)

Full failure details (the complete request and response) are not shown in text output. For the full detail, check the `--json` output or the execution history in `.klaus/history/*.jsonl` (see [history](history.md)).

## Where to Go Next

- [cli](cli.md) — all options for `klaus run` / `klaus ui`, and the exit code scheme
- [flow-definition](flow-definition.md) — the full reference for flow definition YAML fields (including SSE / WebSocket / GraphQL / assertion types)
- [history](history.md) — the execution history JSONL schema
- [ui](ui.md) — the localhost web UI launched by `klaus ui`
