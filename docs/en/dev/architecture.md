# Architecture

A structural guide for developers. See [requirements.md](requirements.md) for the design background and [ui-design.md](ui-design.md) for the UI design intent.

## Package layout and dependency direction

A single npm package (`@almondoo/klaus`) plus a ui workspace that is build-time only.

```
src/
  core/     # Execution engine (CLI-independent library). No dependency on other layers
  cli/      # A thin commander wrapper. Imports core
  server/   # klaus ui's API server (Hono). Imports core
ui/         # Vite + React SPA (private workspace). No runtime dependency on core
```

**Rules to preserve**:

- All execution, assertion, and history logic lives in `src/core`. cli / server only call into it — **never reimplement it**
- core must not bring in CLI-ish concerns such as commander, process exit, or stdout
- ui (the browser) never runtime-imports core. It only goes through the server's HTTP API. Type sharing is a **type-only import** from `src/core/types.ts` (erased at build time)
- The HTTP / WebSocket layer is delegated to undici. Do not hand-roll retry / redirect handling

## Internal structure of src/core

| Module | Responsibility | Pure / I/O |
|---|---|---|
| `schema.ts` | zod schemas (flow / environment files), exclusive-rule validation | Pure |
| `loader.ts` | YAML loading → zod validation → ParseError | I/O |
| `env.ts` | Resolving `environments/<name>.yaml` | I/O |
| `template.ts` | <code v-pre>{{...}}</code> expansion and template functions | Pure |
| `http.ts` | undici wrapper (timing, JSON detection, timeout) | I/O |
| `sse.ts` | SSE reception with a hard cutoff (eventsource-parser) | I/O |
| `ws.ts` | WebSocket connect / send / receive with a hard cutoff (undici WebSocket) | I/O |
| `assert.ts` | Evaluates all assertions (never throws) | Pure |
| `runner.ts` | Sequential step execution, capture chaining, skip control, status aggregation | Orchestration |
| `history.ts` | Appends history JSONL (versioned schema) | I/O |
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
  runId?: string;
  history?: boolean | ((entry: HistoryEntry) => void | Promise<void>);  // false disables it / a function customizes the sink
  onStepStart?: (ctx: { flow, file, step }) => void | Promise<void>;
  onStepComplete?: (ctx: { flow, file, result: StepResult }) => void | Promise<void>;
  onWarning?: (message: string) => void;   // Non-fatal warnings such as history write failures
}
```

- `onStepStart` / `onStepComplete` are used both by the CLI's incremental text output and the server's live SSE streaming (they also fire for skipped steps)
- Mapping between error types and exit codes: `ParseError` → 2 / `RuntimeError` → 3 (connection failure, timeout, unresolved template, capture failure). Assertion failures are not exceptions — they're represented as data in `StepResult` and converted to 4 at the CLI layer
- `runFlows` does not catch `ParseError` (the contract is that the caller maps it to exit 2)

## Build

- **tsup with 3 entries**: `dist/index.js` (the library, with a d.ts) / `dist/cli.js` (a bin with a shebang) / `dist/server.js` (dynamically imported on `klaus ui`)
- **ui uses Vite**, outputting to `dist/ui/` (the outDir in `ui/vite.config.ts`)
- `pnpm build:all` = `pnpm clean` → `pnpm build` (tsup) → `pnpm build:ui` (Vite)
- **Division of responsibility for clean**: tsup's own `clean` is set to `false`. tsup's clean wipes the entire outDir, and turning it on would take out Vite's `dist/ui` output along with it, leaving `klaus ui` returning 503 after `pnpm build` / `pnpm test`. The tradeoff is that when entries are removed or renamed, stale artifacts can linger in `dist/` and get bundled into the publish via `files: ["dist"]`. So **the full release build `build:all` empties `dist/` via `scripts/clean.mjs`** before rebuilding. A plain `pnpm build` during development does not clean and preserves `dist/ui`
- `src/cli/ui.ts` dynamically imports the server module via a runtime-assembled path, so `klaus run`'s startup time doesn't pay the cost of loading the server / Hono

## Test structure

The policy is "tests neither too many nor too few" (cover behavior at the spec level; don't glue tests to implementation details, and don't duplicate or pad).

**root (vitest, tests/, 121 tests)**

| Kind | Target |
|---|---|
| Pure unit | schema / loader / template / assert / env |
| Local-server integration | http / sse (node:http), ws (ws package), graphql, runner (capture chaining, skip, progress callbacks, history) |
| CLI unit | Exit-code decisions / text formatter / JUnit generation |
| CLI integration | Spawns the built `dist/cli.js` and verifies exit codes 0/1/2/3/4, JSON output, and JUnit generation |
| server integration | Auth (401/403), path traversal, SSE event sequence, history pagination, completion on client disconnect |

**ui (vitest + jsdom, 10 tests)**: pure functions for the SSE stream parser / API client token attachment / history grouping

## Development commands

```bash
pnpm install         # Installs across the whole workspace
pnpm build:all       # Full build (dist/ + dist/ui)
pnpm test            # root tests
pnpm --filter @almondoo/klaus-ui test   # ui tests
pnpm typecheck / pnpm lint              # tsc / biome (whole repo)
VITE_KLAUS_MOCK=1 pnpm --filter @almondoo/klaus-ui dev   # Develop the UI against a mock
```
