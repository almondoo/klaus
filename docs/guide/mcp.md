# MCP server for AI agents (klaus mcp)

`klaus mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server on stdin/stdout, so an AI agent can explore and test an API through klaus's own guardrails instead of `curl`. The agent calls tools such as `klaus_request` and `klaus_run_flow`; every send goes through the same host allowlist, environment protection, secret masking, and history as the CLI, and the server has no option to turn any of them off. What each guard does and does not cover is spelled out in [What the guards cover](#what-the-guards-cover); read it before pointing an agent at a real API.

## What it is

- **stdio only.** The client starts `klaus mcp` as a child process and speaks MCP over its stdin/stdout. There is no network listener. It exits with code 0 when stdin closes or on SIGINT / SIGTERM. At that point calls that are still waiting in the queue are not started; a request that is already in flight is not aborted, and the process exits after at most 3 seconds. A request that was in flight when the client disconnected may therefore have reached the server without leaving a history entry.
- **The working directory is the project.** Flows, environments, history, and `klaus.config.yaml` are all resolved from the directory the server was started in. Run it from the project directory.
- **Configuration is read on every call.** `guard`, `http`, and `run.openapi` in `klaus.config.yaml` take effect on the next tool call without a restart. An invalid file makes the sending tools fail instead of sending without the guard. Other `run` defaults (`env`, `history`, `mask`, ...) are not applied: history and masking are always on, and `env` is passed per call.
- **Diagnostics go to stderr.** stdout carries protocol messages only.

## Registering it in an MCP client

### Generic configuration

Most MCP clients take a command and its arguments. With klaus installed (`klaus` on the `PATH`):

```json
{
  "mcpServers": {
    "klaus": {
      "command": "klaus",
      "args": ["mcp"]
    }
  }
}
```

Without a global install, let `npx` fetch it. `-y` skips the confirmation prompt, which would otherwise block the client:

```json
{
  "mcpServers": {
    "klaus": {
      "command": "npx",
      "args": ["-y", "@almondoo/klaus", "mcp"]
    }
  }
}
```

Add `"--read-only"` to `args` to leave out the tools that write files (see [Read-only mode](#read-only-mode)). The exact file name and top-level key differ between clients; check your client's documentation.

### Claude Code

Run this in the project directory:

```bash
claude mcp add klaus -- klaus mcp
# or, without a global install
claude mcp add klaus -- npx -y @almondoo/klaus mcp
```

Everything after `--` is the server command. `-s user` or `-s project` chooses where the entry is stored (the default scope is `local`). Make sure the server runs in the project directory (see [Troubleshooting](#troubleshooting)).

## Tools

All tool names start with `klaus_`. Inputs are JSON objects described by each tool's input schema; paths are relative to the project directory.

| Tool | What it does | Effects |
|---|---|---|
| `klaus_list_flows` | Lists flow files with name and step count (invalid ones with their error) | Read-only |
| `klaus_validate_flow` | Schema-validates one flow file; returns `valid` and the errors | Read-only |
| `klaus_list_environments` | Lists environments and their protection (`none`, `protected`, `readonly`; `unknown` if unreadable). Returns names and protection only | Read-only |
| `klaus_dry_run` | Shows each step's expanded request and the guard decision, including `errorCode`. Optional `env` and `variables`. Values of protected environments are shown as `***`, those of unprotected environments expanded (see [What the guards cover](#what-the-guards-cover)) | Read-only; sends nothing, writes no history |
| `klaus_run_flow` | Runs a flow; returns a summary per step (HTTP status, error, `errorCode`, failed assertions, snapshot and OpenAPI results). Optional `env` and `variables` | Sends requests; writes history and missing snapshot baselines |
| `klaus_request` | Sends one ad-hoc request (`method`, `url`, `headers`, `query`, `body`, `env`); returns the status, headers, and body (masked) | Sends a request; writes history |
| `klaus_history_list` | Recent steps as summary rows (`flow`, `limit` up to 100, `statuses` filters); no bodies | Read-only |
| `klaus_history_show` | The recorded entries of one run; `step` narrows to one step; with `step`, `path` returns only the matched values and `offset` / `length` read a long string in windows (see [Reading large values](#reading-large-values)) | Read-only |
| `klaus_diff_runs` | Compares two runs (`a` / `b` are run IDs, `latest`, or `previous`); `ignorePaths`, `ignoreHeaders` | Read-only |
| `klaus_snapshot_list` | The snapshot assertions of a run that wait for approval | Read-only |
| `klaus_promote` | Writes a **new** flow file from recorded runs (`runIds`, `out`, optional `name`); returns the path, the `TODO_*` placeholders to fill in, and the validation result | Writes one new file; never overwrites. Not available with `--read-only` |
| `klaus_snapshot_accept` | Accepts one pending snapshot (`runId`, `snapshotFile`, `key`) as the new baseline | Replaces a baseline. Not available with `--read-only` |

`klaus_run_flow` returns summaries, not response bodies. To see a body, call `klaus_history_show` with the `runId` and the `step` (each recorded step carries a `historyRef` of `{ runId, step }` for this). Snapshot candidates (full response copies) are included by `klaus_history_show` only when `step` is given, as in `klaus history show`.

What a run records in history: steps that end `passed`, `failed` (assertions, snapshot, or OpenAPI validation), or `skipped`, steps refused by a guard, and steps that received a response and then ended in `error` (a failed capture, for example; the entry has `status: "error"`, the request, the response, and the error message) are recorded. A step that ends with an error before or without a usable response is not recorded: a timeout, a connection error or a network error in the middle of the body, a response that is too large, a template that cannot be expanded. Only recorded steps carry a `historyRef`; looking up a step without one finds nothing. The same applies to `klaus run --json`, which emits `historyRef` only for steps that were actually recorded.

A JSON response body nested deeper than 200 levels is kept as text instead of being parsed (`klaus req --body` and cassette replay follow the same rule, and a `path` assertion on an SSE event or WebSocket message whose JSON is that deep does not match). Because a JSONPath applied to a string would match characters (`$[0]` is the first character), a JSONPath capture, a `body` path assertion, or a `bodySchema` on such a response fails with an explicit message instead (`response body is nested deeper than 200 levels and is kept as text; JSONPath and schema checks cannot be applied`); a capture failure makes the step `error`. Checks on the whole text (`bodyText`, a `regex` capture) still work, and the recorded response carries `bodyTooDeep: true` so a reader can tell the text is a deep JSON. `klaus_request` refuses an object or array `body` that is nested deeper than 200 levels; send it as a string and set `Content-Type` in `headers`.

The tools carry the standard MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). The request-sending tools are marked destructive and open-world, because a flow or request can change data on the target API; `klaus_promote` is not destructive (it never overwrites), and `klaus_snapshot_accept` is. Clients may use them to ask for confirmation.

Tools that send requests or write files run one at a time, in the order they were called, so concurrent calls never write the history or a snapshot file at the same time.

## Guardrails

### What the guards cover

Every send uses the guards from `klaus.config.yaml` only (`guard.allowedHosts`) plus the protection of the environment (`$protected`). `klaus mcp` has no `--allow-protected`, no `--no-mask`, and no option or tool argument that passes guard settings, so a refusal cannot be overridden through MCP. A refusal comes back with an `errorCode` (`guard.allowed-hosts`, `guard.protected`, `guard.readonly`, `guard.method-override`, ...), and the message for a protected environment says that `klaus mcp` cannot override it and that the user must run `klaus run --allow-protected` from a terminal. The refusal is recorded in history like any other.

What the guards do not do matters as much:

- **`$protected` gates runs that select that environment.** It is tied to the environment name, not to hosts. `klaus_run_flow`, `klaus_dry_run`, and `klaus_request` apply it only when the run (or the `env` argument) selects the protected environment. `klaus_request` without `env` loads no environment and is not covered by any protection.
- **`guard.allowedHosts` is the control that limits where an agent can send.** `klaus_request` without `env` can reach every host that `guard.allowedHosts` permits, and every host when it is not set.
- **Protected environments are not revealed, unprotected ones are.** When a tool call loads an environment whose protection is `true` or `readonly`, every variable value of that file is registered as a secret for that call. It shows as `***` in `klaus_dry_run` output (the expanded URL with its host, headers, query, and body, also when the step is refused; the guard decision and `errorCode` stay), in `klaus_run_flow` and `klaus_request` results, in error and refusal messages and hints, and in the history entries those calls write. `klaus_history_show`, `klaus_history_list`, `klaus_diff_runs`, and `klaus_snapshot_list` mask the current values of every protected environment in entries recorded earlier (for example by the CLI or the UI), and `klaus_promote` refuses a run recorded against a protected environment (it masks those values in any other run before promoting). The CLI and the UI are unchanged; this is specific to `klaus mcp`. Values of an unprotected environment are not hidden: `klaus_dry_run` shows them expanded.
- **What an agent can still learn about a protected environment:** its name and protection mode (`klaus_list_environments`), its variable names (in template errors such as `available: env: ...`, and as the schema path when `klaus_validate_flow` is pointed at an environment file; values are never echoed), that a request was refused and why (`errorCode`), and any value shorter than 4 characters, which is never masked because masking it would break the text. The body of a response to an allowed request (a `readonly` environment's GET) is returned with only that environment's own values masked.
- **Any OS environment variable of the `klaus mcp` process can be referenced** with <code v-pre>{{env.NAME}}</code> in a request or flow and sent to a host that is allowed. The value is masked in results and history, not withheld from the destination.

How a refusal is reported depends on the tool:

- `klaus_run_flow` and `klaus_dry_run` return a normal result in which the step has `status: "error"` and its `errorCode` (or `guard.status: "refused"` for a dry run). A run whose steps failed assertions or were refused is not a tool error; the agent needs the details.
- `klaus_request` sends a single request, so a refusal or a send failure is a tool error (`isError: true`) with `error`, `errorCode`, and a `hint`. HTTP error statuses such as 404 are normal results.

### Recommended setup

- Set `guard.allowedHosts` in `klaus.config.yaml` whenever you use `klaus mcp`. It is the only control that limits where an agent can send requests.
- Mark environments that hold production values `$protected`: their values are then hidden from the agent. Do not rely on `$protected` to keep an agent away from an API it can reach with `klaus_request`, and keep production credentials out of unprotected environment files in the agent's project directory.
- Use `--read-only` when you do not want the agent to write files.

### Output is always masked

Values resolved from OS environment variables (<code v-pre>{{env.NAME}}</code>) and `Cookie` / `Set-Cookie` header values are replaced with `***` in every tool result and in history, as in the default output of `klaus run`. Values passed as `variables`, and values that come from environment files or captures, are not registered as secrets: put real secrets in OS environment variables and reference them with <code v-pre>{{env.NAME}}</code>.

### Writing tools

`klaus_promote` and `klaus_snapshot_accept` follow the stricter rules of the [localhost UI](./ui.md), not those of the CLI:

- `klaus_promote` writes only a new file, in `api/`, `flows/`, or a directory that already contains flow files, ending in `.yaml` or `.yml`. Backslashes, hidden directories, `klaus.config.yaml`, and paths outside the project are refused, an existing file is never overwritten, and a recorded value that contains a literal <code v-pre>{{</code> is refused. Secrets and token-like values become <code v-pre>{{env.TODO_*}}</code> placeholders that the user fills in.
- `klaus_snapshot_accept` accepts only a (`snapshotFile`, `key`) pair that is pending for that run, refuses runs against a protected environment (use `klaus snapshot accept` in a terminal), and refuses a step whose other assertions failed. It changes a baseline a person may rely on, so an agent should ask the user first.
- Flow paths for the other tools must resolve inside the project directory (symbolic links included) and end in `.yaml` or `.yml`. Anything else is refused with `errorCode: "guard.path"`.

During a run, snapshots behave like an interactive `klaus run`: a missing baseline is written, a mismatch is reported and never updated.

### Read-only mode

`klaus mcp --read-only` does not register `klaus_promote` and `klaus_snapshot_accept` at all: they are absent from the tool list and a call to them fails as an unknown tool. The other tools still behave as above; in particular `klaus_run_flow` and `klaus_request` still send requests and write history, and a run still writes missing snapshot baselines.

### Who is recorded as the actor

Every history entry written through `klaus mcp` has `actor.kind: "agent"`. The name is the client name from the MCP `initialize` request when the client sends one; otherwise the agent name detected from the environment (`CLAUDECODE`, `AI_AGENT`); otherwise `mcp`. The client name is self-reported, so treat it as a label, not as proof of identity.

## Result format and size limit

Every tool returns one text block that contains pretty-printed JSON. Expected failures (a refused path, an unknown run ID, a definition error, a guard refusal from `klaus_request`) return `isError: true` with a body of the form `{ "error": "...", "errorCode": "...", "hint": "..." }`; `errorCode`, `hint`, and `runId` appear only when they apply. Unexpected exceptions also return `isError: true` with the message, the details go to stderr, and the server keeps running. Arguments that fail the input schema (a missing or wrongly typed argument) are rejected by the MCP SDK before the tool runs: they also return `isError: true`, but the text is a plain message (`Input validation error: Invalid arguments for tool ...`), not this JSON.

A result is capped at 256 KiB. Larger strings and `body` values are replaced by a marker such as `[truncated: 1048576 bytes; read it with klaus_history_show: pass step and path (a path into the history entry, for example $.response.body) and, for a string value, offset and length to read it in windows; the stored record is also in .klaus/history]`, and the object gets `"resultTruncated": true`, so the JSON always stays valid.

### Reading large values

`klaus_history_show` can return less than a whole run, so a value that was cut off can still be read completely. Masking is as stored: history is already masked, and the values of protected environments are masked before `path` is applied, so a window never splits a value.

- `path` (requires `step`) selects one value in each selected history entry, for example `$.response.body`, `$.response.body.items[0]`, `$.response.headers['content-type']`, or `$.request.url`. Only four forms are accepted: `$`, `.name` (letters, digits, `_` and `-`, starting with a letter or `_`), `['name']` or `["name"]` (quoted, with `\\`, `\'`, `\"`, `\n`, `\t` escapes), and `[n]` (a non-negative integer). Recursive descent (`..`), wildcards, slices, unions, filters, and script expressions are refused with an `invalid path` error, because they can be made to cost far more than the entry is worth. The result lists, per entry, `matchCount` (0 or 1) and `matches`; a path that matches nothing gives an empty list.
- `offset` and `length` (require `path`) read a window of the single string value that `path` selects, for example a text body at `$.response.body`. They count characters (UTF-16 code units), `length` defaults to 32768 and is at most 40000, so a window always fits under the 256 KiB cap. The window result has `text`, `offset`, `length`, `totalLength`, and `nextOffset` (absent at the end); pass `nextOffset` as the next `offset` until it is absent. If `path` does not select exactly one string, the call fails and says so.

