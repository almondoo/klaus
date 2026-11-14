# klaus ui — HTTP API and internal structure

See [../guide/ui.md](../../guide/ui.md) for usage from an end-user perspective.

## HTTP API reference

The API used by the UI. All endpoints require an `X-Klaus-Token` header.

| Method / path | Parameters | Description |
|---|---|---|
| `GET /api/flows` | — | Recursively walks the tree under cwd (excluding node_modules / .git / dist / .klaus / ui / environments / tmp) and lists YAML files with a top-level `steps` key. Successfully parsed files return flow info; failures return a reason |
| `GET /api/flows/detail` | `path` | The parsed definition of a single flow (including a step overview) |
| `GET /api/environments` | — | List of environment names under `environments/*.yaml` (an empty array if the directory doesn't exist) |
| `GET /api/environments/:name` | — | Returns the contents of a single environment as `{ name, values }`. 404 if the environment doesn't exist; 403 if `:name` contains path separators or similar |
| `PUT /api/environments/:name` | body: `{ values }` | Updates a single environment's contents and returns the updated contents as `{ name, values }`. `values` must be a map of string keys to string values. Existing comments in the YAML file are preserved. 404 if the environment doesn't exist |
| `POST /api/environments/:name/capture` | body: `{ key, path, json }` | Extracts a single value from `json` (e.g. the most recent response body) via JSONPath (`path`) and merges it into the specified environment under `key` (leaving other keys unchanged). Returns the updated contents as `{ name, values }`. 400 if there is no matching extraction result or the result is a non-primitive value (object/array/null); 404 if the environment doesn't exist |
| `POST /api/runs` | body: `{ path, env? }` | Runs a flow. The response is an SSE stream (see below) |
| `POST /api/request` | body: `{ request, env? }` | Synchronously executes a single request definition (`request` conforms to requestSchema) without going through a flow definition, returning `{ result: StepResult }`. If `env` is given, `{{var}}` is expanded against that environment. 400 on `request` validation errors; 403 if the `env` name is invalid |
| `GET /api/history` | `flow` / `limit` (default 50) / `before` (ISO datetime cursor) | Returns history paginated newest-first. Rows with an unknown `v` are skipped. The candidate used to accept a snapshot assertion (`candidate`, a copy of the whole response) is not returned |
| `GET /api/history/events` | — | SSE that notifies about changes to the history directory (`.klaus/history/`). A notification carries only a sequence number and the changed dates; the client then re-reads `GET /api/history`. At most 16 concurrent subscribers |
| `GET /api/history/diff` | `a` / `b` (run IDs; `latest` / `previous` are accepted when `flow` is given) / `flow` (optional) / `ignorePath` (JSONPath, repeatable, at most 20) | The difference between two runs (the core `diffRuns` result: `klaus diff --json` without `version`). 400 for a malformed run ID, an unparsable or too many `ignorePath` values; 404 for a run that is not in history. History is compared as stored (masked) |
| `POST /api/history/promote` | body: `{ runIds, flow?, assert?, baseUrlVar?, chain?, name?, out?, dryRun? }` | Generates a **new** flow from history runs (the equivalent of `klaus promote`; there is no `--force` or `--allow-template-literals`, and unknown keys give 400). `dryRun: true` returns only the YAML and the summary and writes nothing. The destination must be under api/ or flows/, or in a directory that already contains flow files; 403 for outside cwd, hidden segments, a wrong extension, a configuration file name, or backslashes; 409 for an existing file (never overwritten); 404 for a run not in history; 422 for a refusal such as a recorded literal `{{` (`code: "template-literal"`) |
| `GET /api/snapshots/mismatches` | `runId` | The run's pending snapshots (core `listSnapshotMismatches`) as `{ runId, mismatches, acceptRefusal? }`. `acceptRefusal` carries the reason for, for example, a run against a protected environment. 400 for a malformed run ID, 404 for a run not in history |
| `POST /api/snapshots/accept` | body: `{ runId, snapshotFile, key }` | Writes one pending snapshot as the baseline (core `acceptSnapshot`). `(snapshotFile, key)` must be a pair from the list above (404 otherwise; 403 for a path outside cwd or with backslashes). 403 for a run against a protected (or unverifiable) environment and for core's `unsafe`; 422 for a corrupt existing file (or a malformed candidate); 409 when the step's other assertions failed (`failed-step`) |

### SSE events for POST /api/runs

| Event | Payload | Timing |
|---|---|---|
| `step-start` | `{ flow, file, step }` | When a step starts |
| `step-result` | `{ flow, file, result: StepResult }` | When a step completes (including skipped) |
| `run-result` | `{ flow: FlowResult, warnings?, openapi? }` | When the flow completes (once, at the end). `warnings` are notices that do not change the result; `openapi` is the coverage summary when the server has `run.openapi` |

**Behavior on client disconnect**: closing or reloading the browser does **not** stop the in-flight flow — it runs to completion and the full history is written for every step. Only the SSE delivery is cut off; the server keeps responding normally to subsequent requests.

## Position in the architecture

The server (Hono) is a thin layer that just calls `runFlow` from `src/core` and bridges the `onStepStart` / `onStepComplete` callbacks to SSE. See [Architecture](architecture.md) for details and [ui-design.md](ui-design.md) / [ui-ux-design.md](ui-ux-design.md) for the design intent.
