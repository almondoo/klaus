# Architecture

A structural guide for developers. See [requirements.md](requirements.md) for the design background and [ui-design.md](ui-design.md) for the UI design intent.

## Package layout and dependency direction

A single npm package (`@almondoo/klaus`) plus a ui workspace that is build-time only.

```
src/
  core/     # Execution engine (CLI-independent library). No dependency on other layers
  cli/      # A thin commander wrapper. Imports core
  server/   # klaus ui's API server (Hono). Imports core
  mcp/      # klaus mcp's MCP server (stdio). Imports core. A third consumer layer next to cli / server
ui/         # Vite + React SPA (private workspace). No runtime dependency on core
```

**Rules to preserve**:

- All execution, assertion, and history logic lives in `src/core`. cli / server / mcp only call into it — **never reimplement it**
- `src/mcp` depends on core, and `src/core` never imports `src/mcp`. mcp may import only those helpers in `src/server` / `src/cli` that are **free of Hono, commander, and stdout writes** (`listFlows`, `listEnvironments`, `resolveWithinCwd`, `promoteHistoryToFile`, `acceptPendingSnapshot`, `loadCliConfig`, `detectActor`, and so on). The write rules that `klaus ui` and `klaus mcp` share (matching pending snapshots, refusing protected environments, the output-location allow-list, new files only) live in such Hono-free functions, and the routes in `src/server/routes/*` only map their result onto an HTTP response
- MCP is treated as a path an agent drives, so it is stricter than the CLI: it never passes `allowProtected` (the `EntryPoint` is `"mcp"`), takes guards only from `klaus.config.yaml` (re-read on every tool call), always masks output and records history, and has no way to loosen any of that such as `--no-mask`. stdout carries the protocol only; every diagnostic goes to stderr
- core must not bring in CLI-ish concerns such as commander, process exit, or stdout
- ui (the browser) never runtime-imports core. It only goes through the server's HTTP API. Type sharing is a **type-only import** from `src/core/types.ts` (erased at build time)
- HTTP / WebSocket connections are delegated to undici. Redirects are handled one hop at a time in core (`http-session.ts`) because the guards must be re-checked on every hop. Proxy and TLS are set only from the options built from the config file (never from a flow)

## Internal structure of src/core

| Module | Responsibility | Pure / I/O |
|---|---|---|
| `schema.ts` | zod schemas (flow / environment files), exclusive-rule validation | Pure |
| `loader.ts` | YAML loading → zod validation → ParseError | I/O |
| `env.ts` | Resolving `environments/<name>.yaml` | I/O |
| `template.ts` | <code v-pre>{{...}}</code> expansion and template functions | Pure |
| `http.ts` | undici wrapper (timing, JSON detection, timeout) | I/O |
| `http-session.ts` / `cookie-jar.ts` | Per-run HTTP client (proxy, TLS, per-hop redirects, cookie jar) | I/O |
| `sse.ts` | SSE reception with a hard cutoff (eventsource-parser) | I/O |
| `ws.ts` | WebSocket connect / send / receive with a hard cutoff (undici WebSocket) | I/O |
| `assert.ts` | Evaluates all assertions (never throws) | Pure |
| `runner.ts` | Sequential step execution, capture chaining, skip control, status aggregation | Orchestration |
| `history.ts` | Appends history JSONL (versioned schema) | I/O |
| `cassette.ts` | Cassette recording / matching for record/replay mode | I/O |
| `discovery.ts` | Flow definition YAML discovery (shared logic for the server and the CLI) | I/O |
| `history-query.ts` | Reads, filters, and paginates history (shared by the server and the CLI) | I/O |
| `errors.ts` | `KlausError` / `ParseError` / `RuntimeError` | Pure |
| `types.ts` | Contract types such as `RunResult` / `FlowResult` / `StepResult` | Pure |

## core's public API (`src/core/index.ts`)

The contract used by the CLI, server, and future tools:

```ts
runFlow(filePath, options?): Promise<FlowResult>      // Run a single flow
runFlows(filePaths, options?): Promise<RunResult>     // Run multiple flows sequentially
executeFlow(flow, filePath, options?): Promise<FlowResult>  // Run an already-parsed Flow

interface RunFlowOptions {
  cwd?: string;                 // Base directory for environment files and history
  envNameOverride?: string;     // Equivalent to --env
  allowProtected?: boolean;     // Whether to allow running against a $protected: true environment (default false)
  runId?: string;
  history?: boolean | ((entry: HistoryEntry) => void | Promise<void>);  // false disables it / a function customizes the sink
  onStepStart?: (ctx: { flow, file, step }) => void | Promise<void>;
  onStepComplete?: (ctx: { flow, file, result: StepResult }) => void | Promise<void>;
  onWarning?: (message: string) => void;   // Non-fatal warnings such as history write failures
  onSecrets?: (secrets: readonly string[]) => void;  // Notifies newly-resolved secrets for a step (a separate path from history masking)
  recording?: { mode: "record" | "replay"; dir: string };  // Cassette settings for record/replay mode
}
```

