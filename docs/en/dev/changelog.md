# Changelog

Records what changed in each release, plus **the decisions behind it and the pitfalls I hit along the way**.
The current spec lives in the respective references ([CLI](../../guide/cli.md) / [Flow definition](../../guide/flow-definition.md) / [Architecture](architecture.md)) — this is the place I keep "why it ended up this way."

0.2.0 through 0.14.4 were reconstructed after the fact from the git history (taking the `chore: vX.Y.Z` version-bump commits as boundaries: everything between the previous bump and a given bump belongs to that version). Only user-visible changes (feat / fix) are summarized, briefly; internal refactors, tests, and dependency-update details are left out.

From 0.15.0 on, each release was written by checking its commit range with `git log` (everything from one bump commit up to the next belongs to the later version). The exception is 0.23.0 through 0.25.0: their bump commits landed before the feature commits (`99d8002` mock, `0a35c3e` reports, `fac3194` diff / promote), so versions are assigned by content: 0.23.0 = `klaus mock`, 0.24.0 = HTML / GitHub reports, 0.25.0 = `klaus diff` / `klaus promote`.

## 0.31.0

`klaus mcp`: a stdio server that exposes klaus as tools to an MCP (Model Context Protocol) client, that is, an AI agent. It lets the agent explore and test an API through klaus's own guardrails instead of `curl`.

- **Added: `klaus mcp [--read-only]`.** It speaks stdio only (no network listener) and uses the working directory (`process.cwd()`) as the project. There are 12 tools (`klaus_list_flows` / `klaus_validate_flow` / `klaus_list_environments` / `klaus_dry_run` / `klaus_run_flow` / `klaus_request` / `klaus_history_list` / `klaus_history_show` / `klaus_diff_runs` / `klaus_snapshot_list` / `klaus_promote` / `klaus_snapshot_accept`). `klaus.config.yaml` (`guard` / `http` / `run.openapi`) is re-read on every call, and an invalid configuration makes the call fail instead of sending without the guard. stdout carries the protocol only, every diagnostic goes to stderr, and it exits 0 on stdin close, SIGINT, or SIGTERM. `--read-only` does not register the write tools (`klaus_promote` / `klaus_snapshot_accept`); the run tools still write history and missing snapshot baselines.
- **Decision: MCP is treated as a path an agent drives, so it is stricter than the CLI.** It has no `--allow-protected`, no `--no-mask`, and no way to pass guards (MCP cannot loosen a guard), and output masking and history recording are always on. Snapshots use `ci: false` / `update: false` (a missing baseline is written, a mismatch is reported and never updated). Writes follow the rules of the UI server, not the CLI. To share them, the bodies of `POST /api/history/promote` and `POST /api/snapshots/accept` were extracted as Hono-free functions (`promoteHistoryToFile` / `acceptPendingSnapshot`) used by both the UI routes and MCP (the routes only map the result onto an HTTP response; the responses did not change). Flow paths are limited to `.yaml` / `.yml` files inside the cwd (link targets included).
- **Decision: file contents must not leak through errors.** A YAML syntax error carries an excerpt of the source line, so passing any file in the cwd as a flow would put its content in the error message. MCP therefore limits flow paths to YAML extensions, returns only the first paragraph of an error message, and shows paths relative to the project.
- **Added: `"mcp"` in core's `EntryPoint`.** The hint on a protected-environment refusal becomes "`klaus mcp` cannot override it; the user must run `klaus run --allow-protected` from a terminal" (for flow runs, single requests, and `--dry-run` alike). `executeSingleRequest` now accepts `entryPoint` too.
- **Decision: the history actor.** The kind is always `agent`. The name is decided in the order "client name sent in `initialize` > environment marker (`CLAUDECODE` / `AI_AGENT`) > `mcp`". The client name is self-reported, so control characters are stripped, the length is limited, and it never decides whether something may run.
- **Decision: result shape.** Every tool returns one pretty-printed JSON text block, and an expected failure is `isError: true` with `{error, errorCode?, hint?}`. A run whose steps failed assertions or were refused is not a tool failure (`klaus_request` sends exactly one request, so a refusal or a send failure is). A result is capped at 256 KiB (huge strings and `body` values are replaced with a marker so the JSON stays valid). Tools that send or write run one at a time through an in-process serial queue. In the tool annotations, the request-sending tools are destructive / open-world, `klaus_promote` is non-destructive (it never overwrites), and `klaus_snapshot_accept` is destructive.
- **Added: devDependency `@modelcontextprotocol/server` (pinned to 2.4.0).** Like the other runtime dependencies it is bundled into `dist/cli.js` through `noExternal` (the `zod` entry became a regular expression so the `zod/v4` subpath is included), so users install nothing at runtime. `dist/cli.js` grows from about 3.8 MB to about 4.6 MB, but the SDK is initialized by a dynamic import only for `klaus mcp`, so no other command's startup time changes. Code splitting would turn that dynamic import into a separate chunk file that `files` (only `dist/cli.js`) would miss, so the cli build sets `splitting: false`.
- Docs: added the guide "MCP server for AI agents" and listed `klaus mcp` in the CLI reference, the READMEs, and the Agent Skill / `AGENTS.md`.
- **Behavior change: JSON nested deeper than 200 levels is kept as text.** A deep JSON response made masking and result shaping recurse until the stack overflowed (a 5000-deep array with a registered secret crashed the run, and in `klaus mcp` the tool call). `parseJsonBody` (shared by `sendRequest` and cassette replay) now returns the raw text when the iterative `exceedsDepth` check finds nesting beyond `MAX_JSON_BODY_DEPTH` (200, the same value the snapshot limit already used), so every later stage (masking, history, JSONPath) never sees a deep structure. The same rule covers `klaus req --body`, the JSON of SSE events and WebSocket messages in `path` assertions, and the `klaus_request` body argument (refused with a hint to send a string). The cost is that JSONPath captures and assertions do not match such a body. `serializeOutcome` in `klaus mcp` now runs inside the same try as the handler.
- **Behavior change: `historyRef` appears only on steps that were actually recorded.** `klaus run --json` attached `historyRef` to every step when history was on, but a step that ends with a runtime error (a failed capture, a timeout, a connection error, a response that is too large) leaves no history entry, so the pointer led nowhere. `StepResult` gained `historyRecorded`, set only after the entry was written, and the reporter (and `klaus_run_flow`, which now returns `historyRef: { runId, step }` per recorded step) follows it. What is recorded did not change. The `klaus_run_flow` description, the guide, and the JSON schema descriptions now say which steps are recorded (`passed`, `failed`, `skipped`, guard refusals) and which are not.
- **Fix: a queued `klaus mcp` call could still send after the client disconnected.** The serial queue now has `close()`; stdin closing or SIGINT / SIGTERM closes it, so calls that have not started are rejected. A request already in flight is neither aborted nor awaited (the 3-second grace before exit is unchanged), so it may reach the server without a history entry. This is documented in the guide.
- **Added: `path`, `offset`, and `length` on `klaus_history_show`.** The truncation marker used to point at `klaus_history_show` with `step`, which truncates the same way. `path` (a JSONPath against the selected step entry, via the bundled jsonpath-plus) returns only the matched values, and `offset` / `length` read a window of a single string value (default 32768 and at most 40000 characters, so a window always fits under the 256 KiB cap even when every character expands to six bytes of JSON escape) with `totalLength` and `nextOffset`. The marker text now describes exactly that. Masking is as stored.
- **Added: `variables` on `klaus_dry_run`** (same shape as `klaus_run_flow`), and a dedicated `env` description on `klaus_request`.
- **Fix: `klaus_promote` and the UI's promote accept only `.yaml` / `.yml` in lower case**, matching flow discovery (a file named `x.YAML` could be written but was never discovered).
- **Docs: stopped overclaiming what protection does.** "Guards cannot be overridden" was true of the options but read as a promise about the outcome. The guide, tool descriptions, `AGENTS.md`, and the Agent Skill now say that `$protected` gates runs that select that environment (it is tied to the environment name, not to hosts), that `klaus_dry_run` shows expanded environment values (also of protected environments and refused steps), that `klaus_request` without `env` can reach every host `guard.allowedHosts` permits, and that any OS environment variable of the `klaus mcp` process can be referenced with <code v-pre>{{env.NAME}}</code> and sent to an allowed host. `guard.allowedHosts` is therefore the control that limits where an agent sends, and the guide has a "Recommended setup" list. The guide also says that schema-level argument errors come back as the SDK's plain text, not the JSON error body.

