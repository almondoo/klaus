# localhost UI

The web UI launched by `klaus ui`. It's a **runner + viewer** that can execute flows (with live progress) and browse history; editing flow definitions is done in your editor (a git-native philosophy). All execution, assertion, and history logic uses the same `src/core` as the CLI.

## Launching

```bash
klaus ui [--port <n>] [--no-open]
```

- On startup, a URL with a token (`http://127.0.0.1:<port>/?token=…`) is displayed and the browser opens automatically
- If the UI assets (`dist/ui`) haven't been built, a 503 with guidance is shown. In a development checkout, run `pnpm build:all` first (the npm-installed version ships pre-built)
- The flow list and history are read relative to **the cwd the server was started from**. Launch it from the root of the project you want to verify

## Screens

1. **Flow list (sidebar)**: Lists flow YAML files under the cwd. Files with parse errors are shown with an error icon and reason, and can't be run. The environment selector at the top switches the equivalent of `--env`, and the run button starts execution
2. **Execution view**: Steps transition live from running → pass/fail (delivered via SSE). Overall progress is shown as "Step n / m"; failed steps auto-expand to show request/response detail (JSON), while successful steps are collapsed by default. A summary is shown on completion
3. **History browser**: Displays `.klaus/history/*.jsonl` newest first. Grouped by run, with row clicks drilling down into step detail. Supports filtering by flow and "load more" paging

## Security Model

Designed for local use only — **it must not be exposed externally via a reverse proxy or similar**.

| Measure | Details |
|---|---|
| Binding | Fixed to 127.0.0.1 (cannot be changed even via configuration) |
| Auth token | Generated at startup with `crypto.randomBytes(32)`. Compared using a timing-safe comparison |
| First access | Successful validation of `GET /?token=…` issues a `klaus_token` cookie (SameSite=Strict / HttpOnly) |
| API auth | An `X-Klaus-Token` header is required on every `/api/*` (401 on mismatch) |
| CSRF | POST additionally requires the cookie to match, and if an `Origin` header is present, only the same origin is allowed |
| DNS rebinding | Any request whose `Host` isn't `127.0.0.1:<port>` / `localhost:<port>` gets a 403 |
| CORS | No CORS headers are ever sent (same-origin serving only) |
| Path traversal | APIs and static serving that accept file paths reject resolution outside the cwd / dist/ui with a 403 |

For the HTTP API specification and internal structure, see [../dev/ui-api.md](../dev/ui-api.md).
