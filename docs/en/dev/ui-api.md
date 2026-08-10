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
| `GET /api/history` | `flow` / `limit` (default 50) / `before` (ISO datetime cursor) | Returns history paginated newest-first. Rows with an unknown `v` are skipped |

### SSE events for POST /api/runs

| Event | Payload | Timing |
|---|---|---|
| `step-start` | `{ flow, file, step }` | When a step starts |
| `step-result` | `{ flow, file, result: StepResult }` | When a step completes (including skipped) |
| `run-result` | `{ flow: FlowResult }` | When the flow completes (once, at the end) |

**Behavior on client disconnect**: closing or reloading the browser does **not** stop the in-flight flow — it runs to completion and the full history is written for every step. Only the SSE delivery is cut off; the server keeps responding normally to subsequent requests.

## Position in the architecture

The server (Hono) is a thin layer that just calls `runFlow` from `src/core` and bridges the `onStepStart` / `onStepComplete` callbacks to SSE. See [Architecture](architecture.md) for details and [ui-design.md](ui-design.md) / [ui-ux-design.md](ui-ux-design.md) for the design intent.
