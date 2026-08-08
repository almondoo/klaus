# klaus localhost UI (M4) Design

> [!summary] Role of this document
> Forward-looking design for the localhost web UI launched via the `klaus ui` command. Handoff document for the M4 implementation session. Also includes the "contracts to be preserved" so that the M1-M3 (core / CLI) implementation does not break the premises of this design. See [[requirements]](requirements.md) for the requirements.

## Purpose and scope

- `klaus ui` starts a local server and opens the UI in a browser
- The UI's role is **runner + viewer**. Editing flow definitions is out of scope (git-native philosophy: YAML editing is done in an editor. Editing from the UI remains a future candidate)
- Cloud sync and account mechanisms will never be built (as per the requirements)

## Architecture

```
src/
  core/      # Existing. All execution/assertion/history logic (unchanged)
  cli/       # Existing. Adds the `klaus ui` subcommand (just server startup + browser launch)
  server/    # New. HTTP API + static serving (a thin layer that imports core)
ui/          # New. Vite + React SPA (build output goes to dist/ui)
```

- **The server is implemented purely as a reuse of core**. Execution logic, assertions, and history read/write must not be reimplemented in the server
- **The browser side (ui/) does not runtime-import core**. It communicates only via the server's HTTP API. Types are shared via type-only imports from `src/core/types.ts` (erased at build time), keeping runtime coupling at zero
- **Hono** is adopted as the server framework (TypeScript-first, near-zero dependencies, lightweight — keeps the dependency footprint of a globally installed CLI light). Express is rejected as CJS-oriented and heavy; plain `node:http` is rejected due to the cost of implementing routing/middleware from scratch
- The server module is dynamically imported only when `klaus ui` is launched, so it does not affect the startup time of the normal CLI execution path

## Build and distribution

- `ui/` is Vite + React. `pnpm build:ui` outputs static files to `dist/ui/`, which the server serves from the same origin
- Add `src/server/index.ts` as a tsup entry point. Include `dist/ui` in the npm package's `files`
- During development, the Vite dev server (proxying API calls to the server) is used; in distribution, it is a same-origin static-serving configuration

## HTTP API design

Base path `/api`. All responses are JSON. Returns core's types as-is (the type contract is `src/core/types.ts`).

| Method / path | Role |
|---|---|
| `GET /api/flows` | List of flow YAML files under cwd (path, name, step count. Parse errors are returned marked as errors) |
| `GET /api/flows/detail?path=` | Parsed definition of a single flow |
| `GET /api/environments` | List of environment names from `environments/*.yaml` |
| `POST /api/runs` | Execute a flow. Body: `{ path, env? }`. The response is an **SSE stream** delivering per-step progress (`step-start` / `step-result`) and the final result (`run-result`) |
| `GET /api/history?flow=&limit=&before=` | Read out history JSONL (newest first, paginated) |

- To stream execution progress over SSE, core's `runner` must **expose a per-step-completion callback (or AsyncIterator)** (a requirement for the M1-M3 implementation; this can also be used for the CLI's progress display)
- Secret protection: API responses and history reads return the resolved value of <code v-pre>{{env.X}}</code> as-is (equivalent to what is recorded in the history JSONL). Masking values that should not be kept in history is left as a future concern and is not handled by the UI

## Security (concretization of the requirements' constraints)

1. **Bind only to 127.0.0.1** (`0.0.0.0` is not allowed even via configuration)
2. **Startup token**: On server startup, generate a token with `crypto.randomBytes`, and open `http://127.0.0.1:<port>/?token=<t>` in the browser. On first access, validate the token and store it in a `SameSite=Strict` cookie; subsequent API requests are double-checked via the cookie plus a custom header (`X-Klaus-Token`)
3. **DNS rebinding protection**: For every request, verify that the `Host` header is `127.0.0.1:<port>` / `localhost:<port>`. Mismatches return 403
4. **CSRF protection**: State-changing APIs (`POST /api/runs`) require a custom header (which cannot be sent by a simple request, blocking submissions from anything other than the same origin). When an `Origin` header is present, only the same origin is allowed
5. The UI is served from the same origin as the server (as per the requirements). No CORS headers are attached at all

## History JSONL contract (to be honored by the M1-M3 implementation)

Since the UI becomes a consumer reading the history JSONL, the following is established as a schema contract:

- Every line must include `v` (schema version, currently `1`)
- **Changes that do not bump `v` must be field additions only** (additive). Removing existing fields, changing their meaning, or changing their type requires a version bump
- The UI and server ignore unknown fields, and skip lines with an unknown `v` while displaying a warning
- One line = one step execution. Steps of the same run must be groupable by `runId`

## Screen layout (rough)

1. **Flow list**: List of flow files + environment selector + run button
2. **Run view**: Per-step progress (live updates via SSE), pass/fail of assertion results, request/response details on failure
3. **History browser**: List of past runs (filterable by flow / date) → drill down to step details

State management starts with React's standard tools (useState / useReducer + fetch), with an external library considered only once things get more complex (not introduced from the start).

## `klaus ui` command specification

```
klaus ui [--port <n>] [--no-open]
```

- If the port is not specified, an ephemeral port (an automatically chosen free port) is used
- After startup, the token-bearing URL is printed to stdout, and unless `--no-open` is given, the default browser is opened
- Ctrl+C to exit (server only; any flow in progress is aborted)

## Forward requirements for the M1-M3 implementation (summary)

To avoid rework at M4, the current phase must preserve:

1. Execution, assertion, and history logic live in `src/core`, imported from the CLI only (as per the requirements)
2. History JSONL follows the schema contract above (`v` / additive changes / `runId`)
3. `runner`'s public API includes per-step progress notification (callback or AsyncIterator)
4. Core may remain Node-only (no need for browser support), but must not bring in dependencies on the CLI (commander, process exit, stdout)