## 0.30.0

A wider `klaus history` filter, a stable error code on `error` steps, explanations in the UI, and a narrower exception for the cassette's structural headers.

- **Added: `klaus history --status <statuses>`.** Filters the list by a comma-separated set of statuses (`passed` / `failed` / `skipped` / `error`). `--failed` returns only assertion failures and leaves out send errors and guard refusals (`error`), so there was no way to list `error` runs. `--failed` is unchanged. An unknown value (the message lists the valid ones) and combining it with `--failed` (an argument conflict) both exit 1: `--failed` means the same as `--status failed`, so combining them is pointless, and refusing is less surprising than silently preferring one. The UI server's `GET /api/history` did not get the same filter
- **Added: `errorCode` on `error` steps.** The free-text English `error` alone could not be handled mechanically, so a stable code identifying the cause is now attached where the error is built (`GuardRefusalError` and the response-size error), never by matching messages. `guard.allowed-hosts` / `guard.protected` / `guard.readonly` / `guard.method-override` / `guard.host-header` / `guard.proxy-header` / `guard.redirect` / `response-too-large`, plus `guard.path` for refusals of a sent file or snapshot outside the cwd. Other errors get none (no catch-all code). It is stored in history entries, sits next to `error` in `run --json` / `req --json`, appears as `guard.errorCode` in `--dry-run`, and is passed through the UI server's SSE (`step-result` / `run-result`), `POST /api/request`, and `GET /api/history`. Summary-only output does not carry it. When a redirect hop is refused, the more specific code of the hop's own refusal is kept, and `guard.redirect` is used only for a refusal without a code (every current guard has one, so `guard.redirect` is reserved for future refusals). Only guard refusals are recorded in history, so only `guard.*` codes appear there
- **Fix: the cassette's structural headers were not masked even when they contained an env or auth secret** (flagged in the 0.29.2 review). Writing `content-type` and similar headers as recorded prevents replay from breaking on cookie values such as `ct=application/json`, but it also left headers that contain a non-cookie secret in plain text. The secret collection now remembers which registrations came from cookies (`SecretSet`), and a structural header is restored to its original value only when masking it with the non-cookie secrets leaves it unchanged
- UI: guard refusals and common errors are explained in Japanese (based on `errorCode`), with the original message kept as detail
- UI: the history table layout is adjusted for narrow screens

## 0.29.2

Fixed three issues found by the final review of 0.29.1.

- **Fix: the Host grammar now allows `_`.** Docker network names such as `my_service:8080` were refused even when identical to the URL (`guard.allowedHosts` accepts such names). `# / ? @ % \`, whitespace, and control characters are still refused (including the `%` of a zone-ID IPv6 address). A refusal caused by the grammar now says the Host value contains characters that are not allowed instead of "differs from the request URL" (same guard-refusal path; the `--dry-run` `guard.reason` carries the same text)
- **Fix: replay broke when a long cookie value equalled ordinary content.** `Set-Cookie: ct=application/json` (16 characters) was registered as a secret, `--record` stored `content-type` as `***`, and `--replay` could no longer parse the body as JSON. The cassette writer now exempts the headers that replay and mock depend on (`content-type`, `content-encoding`, `content-length`, `transfer-encoding`) from substring masking and writes their recorded values. `location` is not exempt because it can carry secrets. Masking of what history and snapshots display is unchanged (both sides of a comparison are masked the same way, so comparison is not affected)
- **Fix: a captured `Set-Cookie` leaked when interpolated elsewhere.** Without the jar, `capture: { sc: { header: set-cookie } }` used in a query, a header, or a body left the value in history, cassettes, reports, and `promote` output. `Set-Cookie` values of 16 or more characters are now registered as secrets on receipt, whether or not the jar is on (registering on receipt is simpler than registering in the capture step, and covers the jar-enabled and non-capture paths with one rule). The variable itself stays raw for use in requests. Capturing a response `Cookie` header (which servers do not normally send) is not covered
- Documentation: the cookie exception to "captured values are not masked", and that assertion messages for `cookie` / `set-cookie` stay masked even with `--no-mask`

## 0.29.1

Fixed a regression in the `Set-Cookie` masking from 0.28.2, restored secret registration for cookie values, and tightened the Host header grammar, the snapshot lock, and the `$ref` message (fixes from an adjudicated adversarial review).

- **Fix: `Set-Cookie` is raw at run time and masked only on output.** 0.28.2 masked the response header at receive time, so `capture: { x: { header: set-cookie } }`, header assertions on `set-cookie`, and the cookie jar's intake on replay all saw `sid=***`. The receive-time masking is gone; every output path (history, cassettes, snapshot baselines and candidates, the live results sent to the UI, reports, stdout) now masks the value of `Cookie` / `Set-Cookie` headers by position whether or not any secret is registered. The `message` / `actual` of a failed assertion are free strings that `maskDeep` cannot see, so for the `cookie` / `set-cookie` headers the evaluator puts the masked value there (the comparison uses the raw value). As a result the assertion messages of those two headers stay `***` even with `--no-mask`. On replay the cassette's masked `Set-Cookie` is replayed as is (the jar stores `***`, and behaviour is unchanged)
- **Fix: cookie values of 16 or more characters received by the jar are registered as secrets again.** After the 0.28.2 change, a session ID echoed in a response body or another header was written in plain text to history, baselines, cassettes, and reports. The old rule (the global minimum of 4) corrupted output for values such as `json` or `true`, so there is now a cookie-specific minimum of 16 (`MIN_COOKIE_SECRET_LENGTH`) and the global minimum is unchanged. Shorter values are masked only by position inside Cookie / Set-Cookie headers. `capture: { x: { cookie: name } }` follows the same rule (it used to register anything of 4 or more characters)
- **Fix: the `Host` header grammar is strict.** Before the comparison made when `guard.allowedHosts` or a proxy is set, the raw value must match `^[A-Za-z0-9.-]+(:\d{1,5})?# Changelog

