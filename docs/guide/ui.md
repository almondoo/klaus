# localhost UI

The web UI launched by `klaus ui`. It's a **runner + viewer** that can execute flows (with live progress) and browse history; editing existing flow definitions is done in your editor (a git-native philosophy). The one exception is creating a **new** flow file from recorded history ([Saving history as a flow](#saving-history-as-a-flow)); existing flows are never edited or overwritten from the UI. All execution, assertion, and history logic uses the same `src/core` as the CLI.

## Launching

```bash
klaus ui [-p <n>] [-H <host>] [--no-open]
```

- On startup, a URL with a token (`http://127.0.0.1:<port>/?token=…`) is displayed and the browser opens automatically
- If the UI assets (`dist/ui`) haven't been built, a 503 with guidance is shown. In a development checkout, run `pnpm build:all` first (the npm-installed version ships pre-built)
- The flow list and history are read relative to **the cwd the server was started from**. Launch it from the root of the project you want to verify

## Screens

1. **Single request execution (default screen)**: A tab for running one request on the spot, without going through a flow. Edit method / URL / headers / query parameters / body as a form, and run it with `{{var}}` expanded against the selected environment. The result shows status, duration, response headers, and body; values can be extracted from the response body via JSONPath and saved into the selected environment (saved as a merge of a single key, leaving other keys untouched; refused with 403 for a protected environment)
2. **Flow list (sidebar)**: Lists flow YAML files under the cwd. Files with parse errors are shown with an error icon and reason, and can't be run. Selecting a flow switches to the execution view. The environment selector at the top switches the equivalent of `--env`, and the run button starts execution
3. **Execution view**: Steps transition live from running → pass/fail (delivered via SSE). Overall progress is shown as "Step n / m"; failed steps auto-expand to show request/response detail (JSON), while successful steps are collapsed by default. A summary is shown on completion
4. **Environment editor**: Opened via the edit button next to the environment selector; lets you edit the selected environment's key-value pairs in a table. Saving writes back to the file while preserving existing YAML comments. Saving to a protected environment (`$protected: true` or `readonly`) is refused with 403; edit the file directly
5. **History browser**: Displays `.klaus/history/*.jsonl` newest first. Grouped by run, with row clicks drilling down into step detail. Supports filtering by flow and "load more" paging. The list shows who ran each run (`actor`, e.g. `agent:claude`; agent and CI runs are highlighted) and the environment (`env`); the audit fields are also in the step detail. Each run row also has actions to compare it with another run and to save it as a flow (see below)

## Live updates

Runs made outside the UI (for example an AI agent running `klaus run` or `klaus req` in a terminal) show up in the open UI without a reload.

- The server watches `.klaus/history/` and pushes a notification over `GET /api/history/events` (SSE, same `X-Klaus-Token` auth as the other APIs). The notification carries only a sequence number and the changed dates; the UI then re-reads `GET /api/history`
- The history list refreshes in place: the loaded entries, scroll position, and expanded rows are kept
- While you are on another screen, the history button shows a "新着" badge. Runs started from the UI itself don't raise it
- The connection is dropped while the browser tab is hidden and re-established (with one refresh) when you return. If it breaks, the UI reconnects with backoff
- At most 16 browser connections can subscribe at once

## Comparing runs

Pick two runs in the history tab to see what changed between them, for example to review what an AI agent did against the API.

1. Press **比較** on a run row. A banner asks for the second run.
2. Either press **これと比較** on another run, or press **前回の同じフローと比較** in the banner to compare with the previous run of the same flow (it is looked up among the runs already loaded; press "さらに読み込む" first if it is not found). Single requests have no "previous run of the same flow", so pick the second run from the list.

The older run is always A and the newer one B. The panel shows, for every step, whether it is the same, different, added, or removed (as text and an icon, not only color), and for differing steps:

- the result (status, HTTP status, error, duration when it changed)
- **request changes** (method, URL, body), shown separately from
- **response changes** (headers, body, SSE events), as a list of path, kind, and before to after. Long values are collapsed behind "全文を表示". If a list is cut off, how many differences were omitted is shown; a subtree that is nested too deeply to compare is reported as one "深すぎて比較不能" row.

Values that change on every run (ids, timestamps) can be excluded: type a JSONPath such as `$.items[*].createdAt` or `$..updatedAt`, click a suggested path taken from the differences, or press "除外" on a difference row. The comparison is re-run with the new list. The default volatile response headers (`date`, `content-length`, request IDs, and so on) are always excluded, the same as `klaus diff`. Values are shown as stored in history, so secrets stay masked as `***` and a change to a secret value is not visible.

The same comparison is available from the command line as [`klaus diff`](history.md#comparing-runs).

## Saving history as a flow

The UI can turn recorded history into a **new** flow file, the same operation as [`klaus promote`](history.md#promoting-runs-to-a-flow). It never edits an existing flow, and there is no way to overwrite a file from the UI.

1. Press **フローとして保存** on a run row, or tick the checkboxes of several runs (each `klaus req` or single request is its own run) and press **選択した run をフローとして保存**. The selected runs become the steps in the order they ran.
2. In the dialog, choose the assertion mode (default `schema`), optionally a base URL variable, a flow name, and a save path. The YAML preview and the review items below it refresh as you type.
3. Check the review items: the OS environment variables you must set before running (values that were masked in history), the values replaced with placeholders because they look sensitive, the captures inferred between steps (verify each link), the skipped steps, and the notice to review the file for sensitive data before committing it.
4. Press **保存**. The file is written and the flow list in the sidebar refreshes.

Rules and refusals:

- The path must stay inside the working directory, end in `.yaml` or `.yml`, and not be under a directory that flow discovery skips (`node_modules`, `dist`, `ui`, `environments`, `tmp`, hidden directories such as `.git` and `.klaus`). It must not be `klaus.config.yaml`. Symbolic links that lead outside the working directory are refused. Such paths are answered with 403.
- If a file already exists at the path, saving is refused with 409. Choose another name or path.
- If a recorded request value contains a literal <code v-pre>{{</code>, generation is refused with 422 and the reason is shown. klaus expands <code v-pre>{{...}}</code> when a flow runs, so saving it could send an OS environment variable such as <code v-pre>{{env.X}}</code> to the server. The CLI has an explicit `--allow-template-literals` opt-in; the UI has none.
- A run with no executable step (every step skipped) cannot be saved (422).
- Secrets masked in history are never restored: they become <code v-pre>{{env.TODO_*}}</code> placeholders that you fill with OS environment variables.

## Protected environments and the host allowlist

- Flow runs from the UI never pass `--allow-protected`, so they are refused for any protected environment. Single requests are refused for `$protected: true`, and for `$protected: readonly` only safe methods (`GET` / `HEAD` / `OPTIONS`) are allowed.
- `PUT /api/environments/:name` and the "save captured value to environment" action return 403 for protected environments (`true` or `readonly`). Edit the file directly.
- If `klaus.config.yaml` sets [`guard.allowedHosts`](config.md#host-allowlist-guard-allowedhosts), runs and single requests from the UI are checked against it too. `klaus ui` reads the config at startup, so restart it after changing the list.
- If `klaus.config.yaml` sets [`http`](config.md#http-client-http) (redirect following, cookies, proxy, TLS), runs and single requests from the UI use it too. It is read once at startup like the allowlist, and is never accepted from a request.
- When a flow run from the UI is refused because of a protected environment, the message says that `klaus ui` cannot override the protection and points to `klaus run --allow-protected`. The refusal recorded in history keeps the generic wording.
- Runs from the UI are recorded in history with `actor.kind: human` (see [Execution History](history.md#audit-fields)).

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