## Troubleshooting

**The client reports a protocol or parse error right after starting the server**

stdout must carry protocol messages only. `klaus mcp` writes nothing else there, but a wrapper script, a shell profile that prints on startup, or a different command registered under the same name can. Register `klaus` (or `npx`) directly, and check that the command you registered really is `klaus mcp`.

**`klaus_list_flows` returns an empty list, or flows are not found**

The server resolves everything from the directory it was started in. Start the client (or configure the server's working directory, if your client has such a setting) in the project directory.

**A request is refused**

```
host "127.0.0.1" is not in guard.allowedHosts (klaus.config.yaml); refusing to send the request.
```

The host is not in `guard.allowedHosts`. This cannot be changed through MCP. Tell the user, who can edit `klaus.config.yaml`; the next call picks the change up.

**An environment is refused**

```
environment "prod" is protected ($protected: true) and refuses execution by default. klaus mcp cannot override environment protection; the user must run this themselves from a terminal with `klaus run --allow-protected`.
```

The environment is marked `$protected`. Use another environment, or ask the user to run the flow in a terminal.

**`klaus_promote` fails because the file exists**

```
"flows/x.yaml" cannot be written: it already exists or a parent path is not a usable directory; klaus_promote never overwrites files
```

Choose another `out` path.

**A tool is reported as not found**

```
Tool klaus_promote not found
```

The server was started with `--read-only`. Restart it without the option if the write is intended.