Records what changed in each release, plus **the decisions behind it and the pitfalls I hit along the way**.
The current spec lives in the respective references ([CLI](../../guide/cli.md) / [Flow definition](../../guide/flow-definition.md) / [Architecture](architecture.md)) — this is the place I keep "why it ended up this way."

0.2.0 through 0.14.4 were reconstructed after the fact from the git history (taking the `chore: vX.Y.Z` version-bump commits as boundaries: everything between the previous bump and a given bump belongs to that version). Only user-visible changes (feat / fix) are summarized, briefly; internal refactors, tests, and dependency-update details are left out.

From 0.15.0 on, each release was written by checking its commit range with `git log` (everything from one bump commit up to the next belongs to the later version). The exception is 0.23.0 through 0.25.0: their bump commits landed before the feature commits (`99d8002` mock, `0a35c3e` reports, `fac3194` diff / promote), so versions are assigned by content: 0.23.0 = `klaus mock`, 0.24.0 = HTML / GitHub reports, 0.25.0 = `klaus diff` / `klaus promote`.

 or a bracketed IPv6 address (the URL parser had accepted `host#x`, `host/..`, `@host`, percent escapes, backslashes, and tabs). A non-ASCII IDN is accepted only when it contains none of the forbidden characters (`# / ? @ % \`, whitespace, control characters) and equals the URL's host. Two keys that differ only in case are rejected by undici (pinned by a test)
- Snapshot lock: the wait timeout (10 s to 35 s) is now longer than the stale threshold (30 s), so a lock left behind by a crash is always waited out and taken over. The timeout error names the lock file and says it can be removed if no other run is writing
- The message for an unresolvable OpenAPI `$ref` now says what to do (place the referenced files under the document's directory, or bundle the document into one file). It is still the same text for missing, outside, and linked targets, and still shows no path
- Documentation: the cookie section now says that a cookie set on `http://` is not sent after a redirect to `https://` (the effective port differs) and describes the 16-character rule; the snapshot and record/replay pages warn that a short session value echoed in a body is not masked

## 0.29.0

Tidied masking and a few UI / CLI details (fixes from the final review, plus documentation consistency).

- **Behaviour change: the value of a `Cookie` header is always `***` in output, even when no secret is registered.** This covers the stdout (JSON and text) of `klaus run` / `klaus req` / `--dry-run` and `--report html` / `--report github`, so a `Cookie` header written in a flow or passed with `klaus req -H` is masked too. Previously a run with no registered secret skipped output masking altogether. `--no-mask` means what it did (only stdout stays raw; history and report files are always masked). The text output of `klaus run` also masks the step result before formatting it
- **Behaviour change: `klaus history` (the list) no longer prints a snapshot's `candidate`** (the masked copy of the whole response), not even with `--fields assertions`. `klaus history show <runId>` also omits it when printing the whole run, and includes it only when narrowed to one step with `--step`. This keeps large responses out of list and whole-run output, where they would flood an agent's context
- The guidance at the end of a protected-environment refusal is now chosen by core through `RunFlowOptions.entryPoint` (`"cli"` / `"ui"` / `"library"`; unset behaves as `"cli"`). A run started from the UI gets the UI wording (the UI cannot pass `--allow-protected`), and **history records the wording the user actually saw**. Before, the server only replaced the string it delivered, so history disagreed with the screen. The replacement module (`src/server/protection-hint.ts`) is gone
- Documentation: the CLI reference's command count and a `klaus snapshot` mention, the README, the AGENTS.md template, and the agent skill now match the final behaviour. Statements that implementation overturned in the requirements, architecture, and improvement-proposal documents (leave HTTP concerns to undici, no mock server planned, no flow editing in the UI, parallel execution deferred) were corrected. A results section was added to the implementation plan

## 0.28.2

Handling of snapshots that cannot be approved in the UI, plus fixes from an adversarial review of the HTTP layer.

- UI: the snapshot of a step whose other assertions failed cannot be approved, and the reason is shown (the accept API answers 409). `POST /api/runs` always closes the OpenAPI validation worker when it finishes
- **Behaviour change: on a cross-origin redirect, only `accept*` headers and `user-agent` (plus `content-type*` when the body is kept) are forwarded.** Every other user-set header is dropped regardless of its value (before, only credentials and headers carrying a secret value were dropped). The names of the dropped headers stay in `droppedHeaders` on the result and in history. A `Location` with userinfo is refused and its fragment is dropped
- **Behaviour change: cookies are scoped by port as well as host** (a cookie for `localhost:3000` is not sent to `localhost:4000`). The `Domain` attribute is still stored as host-only and never shared across subdomains
- A cookie value and a proxy user name are no longer registered as substring secrets. Instead the values of `Cookie` / `Set-Cookie` headers are replaced with `***` by position (so a short cookie value cannot corrupt other strings in the output). History, cassettes, and output all go through the same function
- With `guard.allowedHosts` or a proxy configured, a `Host` header that differs from the URL is refused; with a proxy configured, hop-by-hop headers are refused too (so a request cannot reach a virtual host outside the allow-list)
- File inputs (`bodyFile`, multipart `file`, `--body @file`) are read through a descriptor opened with `O_NOFOLLOW` and then verified, and have a size limit. Response bodies and SSE streams have a limit too (`http.maxResponseBytes`, 100 MiB by default); a step that exceeds it ends as `error`
- OAuth2 `token_type` and `access_token` are refused if they contain control characters. Comparison matchers on headers (`gt` and so on) treat only decimal notation as a number

## 0.28.1

Hardened snapshots and OpenAPI validation (a response to an adversarial review). Also added snapshot approval and the new run results to the UI.

- UI: snapshot approval (`GET /api/snapshots/mismatches` / `POST /api/snapshots/accept`; runs against a protected environment are refused), and the snapshot and OpenAPI verdicts, warnings, and redirect routes shown in the runner and in history. `run.openapi` from `klaus.config.yaml` also applies to runs started from the UI. `GET /api/history` omits the candidate used for approval (`candidate`), and the accept API refuses paths containing a backslash
- **Behaviour change: where the UI's "Save as flow" may write is an allow-list.** Only under `api/` and `flows/`, or in a directory that already contains flows (case and Unicode differences cannot be used to get around it). Anything else is refused

- Snapshots: the OpenAPI check now runs first, and a response that failed it is never recorded as a baseline. If another assertion of the same step failed, neither `-u` nor `klaus snapshot accept` (new failure kind `failed-step`) records it. The `snapshot list --json` items gain `otherAssertionsFailed`. A history candidate is validated with the same shape as a baseline entry (`corrupt`), and a baseline or response nested deeper than 200 levels no longer crashes: exit 2 for a baseline, a failed snapshot assertion for a response
- Unambiguous keys: the name of a step with `assert.snapshot` cannot contain ` :: ` or end with ` #<number>` (a definition error, exit 2). Duplicate keys are also a definition error
- File safety: a FIFO or device at the baseline path no longer hangs the run (lstat, regular-file check, non-blocking open). A symbolic link anywhere from the flow directory down to the baseline is refused for reads and writes, and so is a `__snapshots__` below a hidden directory such as `.git/`. Error messages no longer print absolute paths outside the current directory
- Concurrent writes: a baseline is written under a lock file, re-reading the file just before writing, so runs that write different keys to the same file no longer lose each other's keys. It is now documented that runs started from the UI do not read `CI` (only `klaus run` does)
- OpenAPI: schema validation runs in a worker thread with a 3-second budget per response (a `pattern` such as `^(a+)+$` can no longer hang the run; on timeout the response is `skipped` with a warning, and a failure under `--openapi-strict`). The worker ships as `dist/openapi-worker.js` (added to `files`, no new dependency). `OpenApiValidator.check()` is now async, and `close()` and `validationTimeoutMs` were added
- OpenAPI: YAML is parsed without emitting warnings (a warning can include a line of a referenced file; the same applies to every `yaml` parse in the repository). A `$ref` target must stay inside the directory of the document (judged by real path), and is refused with one message that does not distinguish a missing file from a forbidden one. A schema with an unresolved `$ref`, a cycle without a body, or `$dynamicRef` is `skipped` rather than `valid` (a failure under `--openapi-strict`)
- OpenAPI: a server variable whose default contains `/` matches several segments. YAML merge keys, a required `writeOnly` property inside an `allOf` branch, `nullable` in 3.1, an empty body against a declared body, `.` / `..` segments, and deep bodies against recursive schemas (no `RangeError`) are handled correctly. `--openapi-coverage-min` accepts only a decimal 0-100 (`0x10` and the like are refused)
- Decisions: (1) the time budget is implemented by running the bundled Ajv in a worker, because a synchronous regular expression cannot be interrupted. A schema that timed out is never evaluated again in that run. (2) The lock gives up after 10 seconds, and a lock older than 30 seconds is ignored. (3) `nullable` in 3.1 is not converted but warned about, since it is not a 3.1 keyword

## 0.28.0

Added OpenAPI response validation and coverage (`klaus run --openapi`). Without changing any flow, every HTTP response is checked against an OpenAPI 3.0 / 3.1 document, and the run reports which operations it exercised.

- Documents are local YAML / JSON files only (repeatable; `run.openapi` in `klaus.config.yaml` is the default, with relative paths resolved from the config file). A `$ref` to another local file is resolved (`.yaml` / `.yml` / `.json` only, up to 8 MiB per file, 32 MiB and 100 files in total), and a remote `$ref` is refused. Circular references are stopped by visited tracking, and every `$ref` is checked before anything runs. An unreadable or invalid document exits 2 and runs nothing, and the error never includes the contents of a referenced file
- A request is matched to an operation by the server URL prefix (with variables; `--openapi-base-url` adds one), the path template, and the method, preferring concrete paths over templated ones. A request that matches nothing is only reported as `unmatched` and does not fail by default. `--openapi-strict` makes unmatched requests, status codes the document does not describe, and responses that cannot be validated into failures
- A matched response is checked for its status (exact, then `2XX`, then `default`), required headers, content type, and body (JSON Schema validation with the bundled Ajv, 2020-12). Violations are an assertion of `kind: "openapi"` with a location and a JSON Pointer, at most 20 kept, and fail the step (exit 4). Values from the response are never echoed in a violation
- For 3.0 schemas, `nullable` and boolean `exclusiveMinimum` / `exclusiveMaximum` are converted. `format` is not validated (an unknown format never fails). A `writeOnly` property is not required in responses. `discriminator` / `xml` / `externalDocs` / `example` are ignored as annotations, and `$dynamicRef` / `$recursiveRef` are ignored with a warning. A schema that cannot be compiled is a warning and the response is not validated. Schemas are compiled once per run, lazily per operation
- Coverage (the `openapi` summary) lists the number of operations and how many were matched, the observed status codes, the uncovered operations, the unmatched requests, and the steps that are not validated (SSE, WebSocket, and steps that followed redirects), in the JSON, text, HTML, and GitHub outputs. A run of only some flows (`--tags`) is labelled `partial`. `--openapi-coverage-min <percent>` fails the run (exit 4) when coverage is below it, even if every step passed
- It works with `--jobs`, `--data`, and `--replay`. `--dry-run` validates nothing and reports only the "planned" coverage from the expanded URLs (`--openapi-strict` and `--openapi-coverage-min` cannot be combined with it). Request validation (parameters and request bodies) is not done; matching and validation are separate, so it can be added later
- Decisions: (1) documents are loaded by our own code instead of `@apidevtools/swagger-parser`, to control what a `$ref` may point to (extension, file count, size), to keep contents out of errors, and to own the 3.0 to 2020-12 conversion. (2) Unmatched requests and undocumented statuses do not fail by default, because specifications often lag the implementation and failing would block adoption. (3) A step that followed redirects is not validated and is reported as excluded, since its response is not for the first request. (4) When coverage is below the minimum, the run status becomes failed, so the JSON `status` and the exit code do not disagree

## 0.27.0

Added snapshot assertions (`assert.snapshot`): a response is stored as a baseline and compared on later runs.

- The baseline lives in `__snapshots__/<flow file name>.snap.json` next to the flow file, as pretty-printed, key-sorted JSON (so it diffs well in git). The key is the step name plus the `--data` iteration and `name`. The comparison is a structural JSON diff (the same engine as `klaus diff`), and `ignore` uses the same grammar as `klaus diff --ignore-path`. Matching values are stored as the fixed placeholder `"[ignored]"` so the baseline does not churn
- **Secrets** are compared and stored after the same masking as history, so a declared secret never lands in a file meant to be committed. `--no-mask` does not affect snapshots. Values that are not declared secrets (personal data in a body, for example) are stored, so `ignore` and a review before committing are needed
- A missing baseline is written (and passes) on a local run, but **fails in CI (the `CI` environment variable is truthy, or `--ci`)** instead of recording (the Jest / insta policy, so CI never records silently). A mismatch fails with a structural diff (exit 4). `-u` / `--update-snapshots` rewrites, adds, and removes obsolete entries. `-u` cannot be set in `klaus.config.yaml` and cannot be combined with `--dry-run`, `--replay`, or `--ci`
- Decisions: (1) baselines are written once at the end of the run, because `--jobs` and `--data` iterations touch the same file, and this avoids races and half-written files. (2) `--replay` compares but never writes (a replayed response is not what the real API returns now). (3) Implicit new baselines are refused when the run targets a protected (`$protected`) environment without `-u`, so production data does not end up in a committed file. (4) A response whose step failed other assertions is not made a baseline implicitly. (5) Obsolete entries are judged only when every step of the flow ran, so a run that stopped on a failure cannot delete baselines. (6) A corrupt snapshot file exits 2 before anything runs and its content is never printed (even if a hostile link points at an unrelated file)
- Writes are confined to a `__snapshots__` directory inside the cwd, with `findUnsafeSymlinkInWritePath` and O_NOFOLLOW, never through a symbolic link (the same policy as `klaus promote`); a temporary file is written and renamed
- History keeps a (masked) candidate on each snapshot assertion that needs approval. Core `listSnapshotMismatches` / `acceptSnapshot` and the CLI `klaus snapshot list|accept` write that candidate as the baseline without calling the API again. Approving from the UI is a later change that calls these functions
- Added run comparison to the UI (`GET /api/history/diff` and a compare panel in the history tab, with ignore paths) and "Save as flow" (`POST /api/history/promote`; new files only, never overwrites). `http` from `klaus.config.yaml` also applies to runs started from the UI
- The JSON output gains a top-level `snapshots` (totals and the files written), and snapshot assertions carry `state` / `snapshotKey` / `snapshotFile` / `differences` / `differenceCount`. The candidate used for approval is not in the JSON output (it is a copy of the whole response)

## 0.26.0

Follow-ups to the run report (HTTP client).

- A step's `redirects` and `droppedHeaders` are now in the JSON output too (for any status, only on steps that have them). Text output shows them in the detail lines of `FAIL` / `ERROR`, and the HTML report shows them in the step detail (passed steps get a collapsed section)
- Added a top-level `warnings` to the JSON output (only when there is at least one). The `tls.insecure` warning used to appear only on stderr, so a CI that captures just the JSON on stdout never saw it. The stderr output is unchanged; text prints a `warning:` line before the summary, HTML shows a warnings box, and the GitHub summary shows a quote line. Warnings are de-duplicated across the whole run
- Added `Host` header validation to `klaus mock` (DNS-rebinding protection). When listening on loopback it accepts only `127.0.0.1` / `localhost` / `[::1]` paired with the listening port, and `--allow-host` permits extra host names
- The flow schema note printed by `klaus schema` described the request-body exclusivity as `body` / `graphql` only; it now also lists `form` / `multipart` / `bodyFile` (an omission from when 0.21.0 widened the exclusivity)

## 0.25.0

Added `klaus diff` and `klaus promote`.

### `klaus diff`

Compares two runs from history step by step (status, headers, a structural JSON diff or a line diff of the body, and request changes). It exits **4** when the runs differ (aligned with the "failure" meaning of an assertion failure in `run`), and 2 for an unknown run or invalid arguments. Volatile headers such as `Date` are excluded by default; add more with `--ignore-path` / `--ignore-header`. History stores secrets as `***`, so a change to a secret value does not show up in a diff.

### `klaus promote`

Turns runs from history into a re-runnable flow YAML with assertions inferred from the observed responses (`--assert status|schema|values|all`, default `schema`). Masked values cannot be reconstructed, so they become `{{env.TODO_*}}` placeholders that are listed in the output, and nothing is written if a `***` would remain in the result. An existing file is never overwritten without `--force`, and the output path must stay inside the current directory. The generated flow is schema-validated before it is written. When a distinctive value from an earlier response shows up in a later request, it is chained as a `capture` (`--no-chain` disables this).

## 0.24.0

Added `--report html` and `--report github`.

- `html`: a single self-contained HTML file with no external assets or JavaScript (default `klaus-report.html`). Failed and error steps are expanded by default
- `github`: for GitHub Actions. The Markdown job summary goes to `--report-file`, otherwise is appended to `GITHUB_STEP_SUMMARY`, otherwise is written to `klaus-report.md`; when `GITHUB_ACTIONS=true`, one `::error` annotation is printed per failed step. The summary is never written to stdout (so the machine-readable `--json` output stays intact)

## 0.23.0

Added `klaus mock <dir>`.

Starts a local HTTP server that only serves the cassette recorded with `klaus run --record <dir>`. It never forwards anything to the network, and an unmatched request gets a 404 (with `closest` recorded paths, but never a recorded body). Matching is on **method + path + query** (the recorded host is dropped; this is where it differs from replay, which matches the full URL). It binds to `127.0.0.1` by default, on port 4885 so it does not collide with the UI (4884). Options: `--cors` / `--delay` / `--ignore-query` / `--sequence` / `--origin` / `--json`. A missing, invalid, or empty cassette exits 2. Secrets masked at record time are served as `***` and are not restored.

## 0.22.0

Extended capture and assertions.

- `capture` accepts `{header}`, `{cookie}`, `{regex, group?}`, and `{status: true}` (a string is still a JSONPath). A cookie capture looks the value up in the cookie jar for the final URL, and becomes an `error` with guidance when there is no jar. A capture `error` message never includes the captured value or the body (it may contain secrets)
- Header and body assertions gained `gt` / `gte` / `lt` / `lte` / `length` / `type` / `oneOf`
- `assert.status` accepts an array of numbers and the `"2xx"` form

## 0.21.0

Added request body forms.

- `request.form` (`application/x-www-form-urlencoded`), `request.multipart` (text and file parts), and `request.bodyFile` (sends a file's bytes as-is)
- Input files must stay inside the cwd (after resolving symbolic links); anything outside is recorded in history as a guard refusal. This keeps a flow written by an agent from uploading arbitrary files
- History and dry-run never keep file contents, only the file name and size
- `body` / `graphql` / `form` / `multipart` / `bodyFile` are mutually exclusive

## 0.20.0

Added authentication helpers.

- `request.auth` and the flow-wide `http.auth` (also allowed in `klaus.config.yaml` `http.auth`). The step wins, and `auth: none` disables an inherited one. `basic` / `bearer` / `oauth2` (client credentials)
- OAuth2 tokens are cached per run and fetched again once `expires_in` has passed. The token request goes through the same guards, proxy, TLS, and record/replay as any request, and never follows redirects
- Passwords, tokens, client secrets, the fetched access token, and the Basic base64 form are registered as secrets and masked in history, output, and dry-run. `--dry-run` shows `Authorization` masked and never fetches a token
- Combining it with a step that sets its own `Authorization` header is an error

## 0.19.1

Fixed review findings in `klaus req` and `--dry-run`.

- Fixed a crash when `--dry-run` combined `query:` with a host that comes from an earlier capture, and unresolved `{{name}}` is no longer percent-encoded. The unresolved-variable error now has the same message as at run time, and `undetermined` is reported only when the host name itself is unresolved
- Merging `query` no longer rebuilds the query written in the URL; it is kept as written (secrets containing `&` `+` `=` `/` were broken and only partly masked)
- The hint in the protected-environment refusal is chosen at the entry point, so `klaus req` and single requests from the UI no longer suggest `--allow-protected`
- Argument-combination errors (`--dry-run` with `--record`, `--json` with `--text` in `req`) now exit 1 like `run`
- On a cross-origin redirect, headers carrying a secret value are dropped in addition to credentials, and the dropped header names are recorded in the result and history
- A cookie's `Domain` attribute is always stored host-only and never shared across subdomains

## 0.19.0

Added a per-run HTTP client.

- `followRedirects` (default `false`) / `maxRedirects` (default 10) / `cookies` (default `false`) added to the flow's top-level `http:` and to `http:` in `klaus.config.yaml`. Redirects are handled in core one hop at a time, and **every hop is re-checked against `guard.allowedHosts` and protected environments**. Moving to another origin drops `Authorization` / `Cookie` / `Proxy-Authorization`, and the visited URLs are recorded in `redirects` in the result and history
- The cookie jar lives in memory only and is never persisted. Cookie values are masked as secrets. Because there is no public suffix list, the `Domain` attribute is accepted under conservative rules
- `http.proxy` and `http.tls` (`ca` / `cert` / `key` / `insecure`) decide where traffic goes and whom it trusts, so they can only be set in `klaus.config.yaml`. Writing them in a flow is a validation error (exit 2). There is no CLI flag, `klaus req` option, or UI parameter either. Proxy environment variables (`HTTP_PROXY` etc.) and undici's global settings are never read
- The same client settings apply to SSE and WebSocket. `tls.insecure` prints a warning on stderr for every run
- Added a `Dockerfile` (non-root) and a composite GitHub Action (`action.yml`) that runs `klaus run` and writes a job summary to the repository. Neither is published to a registry or the Marketplace

## 0.18.0

`klaus ui` now updates its history live.

- `GET /api/history/events` (SSE) announces changes in the history directory, and the UI re-fetches history when notified. Runs executed externally by the CLI or an agent show up automatically, with a new-entries badge while another tab is open
- The history list gained actor (`actor`) and environment (`env`) columns

## 0.17.0

Added `klaus run --dry-run`.

- Prints each step's expanded request (method, URL, headers, body) without sending anything. Variables that depend on an earlier capture stay as `{{name}}` and are listed in `unresolved`; a variable that is neither a capture nor in the environment is reported as the same error as at run time
- The `guard.allowedHosts` and protected-environment checks use the same path as a real run. If any step would be refused it **exits 3**, and an unresolved host is `undetermined`. `if` conditions are not evaluated and are shown as `conditional`
- History and cassettes are untouched, and combining it with `--record` / `--replay` / `--report` exits 2
- Added `klaus schema --target dry-run-report`

## 0.16.0

Added `klaus req`.

- `klaus req <method> <url>` sends a single request with no flow file. It goes through the same path as the UI's `POST /api/request` (`executeSingleRequest`), so guards, secret masking, and history recording work as in `run`. It is meant to replace `curl` during exploration, since `curl` bypasses the guards
- Output follows the same conventions as `run` (JSON when not a TTY, bodies truncated to 500 characters, with `historyRef`). Exit code: 0 whenever a response arrives (any HTTP status, since there are no assertions), 3 for a send error or a guard refusal, 2 for invalid input. `--allow-protected` is deliberately not provided
- `--body @<file>` only accepts files inside the current directory
- Added `klaus schema --target req-report`

## 0.15.0

Added guardrails. klaus is used by agents as well as humans, so this mechanically stops requests to the wrong destination and writes to environments that must be protected.

### Destination host allowlist (`guard.allowedHosts`)

Requests to any host not listed in `guard.allowedHosts` in `klaus.config.yaml` are refused. A refused step ends as `error` and the run exits with code 3. **There is deliberately no CLI flag to override it** (a per-invocation flag would let an agent lift the restriction imposed on it). If unset, there is no restriction, as before.

### Read-only mode for protected environments (`$protected: readonly`)

`$protected: readonly` in an environment file allows only `GET` / `HEAD` / `OPTIONS` (every other method and every WebSocket step is refused). A read-style request carrying a method-override header (such as `X-HTTP-Method-Override`) is refused as well. `--allow-protected` lifts it.

### Behaviour change: UI writes to protected environments are refused with 403

Writes from `klaus ui` to a protected environment (`$protected: true` / `readonly`), namely the environment `PUT` and saving via capture, are now **refused with 403**. If you were changing a protected environment's values through the UI, edit the environment file directly instead.

### Audit fields in history, and refusals recorded

History entries now record `env` / `file` / `actor` (`kind` is `human` / `agent` / `ci`, detected from environment variables) / `git`. A step refused by a guardrail is also kept in history, with the (masked) request that would have been sent and the refusal reason; nothing was actually sent. View them with `klaus history --fields env,file,actor,git`.

### `run --actor <name>`

An option that sets `actor.name` in history. `actor.kind` is still detected from the environment.

## 0.14.4

Mostly the move of the development environment to Node 26 / pnpm 12 and a bulk dependency update. The only change in runtime behaviour is the JSONPath engine upgrade below.

### Upgraded the JSONPath engine (jsonpath-plus) to v11

jsonpath-plus was upgraded from v10.4.0 to v11.2.2. Because it includes upstream bug fixes, **results change for some uncommon JSONPath expressions used in captures and assertions**. A differential test of 10.4.0 against 11.2.2 showed the following changes.

| Expression | Before | After |
|---|---|---|
| `$.data['a,b']` (a key containing a comma) | the value itself | `[value]` (an array) |
| `$.data['a','b']` | `undefined` | an array of both values |
| `$.data.list[0:0]` | the whole array | `undefined` |
| `$.list[?(@.id ?? 0)]` (`??` inside a filter) | threw | works |

Results for common forms such as `$.a.b`, `$['k']`, filters, `..`, `*`, and `.length` are unchanged. Review the expected values in your captures and assertions only if you use comma-containing keys or the `[0:0]` slice.

The supported runtime is Node.js `>=22.19.0` (`engines.node`). CI verifies both the floor, 22.19.0, and the latest, 26.

## 0.14.3

- History entries are now stored in the file for the **UTC date** of `startedAt` rather than the append time. This fixes entries dropping out of paging when the clock moves backwards, and `historyRef.date` disagreeing with the real file for steps that cross UTC midnight (the "local date" wording in the docs was also corrected)
- Loading a history page is faster: it reads from the newest file and stops early

## 0.14.2

No user-visible changes (only the biome config `$schema` was updated).

## 0.14.1

- History and cassette files are now created with owner-only permissions
- Fixed the UI capture API being able to overwrite the reserved key `$protected` (it is now refused)

## 0.14.0

- Migrated the UI's API layer to TanStack Query (no change in look or features; an internal restructuring that refetches the env after capture via cache invalidation)

## 0.13.5

No user-visible changes (extended the retention period of the CI npm-package artifact).

## 0.13.4

- Fixed drift between the agent-facing documentation (Agent Skill / `AGENTS.md` template) and the implementation, and added a test that detects such drift

## 0.13.3

- Brought the Agent Skill up to date with the v0.13 features (`--tags` / `--jobs` / `--data` / TAP, etc.)

## 0.13.2

- Fixed missing backslash escaping in TAP reports (a CodeQL finding). Compilation of user-supplied regular expressions was also consolidated in one place
- Documented that regexes in assertions are template-expanded
- Updated dependencies (eventsource-parser v4, the nanoid vulnerability fix). Added `minimumReleaseAge` to `pnpm-workspace.yaml` so freshly published versions are not resolved

## 0.13.1

Fixes from review feedback.

- Guaranteed the ordering of history queries
- The UI history view now shows the `--data` iteration number
- `--report-file` destinations are now checked for duplicates
- Fixed the comparison and quote validation of `if` conditions
- `envFilePath` is now resolved relative to the cwd

## 0.13.0

- Added `klaus run --jobs <n>`. Runs flows (files) in parallel, up to 32. Steps within one flow always stay sequential. Cannot be combined with `--record`

## 0.12.0

- Added the TAP reporter (`--report tap`)
- `--report` now accepts several formats at once, comma-separated (e.g. `junit,tap`). Pass `--report-file` the same number of times as formats, in the same order

## 0.11.0

- Added per-flow tag selection (`--tags` is OR; `--exclude-tags` excludes and takes precedence)

## 0.10.0

- Added `klaus run --data <path>`. Runs all the given flows once for each row of a JSON / YAML data file (data-driven, one iteration per row)

## 0.9.0

- Added the `if` condition to steps. A condition in a restricted syntax; when false, the step is skipped

## 0.8.0

- Added `continueOnError` to steps. Subsequent steps run even after a failure

## 0.7.0

- Added `klaus run --var key=value` (ad-hoc template variables; not masked as secrets) and `--env-file <path>` (an environment file at an arbitrary path)

## 0.6.0

- Added per-step `retry`. Retries failed / error steps and records the attempt count (`attempts`) in history
- Fixed terminal control-sequence injection and directory-boundary bypass via symbolic links (security). The text reporter and `history` output now sanitize flow and step names, and path resolution for environment files, `step.use`, and the server additionally checks boundaries on real paths. Because the check and the read are separate syscalls, a swap during execution (TOCTOU) cannot be prevented; this is documented as a known limitation

## 0.5.4

- Reported invalid values of `--port` / `--last` through `InvalidArgumentError` for cleaner errors
- Reorganized the documentation (added troubleshooting, grouped the sidebar, condensed the README). Added nested and array-index JSONPath examples for `capture`, and aligned the Agent Skill text with the implementation
- Overhauled `examples/` and `make verify` (samples for every flow type, and a single Docker verification path)

## 0.5.3

- Updated dependencies, eliminating the vulnerable vite 5 line

## 0.5.2

No user-visible changes (an internal refactor consolidating duplicated logic across all layers into shared helpers).

## 0.5.1

- Fixed mismatches between the documentation and the implementation, and made English the site's default locale. Updated the CLI `--help` pointers to match the docs restructuring

## 0.5.0

A large release: feature additions across the execution engine, the CLI, and the UI server.

- Added step references via `use:`. Reuses the request / assert of a single-step flow from another file (assertions are merged additively; cycles and the cwd boundary are checked)
- Added `$protected` environments. `$protected: true` in an environment file declares a protected environment, and sending is refused (exit code 3) without `--allow-protected`. The UI's environment API always isolates `$protected`
- Added `assert.bodySchema`. JSON Schema validation with ajv, returning one assertion result per violation
- Added record / replay. `--record <dir>` saves real requests to a masked cassette, and `--replay <dir>` replays them without the network (unrecorded requests exit with code 3; SSE / WebSocket are unsupported)
- Added `klaus generate` (generates flow scaffolds from OpenAPI)
- Made `run` / `ui` defaults configurable in `klaus.config.yaml`. Precedence is explicit CLI > config > built-in defaults. The JSON Schema is available via `klaus schema --target config`
- Added `-H, --host` and `--no-open` to `klaus ui` and made 4884 the default port. Token authentication and CSRF are always enforced for non-loopback hosts. Fixed the crash when no opener exists, making it usable in containers
- Added `klaus run --text` (choose text output even when not a TTY; mutually exclusive with `--json`)
- `validate` output now includes the YAML line and column
- Strengthened secret masking (URL-encoded and JSON-escaped variants are detected too; JSON output masks the object tree before serialization)
- Added the Agent Skill, a guide for operating klaus. Also updated the `AGENTS.md` template generated by `klaus init`
- Reorganized `examples/` into `api/` (single checks) and `flows/` (scenarios)

## 0.4.1

Security fixes.

- Fixed URL-encoded secrets slipping past the masking in history
- Fixed secrets leaking in report output, and control-character injection
- Environment files in untrusted ancestor directories (such as a `/tmp/environments/` another user can write to) are no longer loaded. For a candidate found above the cwd, the owner and other-writable bit are checked, and an untrusted one is refused with exit code 2 (POSIX only; group-writable is tolerated)

## 0.4.0

- Unknown keys and typos in flow YAML are now validation errors (exit code 2), by making every schema strict
- Generated and published JSON Schemas for flows and run reports, in the npm package and on the docs site. The `run --json` output (v2) is also a zod schema now, available via `klaus schema --target run-report`
- Unified CLI output in English, and added the docs URL, `klaus init`, and an exit-code summary to the end of `--help`. Unresolved-template errors now list the resolvable variable names (key names only)
- Introduced test coverage measurement and enforced lines 90% in CI

## 0.3.0

Features aimed at single-shot execution from agents and the UI.

- UI: added a single-request execution mode as the default screen (editing method / url / headers / query / body, and showing the result). Added a `query` field to `request`
- UI: added viewing and editing of environments (preserving YAML comments) with a key-value editor. Extended the CSRF check to POST / PUT / DELETE
- UI: added a capture endpoint that extracts a response value with JSONPath and saves it to the environment, plus a save-afterwards UI
- CLI: made the `run --json` output v2 (compact, failure-focused, truncated at 500 characters, with a `historyRef` for fetching the full record)
- CLI: added `klaus history` / `klaus history show`
- CLI: `klaus init` now generates `AGENTS.md` (a guide for agents)
- CLI: added `klaus validate` (validation with fix hints) and `klaus schema` (JSON Schema output)
- Added a note to the history list column header that the duration is the total of all steps
- Switched the publish list to explicit positive patterns and excluded sourcemaps from the npm package

## 0.2.0

- SSE events and skipped steps are now recorded in history, and secret values are masked
- `environments/` is now resolved by searching upward from the cwd
- Added `klaus init` (scaffold generation)
- Bundled runtime dependencies into `dist`, pinning the supply chain at publish time

## 0.1.1

No functional changes. First release that switches the npm publish path from manual publishing to GitHub Actions' Trusted Publishing (OIDC).

### Migrated the publish path to the OIDC pipeline

0.1.0 was published manually before the pipeline existed, so it carries no provenance attestation. From this release on, pushing a `v*` tag drives build → approval → OIDC publish, and npm attaches provenance automatically.

**Why the first release was manual**: npm's Trusted Publisher can't be configured for a package that doesn't exist yet (you can't even reach the settings screen until the package exists), so the very first publish had to be a local, interactive 2FA-authenticated publish. No tokens were ever created.

**Traps found during pre-publish verification**:

- Prefixing the `bin` path with `./` makes npm 11 treat it as invalid, and it **silently drops the `bin` entry and publishes anyway with only a warning**. That would have shipped a broken package where installing it produces no command
- Without a `default` (or `require`) condition in `exports`, CommonJS `require()` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. This has nothing to do with Node 24's `require(esm)` support — it fails at the resolution stage, before any file is even read
- Neither of these shows up under static analysis. They were only caught by actually installing the tarball in isolation and running `klaus --version` plus `require()` / `import()` against it

### Switched the license to Elastic License 2.0 (`773e8d6`)

Changed from MIT to ELv2. Use, modification, and redistribution remain free, but **offering this software to third parties as a hosted or managed service is prohibited**. I accepted, as a tradeoff, that this is no longer OSI-defined open source. The MIT version was never published or committed anywhere, so the switch was clean.

### Security design of the release workflow (`5667a99`)

The configuration that came out of adversarial review (two attack-lens passes, one legitimacy-lens pass).

- Every action is pinned to a commit SHA. pnpm is also pinned to an exact version (`version: 11` would fetch the latest 11.x at run time)
- Starts from `permissions: {}` and grants least privilege per job
- Separated the build job, which runs dependency code, from the publish job, which holds the OIDC token. The publish side does no checkout and no dependency install — it only publishes the already-verified tarball (`npm publish <tarball>` doesn't run lifecycle scripts)
- Deliberately left `registry-url` unset in `setup-node`. Setting it writes a `NODE_AUTH_TOKEN` placeholder into `.npmrc`, which can conflict with OIDC (actions/setup-node#1440, #1551)

**Something that has to be configured outside the YAML**: Actions runs the workflow as it exists at the commit the tag points to, so whoever can create a tag can run a tampered workflow along with it. The only thing that closes this is a repository ruleset restricting creation/update/deletion of `v*` tags. The `npm-publish` environment also needs to be created ahead of time — if it isn't, it gets auto-created with no protection, and the approval gate silently disappears.

## 0.1.0

### Migrated the UI to shadcn/ui (`df9de3d`)

Replaced hand-written CSS and custom components wholesale with shadcn/ui (style: new-york) + Radix primitives + Tailwind CSS v4.

- 11 components introduced: `badge` / `button` / `card` / `collapsible` / `progress` / `scroll-area` / `select` / `separator` / `skeleton` / `table` / `tooltip`
- Dependencies: 7 Radix packages plus `class-variance-authority` / `clsx` / `tailwind-merge` (`cn()`), with `lucide-react` for icons
- Tailwind v4 uses a CSS-first setup, so there's no `tailwind.config.js` — tokens are defined in an `@theme` block
- The source of truth for implementation tokens is [ui/docs/design-system.md](https://github.com/almondoo/klaus/blob/main/ui/docs/design-system.md), and for component structure it's [ui/docs/components.md](https://github.com/almondoo/klaus/blob/main/ui/docs/components.md)

See [ui-ux-design.md](ui-ux-design.md) for the intent and design direction of the migration.

### Fixed a bug where the environment (env) couldn't be changed while a flow was selected

**Symptom**: switching the env selector while a flow was selected snapped straight back to the original value — you couldn't actually change it.

**Cause**: the `useEffect` that initializes env in `ui/src/App.tsx` had `selectedEnv` itself in its dependency array, so the same effect re-fired on every user change and rolled it back to the initial value.

**Fix**: used `initializedEnvForPathRef` so initialization only happens when the flow itself changes, and the user's selection is never overwritten.

**Verification**: in a real browser, selected `development`, confirmed the value stuck, and confirmed the actual outgoing HTTP request carried the `development` value (`dev@example.com`) — checked in all three of the raw SSE response, the execution view, and the history.

### Fixed missing focus rings (a11y)

A regression introduced during the shadcn migration. **This stems from a Tailwind CSS v4 behavior, so writing `outline-none` again in the future can reintroduce the same trap.**

- In v4, `outline-none` **unconditionally** sets `--tw-outline-style: none`
- `focus-visible:outline-2` only sets the thickness and reads that same variable, so combined with `outline-none` **nothing renders even when focused**
- Fixed by adding `focus-visible:outline-solid`, which restores the style on focus

Fixed in `button` / `select`, then swept the codebase for the same pattern and found and fixed the identical bug in `scroll-area` as well. Verified visually via before/after screenshots comparing the focused and unfocused states.

### Dependency updates and security response

- Raised the Node.js floor to **`>=22.19.0`** (previously `>=20`)
- Updated commander 15 / undici 8 / zod 4 / vite 8 / vitest 4 / biome 2. The major version bumps required **no** code changes
- Resolved an esbuild vulnerability flagged by `pnpm audit` via `overrides` in `pnpm-workspace.yaml`

**Pitfall**: this override **must be pinned to an exact version**.

- A range (`">=0.28.1"`) is **silently ignored, with no warning**
- `pnpm.overrides` in `package.json` is not read by pnpm 11 — it prints `[WARN] The "pnpm" field in package.json is no longer read by pnpm`

```yaml
# pnpm-workspace.yaml
overrides:
  esbuild: 0.28.1   # A range doesn't take effect here
```

The security review of the code turned up zero findings at 80%+ confidence. Confirmed the UI's `dangerouslySetInnerHTML` escaping actually neutralizes attack payloads by sending real ones through it.

### Tightened tsconfig

Applied the full set of strict flags, including `exactOptionalPropertyTypes`. This surfaced 19 type errors, which I resolved by extending type definitions and adding real guards — not by papering over them with `!` (non-null assertion) or `as`.

### Added a port option to `klaus ui`

```bash
klaus ui -p 4400        # or --port 4400
```

When omitted, it still auto-selects a free port as before. See the [CLI reference](../../guide/cli.md) for details.

### Reworked the build setup

After hitting the accident three times where `pnpm build` took out `dist/ui` along with it and broke `klaus ui` with a 503, I disabled tsup's `clean` and moved to a setup where only the full release build empties `dist/` via `scripts/clean.mjs`.

- Confirmed by experiment that even a glob array (`clean: ["dist/*.js", ...]`) still wipes the whole outDir
- See the "Build" section of [architecture.md](architecture.md) for the full division of responsibility

### Documentation work

- Placed the UI design docs under `ui/docs/` (README / design-system / components). Everything in them is backed by the actual code, and in the process I found 7 discrepancies against the existing docs (icon library, focus ring color, etc.) and **corrected the docs to match the implementation, treating the implementation as ground truth**
- Added [Improvement proposals](improvement-proposals.md). Grounded only in things that actually happened, with a verdict (recommended / conditional / deferred) and a rough cost estimate on each item

### Verification results

| Item | Result |
|---|---|
| Clean full build (`pnpm build:all`) | Success (confirmed `dist/ui/index.html` was generated) |
| root tests (vitest) | 121 passed / 121 |
| ui tests (vitest + jsdom) | 10 passed / 10 |
| Type check (`pnpm typecheck`) | OK |
| Lint (`pnpm lint`) | 102 files, no fixes needed |
| `pnpm audit` | No known vulnerabilities found |
| CLI smoke test | Confirmed `--version` / `ui --help` (including the `-p` short form) work |

**Not verified**: couldn't run `npm pack --dry-run`, so I substituted by checking the contents of `dist/` directly for what gets bundled into publish (no stale artifacts remained since this was right after a clean build). Run this check when preparing an actual npm publish.

## Initial implementation (`4cc0495`)

Implemented M1–M3 of the requirements ([requirements.md](requirements.md)): the core execution engine, a CLI with an exit-code system, a localhost UI server (Hono) and SPA, GraphQL / WebSocket / SSE support, run history in JSONL, and the accompanying docs.

Notable bugs found and fixed during implementation:

- **A history write failure was corrupting the step result** — the `historySink` call was inside the main try/catch, so a disk error would turn an already-successful step into `status: "error"` and drop its capture. Moved the history write outside the try/catch, and failures are now reported to stderr via `onWarning` instead
- **A capture failure was propagating as the literal string `"undefined"`** — when a JSONPath didn't match, the value became `undefined`, which template expansion turned into the string `"undefined"`, resulting in sending `Authorization: Bearer undefined`. Fixed to throw a `RuntimeError` (exit 3) instead (a legitimate `null` still succeeds as before)
- **A client disconnect froze the SSE run forever** — `res.write()` on an already-torn-down response returns `false` and `'drain'` never fires, causing a deadlock. Raced it against `'close'` / `'error'`, made subsequent SSE writes no-ops, while **still running the flow to completion so history is preserved**
- **A WebSocket socket leak** — `fail()` wasn't closing the socket on a send failure. Consolidated into a shared `cleanup()`
- **Path traversal via `env`** (security) — `POST /api/runs` validated `path` but not `env`. Addressed with two layers: a boundary check on the core side and a 403 on the server side
- **Assertion expected values weren't going through template expansion** — found via manual E2E (<code v-pre>equals: "{{testEmail}}"</code> was failing because it never got expanded). Applied `renderDeep` to the `assert` block as well and added a regression test
