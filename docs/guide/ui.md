# localhost UI

The web UI launched by `klaus ui`. It's a **runner + viewer** that can execute flows (with live progress) and browse history; editing flow definitions is done in your editor (a git-native philosophy). All execution, assertion, and history logic uses the same `src/core` as the CLI.

## Launching

```bash
klaus ui [-p <n>] [-H <host>] [--no-open]
```

- On startup, a URL with a token (`http://127.0.0.1:<port>/?token=…`) is displayed and the browser opens automatically
- If the UI assets (`dist/ui`) haven't been built, a 503 with guidance is shown. In a development checkout, run `pnpm build:all` first (the npm-installed version ships pre-built)
- The flow list and history are read relative to **the cwd the server was started from**. Launch it from the root of the project you want to verify

## Screens

1. **Single request execution (default screen)**: A tab for running one request on the spot, without going through a flow. Edit method / URL / headers / query parameters / body as a form, and run it with `{{var}}` expanded against the selected environment. The result shows status, duration, response headers, and body; values can be extracted from the response body via JSONPath and saved into the selected environment (saved as a merge of a single key, leaving other keys untouched)
2. **Flow list (sidebar)**: Lists flow YAML files under the cwd. Files with parse errors are shown with an error icon and reason, and can't be run. Selecting a flow switches to the execution view. The environment selector at the top switches the equivalent of `--env`, and the run button starts execution
3. **Execution view**: Steps transition live from running → pass/fail (delivered via SSE). Overall progress is shown as "Step n / m"; failed steps auto-expand to show request/response detail (JSON), while successful steps are collapsed by default. A summary is shown on completion
4. **Environment editor**: Opened via the edit button next to the environment selector; lets you edit the selected environment's key-value pairs in a table. Saving writes back to the file while preserving existing YAML comments
5. **History browser**: Displays `.klaus/history/*.jsonl` newest first. Grouped by run, with row clicks drilling down into step detail. Supports filtering by flow and "load more" paging

## Security Model

Designed for local use only — **it must not be exposed externally via a reverse proxy or similar**.

| Measure | Details |
|---|---|
| Binding | Defaults to 127.0.0.1; can be changed via `-H`/`--host` (or the `ui.host` key in `klaus.config.yaml`) |
| Auth token | Generated at startup with `crypto.randomBytes(32)`. Compared using a timing-safe comparison |
| First access | Successful validation of `GET /?token=…` issues a `klaus_token` cookie (SameSite=Strict / HttpOnly) |
| API auth | An `X-Klaus-Token` header is required on every `/api/*` (401 on mismatch) |
| CSRF | POST/PUT/DELETE additionally require the cookie to match, and if an `Origin` header is present, only the same origin is allowed |
| DNS rebinding | Any request whose `Host` isn't `127.0.0.1:<port>` / `localhost:<port>` gets a 403 (when `--host` is explicitly set to a non-loopback address, this check is relaxed to a port-only match) |
| CORS | No CORS headers are ever sent (same-origin serving only) |
| Path traversal | APIs and static serving that accept file paths reject resolution outside the cwd / dist/ui with a 403 |

The auth token above is not only printed to stdout at startup, but also passed as an argument to the browser auto-launch command (`open` / `xdg-open` / `cmd /c start`). On a shared multi-user host, that argument may be readable by other local users via the process list (`ps`, `/proc/<pid>/cmdline`). On such hosts, pass `--no-open` to skip the automatic browser launch and open the printed URL yourself. See [SECURITY.md](https://github.com/almondoo/klaus/blob/main/SECURITY.md) for details.

For the HTTP API specification and internal structure, see [../dev/ui-api.md](https://github.com/almondoo/klaus/blob/main/docs/en/dev/ui-api.md).
