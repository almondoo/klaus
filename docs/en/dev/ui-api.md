# klaus ui — HTTP API and internal structure

See [../guide/ui.md](../guide/ui.md) for usage from an end-user perspective.

## HTTP API reference

The API used by the UI. All endpoints require an `X-Klaus-Token` header.

| Method / path | Parameters | Description |
|---|---|---|
| `GET /api/flows` | — | Recursively walks the tree under cwd (excluding node_modules / .git / dist / .klaus / ui / environments / tmp) and lists YAML files with a top-level `steps` key. Successfully parsed files return flow info; failures return a reason |
| `GET /api/flows/detail` | `path` | The parsed definition of a single flow (including a step overview) |
| `GET /api/environments` | — | List of environment names under `environments/*.yaml` (an empty array if the directory doesn't exist) |
| `POST /api/runs` | body: `{ path, env? }` | Runs a flow. The response is an SSE stream (see below) |
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
