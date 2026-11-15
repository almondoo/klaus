# Execution History

klaus appends every request, response, and duration to a local JSONL file. The reason CLI text output stays a one-line summary on success is that full detail is offloaded here. The localhost UI's history browser also reads this file.

To inspect it directly from the CLI without the browser UI, use `klaus history` (list) / `klaus history show <runId>` (detail). See the [CLI Reference](cli.md#klaus-history) for the options.

## File Conventions

- Path: `.klaus/history/<YYYY-MM-DD>.jsonl` (**relative to the cwd**; the date is the UTC date of each entry's `startedAt`, i.e. the step's start time)
- The directory is created automatically
- Writing can be disabled with `klaus run --no-history`
- **A write failure does not affect the execution result** (only a warning is printed to stderr; step pass/fail is unaffected)

## Per-Line Schema (v: 1)

One line = one step execution. `runId` lets you group steps from the same run.

```jsonc
{
  "v": 1,                       // schema version
  "runId": "<uuid>",            // ID for the run unit (shared across all flows)
  "flow": "auth flow",          // flow name
  "step": "login",              // step name
  "startedAt": "2026-08-08T…",  // ISO 8601
  "durationMs": 6,
  "status": "passed",           // "passed" | "failed" | "skipped" | "error" (may be absent on older entries; see Operational Notes)
  "request": {                  // omitted for skipped steps
    "method": "POST",
    "url": "http://…",          // template-resolved (secrets masked)
    "headers": { … },           // template-resolved (secrets masked)
    "body": { … }
  },
  "response": {                 // omitted for skipped steps
    "status": 200,
    "headers": { … },
    "body": { … }               // the parsed value if JSON, otherwise text
  },
  "events": [                   // present only for SSE steps (received events)
    { "event": "message", "id": "1", "data": "…" }
  ],
  "assertions": [
    { "ok": true, "kind": "status", "expected": 200, "actual": 200, "message": "…" }
  ],
  "error": "…",                 // only when status is "error" (a guardrail refusal, or a step that failed after receiving a response): the reason
  "errorCode": "guard.allowed-hosts",  // optional, only with error: see Error Codes
  "env": "local",               // optional: see Audit Fields
  "envProtection": "protected", // optional: only for a protected environment, see Audit Fields
  "envSource": "file",          // optional: only when the environment came from --env-file, see Audit Fields
  "file": "api/auth-flow.yaml", // optional
  "actor": { "kind": "agent", "name": "claude-code" },  // optional
  "git": { "commit": "<sha>", "dirty": false }          // optional
}
```

### Content by Step Type

| Type | request | response | events |
|---|---|---|---|
| HTTP / GraphQL | method / url / headers / body | status / headers / body | — |
| SSE | as usual | status / headers, **body is undefined** | array of received events (`{event?, id?, data}`) |
| WebSocket | method is `"WS"`, body is the array of sent messages | status is fixed at `101`, body is the array of received messages (data strings) | — |
| skipped | omitted | omitted | — |

**Skipped steps are recorded too** (`status: "skipped"`, no request/response, empty assertions). Steps that ended in `error` are recorded in two cases only. A step refused by a guardrail (`guard.allowedHosts`, or `$protected`) is recorded for auditing, with `status: "error"`, the masked request that would have been sent, the refusal reason in `error`, and the audit fields. A step that **received a response** and then failed (a failed `capture`, a JSONPath capture on a body that is kept as text, an error while checking the response) is recorded with `status: "error"`, the request, the response, and the `error` message. Errors before or without a usable response are not recorded: a connection error, a timeout, a network error in the middle of the body, a response that exceeds `http.maxResponseBytes`, and a template that cannot be expanded.

A JSON response nested deeper than 200 levels is kept as text (a string `body`, with `bodyTooDeep: true` on the recorded `response`) instead of being parsed. JSONPath captures, `body` path assertions, and `bodySchema` on such a response fail with an explicit message; `bodyText` assertions and `regex` captures still work.

**Snapshot results** are recorded as an assertion with `kind: "snapshot"` and a `snapshot` object: `key`, `file` (the snapshot file), `state` (`matched` / `written` / `updated` / `mismatch` / `missing`), and, for a mismatch, `differences` (at most 20) and `differenceCount`. A `mismatch` or `missing` result also keeps `candidate`, the masked `{ status?, headers?, body }` that would be written as the baseline. `klaus snapshot accept <runId>` writes exactly that candidate, so accepting a change never calls the API again ([klaus snapshot](cli.md#klaus-snapshot)). The candidate is built after the same secret masking as the rest of the entry. Because it is a full response copy, `klaus history` (list) never prints it, and `klaus history show <runId>` omits it unless `--step` is given.

Newly written entries always include `status`. Older entries without a `status` field can still be read by deriving pass/fail from `assertions`, as before (backward compatible).

## Error Codes

A step that ends as `error` carries a free-text `error` message in English. When the cause is one of the cases below, it also carries a stable `errorCode` that tools can rely on instead of matching the message. The field is optional and additive, so `v` stays 1; errors that have no code (a connection failure, a timeout, an unresolved template variable, and so on) leave it out.

| `errorCode` | Cause |
|---|---|
| `guard.allowed-hosts` | The target host is not in `guard.allowedHosts` (also when the URL cannot be parsed while the allowlist is set) |
| `guard.protected` | The environment is `$protected: true` |
| `guard.readonly` | The environment is `$protected: readonly` and the method is not `GET` / `HEAD` / `OPTIONS` (WebSocket steps included) |
| `guard.method-override` | The environment is `$protected: readonly` and the request carries a method-override header |
| `guard.host-header` | The `Host` header differs from the URL's host, or is not a valid host |
| `guard.proxy-header` | A hop-by-hop or other forbidden header was set while `http.proxy` is in use |
| `guard.path` | A file outside the current directory was referenced (`bodyFile`, `multipart` files, snapshot files) |
| `guard.redirect` | A redirect hop was refused by a guard that has no more specific code (see below) |
| `response-too-large` | The response (or SSE stream) exceeded `http.maxResponseBytes` |

- **Redirects**: when a hop of a redirect chain is refused, the more specific code of that refusal is kept (a hop to a host outside the allowlist is `guard.allowed-hosts`, not `guard.redirect`). `guard.redirect` is used only when the refusal itself has no code of its own.
- **Where it appears**: `errorCode` sits next to the error message wherever it is reported: each `error` step in `klaus run --json`, `klaus req --json`, `guard.errorCode` of a refused step in `klaus run --dry-run --json`, the history entry, and the UI server's responses. It is not added to summary-only output.
- **In history**: `error` entries are guard refusals and steps that failed after receiving a response. The latter usually have no `errorCode` (a failed capture has none), so the `guard.*` codes are the ones that appear in a history file. `response-too-large` is reported in the run output and the UI only.

## Audit Fields

Six optional fields record where a run came from. They are additive, so `v` stays 1, and entries written before they existed simply lack them.

| Field | Content |
|---|---|
| `env` | Environment name. With `--env-file`, the file's basename. Omitted when no environment is used |
| `envProtection` | `"protected"` (`$protected: true`) or `"readonly"` (`$protected: readonly`). Set on every entry written while a protected environment was loaded, whether chosen by name or with `--env-file`, from every entry point (CLI, `klaus ui`, `klaus mcp`) and including guard-refusal entries. Absent for unprotected environments, runs without an environment, and entries written before the field existed. `klaus mcp` uses it: `klaus_promote` refuses such runs, and the history tools withhold the request and response of such entries when the environment's values cannot be obtained for masking (see [MCP Server](/guide/mcp)) |
| `envSource` | `"file"` when the environment was loaded from an `--env-file` path (all entry points); absent for environments chosen by name. `env` then holds only the file's basename, so a file without an extension (`secrets/ro`) looks like the named environment `ro`; this field keeps the two apart. `--env-file environments/ro.yaml` also counts as a file (`env` is `ro.yaml`). `klaus mcp` never resolves such an entry by name |
| `file` | Flow file path relative to the working directory (POSIX separators). Omitted for single requests |
| `actor` | `{ kind, name? }`. `kind` is `human`, `agent`, or `ci`, detected from the environment: the agent markers `CLAUDECODE` / `AI_AGENT` first, then `CI`, otherwise `human`. `klaus run --actor <name>` / `klaus req --actor <name>` sets `name` (the `kind` is still detected). Runs from `klaus ui` record `human` |
| `git` | `{ commit, dirty }`: `HEAD` at run time, and whether tracked files have uncommitted changes (untracked files are ignored). Omitted when git is unavailable |

View them with `klaus history --fields env,envProtection,envSource,file,actor,git` or `klaus history show <runId>`.

## Comparing Runs

`klaus diff <runA> <runB>` compares two recorded runs step by step. Use it after changing the API (or the flow) to see exactly what moved in the responses.

### Choosing the Runs

- Two run IDs (exact match, like `klaus history show`).
- `latest` and `previous` together with `--flow <name>`: the most recent run that contains that flow, and the one before it. `latest` / `previous` without `--flow` is an error, because single requests and other flows would make the baseline ambiguous.
- `klaus diff --flow <name>` with no run IDs compares `previous` (A) with `latest` (B).

With `--flow`, both runs are narrowed to that flow's steps. Steps are paired by flow name, step name, and iteration (for `--data` runs); a step that exists in only one run is reported as `added` (only in B) or `removed` (only in A).

### What Is Compared

| Aspect | Reported when |
|---|---|
| `status` | the step status changed (`passed` / `failed` / `skipped` / `error`) |
| `httpStatus` | the HTTP status code changed |
| `responseHeaders` | headers were added, removed, or changed (names are case-insensitive) |
| `body` | the response body differs |
| `request` | the request itself differs: `method`, `url`, and `body` (headers are not compared) |
| `events` | SSE events differ |
| `error` | the recorded error message (a guard refusal, or a failure after a response) differs |
| `durationMs` | only with `--duration-threshold <ms>`, when the duration changed by more than that many milliseconds |

A request change is reported in `request`, separately from `body` / `httpStatus`, so "the request itself changed" is distinguishable from "the response changed". When one side has no request or response (a skipped step, or a guard refusal), only `status` and `httpStatus` are reported for that step. An `error` step that did receive a response is compared like any other step.

JSON bodies get a structural diff: a list of `{ path, kind, before, after }` where `path` is JSONPath-like (`$.items[0].name`) and `kind` is `added`, `removed`, `changed`, `type-changed`, or `too-deep`. Objects are matched by key (key order is irrelevant); arrays are compared index by index, so they are order-sensitive and a length difference shows up as `added` / `removed` entries. Bodies that are not JSON get a line-based summary (`added` / `removed` line counts and the changed lines).

Response headers in the default ignore list are not compared: `date`, `age`, `content-length`, `server-timing`, `x-request-id`, `x-correlation-id`, `request-id`, `x-trace-id`, `x-amzn-trace-id`, `x-amz-request-id`, `x-amz-id-2`, `traceparent`, and `cf-ray`. `etag` is deliberately not in the list; add it with `--ignore-header etag` when it is noise for you.

### Ignoring Volatile Values

| Option | Effect |
|---|---|
| `--ignore-header <name>` | exclude one more response header (repeatable, case-insensitive) |
| `--no-default-ignores` | compare the headers in the default ignore list too |
| `--ignore-path <jsonpath>` | exclude a path from JSON body comparisons (repeatable). Applies to response bodies, request bodies, and SSE events |
| `--duration-threshold <ms>` | include duration changes larger than this |

`--ignore-path` accepts a small JSONPath subset: `$.id`, `$.items[0]`, `$.items[*].createdAt` (also `$.items.*.createdAt`), `$['odd-key']`, and `$..updatedAt` (at any depth, with at most 2 `..` operators per path). A path that matches a node also excludes everything under it. An expression outside this subset is an argument error (exit 1).

The comparison is iterative, so deeply nested bodies do not overflow the stack: below 256 levels it reports ordinary differences, and a subtree nested deeper than that is compared for equality only and reported as a single `too-deep` difference (without values) when it differs. Values in a difference that are nested deeper than 100 levels are replaced by the string `[too deep to display]`.

### Output and Exit Codes

The output is JSON by default when stdout is not a TTY and text on a TTY; `--json` / `--text` force one. Each step carries `change` (`same`, `different`, `added`, `removed`); steps that are `same` are listed compactly. Text mode prints only the steps that differ.

```jsonc
{
  "version": 1,
  "status": "different",               // "same" | "different"
  "runs": { "a": { "runId": "…", "flows": ["login and fetch"], "startedAt": "…", "steps": 2, "status": "passed", "env": "local", "actor": { "kind": "agent" }, "git": { "commit": "…", "dirty": false } }, "b": { … } },
  "counts": { "same": 1, "different": 1, "added": 0, "removed": 0 },
  "steps": [
    { "flow": "login and fetch", "step": "login", "change": "same" },
    {
      "flow": "login and fetch", "step": "get-me", "change": "different",
      "status": { "a": "passed", "b": "failed" },
      "body": {
        "kind": "json", "total": 2, "omitted": 0,
        "differences": [
          { "path": "$.plan", "kind": "changed", "before": "pro", "after": "free" },
          { "path": "$.extra", "kind": "added", "after": { "beta": true } }
        ]
      }
    }
  ]
}
```

To keep the output bounded, each step keeps at most `--max-differences <n>` differences per section (default 50; the rest is counted in `omitted` and shown as "and N more" in text). Values are complete in JSON unless `--max-value-length <n>` is given; text mode truncates values to 80 characters unless you set it.

| Exit code | Meaning |
|---|---|
| 0 | no differences |
| 4 | differences found (parallel to an assertion failure in `klaus run`) |
| 1 | invalid arguments (conflicting flags, a bad `--ignore-path`, `latest` / `previous` without `--flow`), an unknown run ID or no matching `latest` / `previous` (as with `klaus history show`), or an unexpected error |

History stores secrets as `***`, and `***` compares equal to itself, so a change to a secret value is not visible in a diff.

## Promoting Runs to a Flow

`klaus promote <runId...>` turns recorded history into a flow YAML you can re-run, with assertions inferred from the observed responses. The intended loop: explore an API with `klaus req` or an assertion-free flow, `klaus promote` the evidence into a regression test, then `klaus diff` after the API changes.

```
klaus promote <runId...> [-o <path> | --stdout] [--force] [--assert status|schema|values|all]
                         [--base-url-var <name>] [--no-chain] [--name <name>] [--flow <name>] [--json|--text]
```

### Output File

- The default path follows the repository convention: `api/<name>.yaml` for a single step, `flows/<name>.yaml` for several. `<name>` is the flow name as a slug. `-o, --out <path>` overrides it.
- The path must resolve inside the current directory. Symbolic links are checked one component at a time: a symbolic link as the final component is always refused (even if it points inside the directory, and even with `--force`), and a symbolic link in a parent directory is allowed only when it exists and points inside the current directory (a dangling one is refused). The file is opened with `O_NOFOLLOW`, so a link swapped in after the check is not followed either (a narrow race on parent directories remains). These refusals are exit 2.
- An existing file is never overwritten (exit 2) unless `--force` is given.
- `--stdout` prints the YAML instead of writing a file; the summary then goes to stderr.
- The file starts with the same `$schema` comment as `klaus init` / `klaus generate`, followed by comments that list the placeholders to fill, the values for the environment file, and the inferred captures. The YAML is validated (`klaus validate` rules) before it is written.
- Several run IDs are concatenated in the order given (for example, one `klaus req` run per step). A run that contains several flows needs `--flow <name>`. For a `--data` run, only the first iteration is promoted. Steps that started in the same millisecond keep the order in which they were written to the history file.
- The file starts with a `NOTICE` comment (and the command prints the same notice): it was generated from recorded traffic, so review it for sensitive data before committing. Recorded request values that look sensitive are replaced by placeholders (see below).

### Request Reconstruction

- One step per recorded step, in recorded order, with `method`, `url` (the query string stays in the URL), `headers`, and `body` as recorded. Single requests (flow `(single)`) are named `<method>-<last path segment>`, and duplicate names get `-2`, `-3`, ...
- Hop-by-hop and computed headers are dropped: `content-length`, `host`, `connection`, `keep-alive`, `transfer-encoding`, `te`, `trailer`, `upgrade`, `proxy-connection`.
- A masked value (`***`) cannot be reproduced. Every `***` in a URL, header, or body string becomes <code v-pre>{{env.TODO_*}}</code>, so the file never contains a literal `***`. The name is derived from the location: header `Authorization` becomes `TODO_AUTHORIZATION`, body path `$.user.password` becomes `TODO_BODY_USER_PASSWORD`, query parameter `api_key` becomes `TODO_QUERY_API_KEY`, the third URL path segment becomes `TODO_URL_PATH_3`; a second `***` in the same value gets a `_2` suffix. The same location produces the same name in every step. Set these as OS environment variables before running; the command output lists them.
- `--base-url-var <name>` replaces the origin of every URL with <code v-pre>{{name}}</code> (further origins become `name_2`, `name_3`, ...) and prints the values to put in the environment file. By default URLs stay literal.
- SSE steps become request-plus-`sse: {}` steps that assert only the status. WebSocket steps, skipped steps, and steps that ended in `error` (a guard refusal has no response, and a step that failed after its response is not turned into a baseline) are skipped, and the output says why.
- A recorded request value (URL, query, header value, or body string) that contains a literal <code v-pre>{{</code> is refused (exit 2, naming the step and location). klaus has no escape syntax for <code v-pre>{{</code>, so such a value would be expanded as a template when the flow runs, and a value such as <code v-pre>{{env.SECRET}}</code> echoed by a hostile server would send an OS environment variable to the next request's destination. `--allow-template-literals` emits them anyway and lists each location in a warning (output, `notes`, and a comment at the top of the file). Placeholders and captures that `klaus promote` generates itself are not affected.
- Masked shapes that cannot be reproduced: a `***` inside a query element without `=` (`?***`) becomes `TODO_QUERY_PARAM`; a masked body key, header name, or query parameter name is refused (exit 2) with its location.
- A request body nested deeper than 100 levels is refused.

#### Sensitive values stored unmasked

History masks only values resolved through <code v-pre>{{env.X}}</code>; values from environment files, `--var`, and captures are stored as they are. To keep them out of the generated file, request values are replaced by <code v-pre>{{env.TODO_*}}</code> placeholders (same naming as above, listed in `placeholders` and in `redacted` with a reason) when:

- they sit under a sensitive key (matched case-insensitively against `token`, `secret`, `password` / `passwd` / `pwd`, `credential`, `signature`, `cookie`, `bearer`, `session`, `key` (so `apiKey` / `api_key`), or `auth` (not `author`); any ancestor key counts), a sensitive header name (`authorization`, `cookie`, `x-api-key`, `x-auth-*`, `proxy-authorization`, or anything matching the pattern), or a sensitive query parameter name. For `Authorization` and `Proxy-Authorization` a `Bearer` / `Basic` / `Digest` / `Token` / `ApiKey` scheme prefix is kept; or
- they look like tokens: a JWT, a known key prefix (`sk_`, `pk_`, `rk_`, `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_`, `github_pat_`, `xox*-`, `AKIA...`, `AIza...`), or a string of 32+ characters with high entropy (UUIDs are not treated as tokens).

A value supplied by an inferred capture is not replaced (it is already a <code v-pre>{{name}}</code> reference). Check the generated file anyway: the heuristics cannot recognize every secret.

### Inferred Assertions

`--assert` chooses the strictness. Each mode always includes `assert.status` equal to the observed status.

| Mode | Adds |
|---|---|
| `status` | nothing else |
| `schema` (default) | `content-type` header `contains` the observed media type, and a `bodySchema` for JSON bodies |
| `values` | the `content-type` matcher, and `body` `equals` matchers for stable scalar leaves |
| `all` | both of the above |

Rules, all deterministic:

- `bodySchema` is inferred from the observed value: types and required keys only. Every key present is required, `additionalProperties` is not restricted, and there is no `enum` or `const`. Numbers are typed `number` (JSON cannot tell `10` from `10.0`). Arrays are typed by their first 100 items merged: a key is required only if every item has it, and mixed item types become `anyOf`.
- `body` equals matchers are never generated for values under sensitive keys (see above) or for token-like values. They cover only scalar leaves that look stable: booleans, integers with an absolute value of at most 1000, and short enum-like strings (letters, digits, `_`, `-`; at most 32 characters, at most 3 digits). Arrays are traversed up to index 4; at most 20 matchers per step.
- Excluded as volatile: strings containing `***`, UUIDs, strings containing a date (`YYYY-MM-DD`), digit strings of 8 or more digits, hex strings of 16 or more characters, long token-like strings, JWTs, and values under keys such as `id`, `*_id`, `*Id`, `*_at`, `*At`, or names containing `token`, `secret`, `uuid`, `hash`, `etag`, `timestamp`, `expires`, `created`, `updated`, `password`, `session` (booleans are not excluded by key name).
- A body that is not JSON is asserted by status and content-type only (the output notes it).

### Chained Values

Unless `--no-chain` is given, a scalar from an earlier step's JSON response that reappears verbatim in a later request becomes a `capture` on the earlier step and a <code v-pre>{{name}}</code> reference in the later one. It is deliberately conservative:

- The value must be a UUID, or at least 8 characters containing a digit (20 or more characters need no digit). Numbers qualify with 8 or more digits.
- It must match a whole URL path segment, a whole query value, a whole header value (or the last space-separated token, as in `Bearer <token>`), or a whole string or space-separated token inside a body string. Numbers inside a JSON body are never replaced, because a template always renders a string. The origin is never replaced.
- A value that already appears in a request at or before the step that produced it is treated as user-supplied and is not chained.
- If several earlier steps contain the value, the closest one is used. Capture names come from the JSON key (`$.token` becomes `token`); a collision, or a key named like a template function or namespace (`newUuid`, `newDate`, `newTimestamp`, `env`), is resolved by prefixing the step name.

Every inferred link is listed in the output and in a comment at the top of the file, so you can verify it.

### Output and Exit Codes

The summary is JSON when stdout is not a TTY and text on a TTY (`--json` / `--text` force one).

```jsonc
{
  "version": 1,
  "status": "ok",
  "written": true,
  "file": "flows/login-and-fetch.yaml",
  "flow": "login and fetch",
  "assert": "all",
  "steps": [ { "name": "login", "method": "POST", "url": "{{baseUrl}}/login", "from": { "runId": "…", "flow": "login and fetch", "step": "login" } }, … ],
  "placeholders": [ { "name": "TODO_X_API_KEY", "locations": ["step \"login\": header x-api-key"] } ],
  "variables": [ { "name": "baseUrl", "value": "http://127.0.0.1:47831" } ],
  "captures": [ { "name": "token", "from": { "step": "login", "path": "$.token" }, "used": [ { "step": "get-me", "location": "header \"authorization\"" } ] } ],
  "skipped": [],
  "redacted": [ { "name": "TODO_AUTHORIZATION", "location": "step \"get-me\": header authorization", "reason": "sensitive key" } ],
  "templateLiterals": [],
  "notes": [],
  "notice": "Generated from recorded traffic: review this file for sensitive data (tokens, passwords, personal data) before committing it."
}
```

| Exit code | Meaning |
|---|---|
| 0 | the flow was generated (and written, unless `--stdout`) |
| 1 | invalid arguments, an unknown run ID, a run with several flows and no `--flow` (as with `klaus history show`), or an unexpected error |
| 2 | the output file already exists, an output path outside the current directory or through an unsafe symbolic link, nothing promotable, a recorded value containing a literal <code v-pre>{{</code> (without `--allow-template-literals`), a masked value that cannot be reproduced, or a generated flow that is invalid |

## Versioning Contract

The history JSONL is a **contract** read by the localhost UI (and future tools), and evolves under the following rules:

- A change that doesn't bump `v` may **only add fields** (additive). Removing an existing field, or changing its meaning or type, requires a version bump
- Readers ignore unknown fields, and skip lines with an unknown `v`

## Operational Notes

- **Template-resolved values are recorded.** However, values resolved from an OS environment variable via <code v-pre>{{env.X}}</code> (length 4 or more) are masked to `***` right before writing, inside the request's url/headers/body, the response's headers/body, assertion results (expected/actual/message), and events (event/id/data). Masking matches not only the raw value but also its URL-encoded representations (percent-encoding, the `+`-for-space form `URLSearchParams` produces, and the encodeURI form that approximates WHATWG URL normalization), so a secret placed in `request.query` or written directly into a `request.url` template is masked in its encoded form too, not just literally. Only values resolved through this path are masked — values sourced from `environments/*.yaml`, values obtained through `capture:`, and live run output (the in-progress UI / `StepResult`), are not covered. See [SECURITY.md](https://github.com/almondoo/klaus/blob/main/SECURITY.md) for details
- Projects handling values that aren't masked (secrets shorter than 4 characters, or values sourced from environment files) should still add `.klaus/` to `.gitignore` (this repository's scaffolding ignores it from the start)
- Since it's a plain text file, it's also possible to deliberately commit it to git and share execution records across a team (after confirming no unmasked values are included)