- `onStepStart` / `onStepComplete` are used both by the CLI's incremental text output and the server's live SSE streaming (they also fire for skipped steps)
- Mapping between error types and exit codes: `ParseError` → 2 / `RuntimeError` → 3 (connection failure, timeout, unresolved template, capture failure). Assertion failures are not exceptions — they're represented as data in `StepResult` and converted to 4 at the CLI layer
- `runFlows` does not catch `ParseError` (the contract is that the caller maps it to exit 2)

## Internal structure of src/mcp

| File | Responsibility |
|---|---|
| `tools.ts` | The 12 tool definitions (name, description, zod input schema, annotations, handler). It does not depend on the MCP SDK and can be unit-tested as pure async functions `(args, ctx) => ToolOutcome`, where ctx is `{ cwd, readOnly, clientName? }` |
| `result.ts` | `ToolOutcome` / `ToolError` and the serialization of a result to JSON. Beyond 256 KiB, huge strings and `body` values are replaced with a marker so the JSON stays valid |
| `queue.ts` | An in-process serial queue that runs the tools that send or write (`klaus_run_flow` / `klaus_request` / `klaus_promote` / `klaus_snapshot_accept`) one at a time |
| `server.ts` | Registration with the SDK (`McpServer` + `StdioServerTransport`), mapping to `isError`, reporting unexpected exceptions to stderr, and waiting until the connection closes |

`registerMcpCommand` in `src/cli/mcp.ts` registers `klaus mcp [--read-only]`. `--read-only` does not register the write tools (`klaus_promote` / `klaus_snapshot_accept`). The history actor always has kind `agent`, and its name is decided in the order "client name from `initialize` > environment marker (`CLAUDECODE` / `AI_AGENT`) > `mcp`".

## Build

- **tsup with 5 entries**: `dist/index.js` (the library, with a d.ts) / `dist/cli.js` (a bin with a shebang) / `dist/server.js` (dynamically imported on `klaus ui`) / `dist/openapi-worker.js` (runs OpenAPI schema validation in a worker thread; listed in `files`) / `dist/schema-gen.js` (build-time only, generates the schema JSON; not in `files`)
- **ui uses Vite**, outputting to `dist/ui/` (the outDir in `ui/vite.config.ts`)
- `pnpm build:all` = `pnpm clean` → `pnpm build` (tsup) → `pnpm build:ui` (Vite)
- **Division of responsibility for clean**: tsup's own `clean` is set to `false`. tsup's clean wipes the entire outDir, and turning it on would take out Vite's `dist/ui` output along with it, leaving `klaus ui` returning 503 after `pnpm build` / `pnpm test`. The tradeoff is that when entries are removed or renamed, stale artifacts can linger in `dist/` and get bundled into the publish via `files: ["dist"]`. So **the full release build `build:all` empties `dist/` via `scripts/clean.mjs`** before rebuilding. A plain `pnpm build` during development does not clean and preserves `dist/ui`
- `src/cli/ui.ts` dynamically imports the server module via a runtime-assembled path, so `klaus run`'s startup time doesn't pay the cost of loading the server / Hono
- The SDK behind `klaus mcp` (`@modelcontextprotocol/server` and `@modelcontextprotocol/core`; a devDependency) is bundled into `dist/cli.js` through `noExternal` like the other runtime dependencies, so users do not need to install anything at runtime. `src/cli/mcp.ts` dynamically imports `../mcp/server.js`, so the SDK's modules are initialized only for `klaus mcp` and no other command's startup time changes. Code splitting would turn that dynamic import into a separate chunk file that `files` (which lists only `dist/cli.js`) would miss, so the cli build sets `splitting: false` to keep a single file

## Test structure

The policy is "tests neither too many nor too few" (cover behavior at the spec level; don't glue tests to implementation details, and don't duplicate or pad).

**root (vitest, tests/, 71 files, 1564 tests)**

| Kind | Target |
|---|---|
| Pure unit | schema / loader / template / assert / env |
| Local-server integration | http / sse (node:http), ws (ws package), graphql, runner (capture chaining, skip, progress callbacks, history) |
| CLI unit | Exit-code decisions / text formatter / JUnit generation |
| CLI integration | Spawns the built `dist/cli.js` and verifies exit codes 0/1/2/3/4, JSON output, and JUnit generation |
| server integration | Auth (401/403), path traversal, SSE event sequence, history pagination, completion on client disconnect |
| MCP tools | `tests/mcp/`: each tool's handler against a local fixture (guard refusals, masking, the write rules, the size cap). The protocol is verified by `tests/cli/integration.test.ts`, which speaks JSON-RPC to the built `dist/cli.js mcp` |

**ui (vitest + jsdom, 16 files, 97 tests)**: the logic layer: the SSE stream parser / API client token attachment / hooks / history grouping and other utilities

## Development commands

```bash
pnpm install         # Installs across the whole workspace
pnpm build:all       # Full build (dist/ + dist/ui)
pnpm test            # root tests
pnpm --filter @almondoo/klaus-ui test   # ui tests
pnpm typecheck / pnpm lint              # tsc / biome (whole repo)
VITE_KLAUS_MOCK=1 pnpm --filter @almondoo/klaus-ui dev   # Develop the UI against a mock
```
