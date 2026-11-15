# CLI Reference

klaus has thirteen commands: `run` (executes flows), `req` (sends a single ad-hoc request), `ui` (launches the localhost web UI), `validate` (schema-validates flows), `schema` (prints a JSON Schema), `generate` (generates flows from an OpenAPI spec; see [Generating Flows from OpenAPI](./generate.md)), `init` (scaffolds a starting point), `history` (inspects execution history), `diff` (compares two recorded runs), `promote` (turns recorded runs into a flow), `mock` (serves a recorded cassette as a local mock server), `snapshot` (reviews and accepts `assert.snapshot` results), and `mcp` (serves klaus as tools to an MCP client; see [MCP server for AI agents](./mcp.md)).

## --help

Both `klaus --help` and `klaus run --help` end with a link to the docs site (this site; the Japanese version is under `/ja/`, not at the site root), a note that `klaus init` scaffolds a starting point, and a one-line exit code summary.

## klaus run

```
klaus run <files...> [options]
```

Passing multiple files runs them in sequence (glob expansion is left to the shell).

| Option | Description | Default |
|---|---|---|
| `--env <name>` | Overrides the flow definition's `env:` (cannot be combined with `--env-file`) | the flow's `env:` |
| `--env-file <path>` | Loads environment variables from an arbitrary YAML file path (relative to cwd or absolute), instead of a named environment under `environments/`. Overrides the flow definition's `env:`. Cannot be combined with `-e`/`--env` | — |
| `--var <key=value>` | Sets an ad-hoc template variable (repeatable; the value may itself contain `=`, only the first `=` is treated as the separator). Lands in the same namespace as environment file values (bare <code v-pre>{{name}}</code>), overriding same-named keys loaded from the environment | — |
| `--json` | Forces JSON output even on a TTY | — |
| `--text` | Forces text output even when not a TTY (cannot be combined with `--json`) | — |
| `--report <list>` | Comma-separated list of report formats to generate: `junit`, `tap`, `html`, `github` (e.g. `junit,html`) | — |
| `--report-file <path>` | Output path for the report format(s) given via `--report` (repeatable; see below) | per-format default (see below) |
| `--no-history` | Disables writing to the history JSONL | history enabled |
| `--no-mask` | Disables secret masking in stdout output (JSON/text). `Cookie` / `Set-Cookie` header values stay unmasked in the printed headers, but the `message` and `actual` of a failed assertion on the `cookie` / `set-cookie` header are always masked | masking enabled |
| `--record <dir>` | Record mode: sends real HTTP requests and saves masked request/response pairs to a cassette in `<dir>` | — |
| `--replay <dir>` | Replay mode: serves HTTP responses from the cassette in `<dir>` instead of the network (unrecorded requests fail with exit code 3). Cannot be combined with `--record` | — |
| `--allow-protected` | Allow running against an environment file marked `$protected: true` or `$protected: readonly` (otherwise refused with exit code 3; see "Protected environments" below) | — |
| `--actor <name>` | Name recorded as `actor.name` in the history entries of this run (1-100 characters). `actor.kind` is still detected from the environment (see [Execution History](history.md#audit-fields)) | — |
| `--data <path>` | Run data-driven: for each row in this JSON/YAML data file, run all given flow files once (see "Data-driven runs" below) | — |
| `--tags <list>` | Comma-separated list of tags; only run flows whose `tags:` includes at least one of them (OR semantics; see "Tag-based flow selection" below) | — |
| `--exclude-tags <list>` | Comma-separated list of tags; drop flows whose `tags:` includes any of them. Takes precedence over `--tags` | — |
| `--jobs <n>` | Run this many execution units in parallel (integer 1-32; see "Parallel execution (`--jobs`)" below). Cannot be combined with `--record` | 1 (sequential) |
| `--dry-run` | Send nothing: print each step's expanded request and whether the guards would refuse it (see "Dry run (`--dry-run`)" below). Cannot be combined with `--record`, `--replay`, or `--report` | — |
| `-u`, `--update-snapshots` | Rewrite `assert.snapshot` baselines that differ or are missing, and remove obsolete entries (see "Snapshots" below). Cannot be combined with `--dry-run`, `--replay`, or `--ci`; it cannot be set from `klaus.config.yaml` | — |
| `--ci` | Fail instead of recording when an `assert.snapshot` baseline is missing | on when the `CI` environment variable is set to anything other than empty, `0`, or `false` |
| `--openapi <path>` | Validate every HTTP response against an OpenAPI 3.0/3.1 document and report operation coverage (repeatable; see "OpenAPI validation" below). Default from `run.openapi` in `klaus.config.yaml` | — |
| `--openapi-base-url <url>` | Also match requests against this URL as a server of the OpenAPI documents. Requires `--openapi` | — |
| `--openapi-strict` | Fail on unmatched requests, undocumented status codes, and responses that cannot be validated. Requires `--openapi`; cannot be combined with `--dry-run` | — |
| `--openapi-coverage-min <percent>` | Fail the run (exit 4) when the operation coverage is below this percentage (0-100). Requires `--openapi`; cannot be combined with `--dry-run` | — |

`--report` takes a comma-separated list of formats (entries are trimmed; each must be `junit`, `tap`, `html`, or `github`). Passing an unknown or empty format entry prints an error to stderr and exits with 1. `--report` also rejects a duplicated format (e.g. `--report junit,junit`) and rejects `--report-file` values that resolve to the same output path across formats, both with an error to stderr and exit 1, since either would make two writes race on one file. With N formats given to `--report`, `--report-file` must be passed either **exactly N times** (in the same order, pairing the 1st `--report-file` with the 1st format and so on) or **not at all** (in which case each format is written to its own default filename: `klaus-report.xml` for `junit`, `klaus-report.tap` for `tap`, `klaus-report.html` for `html`, `klaus-report.md` for `github`; see [GitHub Report](#github-report) for the one exception). Any other count — e.g. one `--report-file` for two formats — is rejected with an error and exits with 1 without writing any file. This generalizes the single-format behavior: `--report junit` alone still defaults to `klaus-report.xml`, unchanged from before. Passing `--json` and `--text` together, or `-e`/`--env` and `--env-file` together, also prints an error to stderr and exits with 1 (nothing is run). This `-e`/`--env` + `--env-file` conflict only fires for an `-e`/`--env` **typed on the command line**; a `run.env` default coming from `klaus.config.yaml` yields to an explicit `--env-file` instead of conflicting with it (see [Default CLI options](config.md)).

`--env-file` honors a `$protected` key in the loaded file exactly like a named environment (see below).

### Protected environments (`$protected`)

| `$protected` | Without `--allow-protected` |
|---|---|
| `true` | Every step is refused (exit code 3) |
| `readonly` | `GET` / `HEAD` / `OPTIONS` run normally; every other method and every WebSocket step is refused (exit code 3). GraphQL steps default to `POST`, so they are refused |

For `readonly`, a `GET` / `HEAD` / `OPTIONS` request that carries a method-override header (`X-HTTP-Method-Override`, `X-HTTP-Method`, or `X-Method-Override`) is refused as well, since the server may treat it as a write. The check looks only at the HTTP method and these headers, so a GraphQL mutation sent via `GET` cannot be detected and is not refused.

Passing `--allow-protected` lifts both. The refusal happens right before sending, so a refused step ends as `error` (exit code 3). `--replay` sends nothing, but the method check still applies. The separate [`guard.allowedHosts`](config.md#host-allowlist-guard-allowedhosts) allowlist in `klaus.config.yaml` has no CLI flag to override it. Both refusals exit with code 3, see [Troubleshooting](troubleshooting.md).

`--var` values are **not** registered as secrets and are **not** masked in output, unlike <code v-pre>{{env.X}}</code> (OS environment variable references). If a value is a real secret, pass it through an OS environment variable and reference it as <code v-pre>{{env.X}}</code> instead, so it benefits from the masking described in [Execution History](history.md).

`--env` / `--report` / `--report-file` / `--no-history` / `--no-mask` / `--jobs` / `--openapi` can have their defaults set via `klaus.config.yaml`. `--var`, `--env-file`, `--data`, `--tags`, `--exclude-tags`, `--dry-run`, `--openapi-base-url`, `--openapi-strict`, and `--openapi-coverage-min` cannot — see [Default CLI options](config.md).

### Tag-based flow selection (`--tags` / `--exclude-tags`)

Flow definitions may declare `tags: [smoke, auth]` at the top level (see [Flow Definition Reference](flow-definition.md#tags)). `--tags` and `--exclude-tags` each take a comma-separated list (entries are trimmed; an empty entry after trimming — e.g. a leading/trailing/doubled comma — is rejected with a non-zero exit and no stack trace).

- **`--tags`**: keeps a flow if it has **at least one** of the given tags (OR semantics). Omitted → no filtering by inclusion (every flow passes this stage)
- **`--exclude-tags`**: drops a flow if it has **any** of the given tags, applied after the `--tags` stage. Omitted → nothing is excluded. When a flow matches both `--tags` and `--exclude-tags`, **exclusion wins**
- **Untagged flows** (no `tags:` field): they match none of `--tags`, so they are dropped whenever `--tags` is given; they match none of `--exclude-tags` either, so they are kept when only `--exclude-tags` is given
- **Filtered-out flows never run**: a flow dropped by tag filtering does not reach the runner at all, so it produces no entry in the JSON/JUnit output and no execution-history row — this is different from a `skipped` step, which is recorded (see [Flow Behavior on Step Failure](flow-definition.md#flow-behavior-on-step-failure))
- **Zero matches is an error**: if filtering leaves no flows to run, `klaus run` prints `no flows match the specified tags` to stderr and exits with **1**, without running anything. This is intentional — a silently-green empty run in CI would hide a typo in a tag name
- **Combined with `--data`**: filtering happens first, before the data-driven row expansion — so the row × flow iteration only covers the flows that survived filtering
- Not settable via `klaus.config.yaml` (see above)

### Data-driven runs (`--data`)

`--data <path>` runs every given flow file once **per row** in a JSON or YAML data file (Newman-style data-driven execution). The data file must be an array of objects; each value must be a scalar (string / number / boolean / null) — nested objects/arrays are rejected, and there is no CSV support (JSON/YAML only, chosen to avoid adding a new dependency; see the schema doc comment in `src/core/data.ts` for the full rationale). An empty array is also rejected.

- **Iteration order**: rows are the outer loop and flows are the inner loop — `flowA(row1)`, `flowB(row1)`, `flowA(row2)`, `flowB(row2)`, ... (iteration-major order, matching Newman's collection-runner semantics)
- **Variable injection**: each row's values land in the same template env namespace as `--var` and the environment file (bare <code v-pre>{{name}}</code>), overriding same-named keys from `--var`, which in turn overrides the environment file. Capture variable resolution is unaffected (captures still resolve before the env namespace, per the existing precedence rule)
- **Value coercion**: `number`/`boolean` row values are stringified with `String(value)` before injection, same as capture values. A key whose value is `null` is **not injected at all** — referencing it in a template then fails with the usual unresolved-variable error (this is intentional, not a bug)
- **Not masked**: like `--var`, row values are not registered as secrets and are not masked in output — use <code v-pre>{{env.X}}</code> (an OS environment variable) for real secrets
- **Aggregation**: all iterations' flow results sit flat in the same run — a failure in any iteration fails the run as a whole (same `aggregateStatus` / exit-code rules as a normal multi-flow run)
- **Reporting**: when `--data` is used, each flow result carries a 1-based `iteration` number. This surfaces as: the `iteration` field on each flow entry in the `--json` output (additive; `version` stays `2`), an `(iteration N)` suffix on the JUnit `<testsuite name="...">` (the `classname` on each `<testcase>` stays the plain flow name), an `(iteration N)` suffix on the text-output flow header, and an `iteration` field on each execution-history JSONL entry (additive; `v` stays `1`)

### Parallel execution (`--jobs`)

`--jobs <n>` runs multiple **execution units** at the same time instead of one after another. An execution unit is one flow file (or, when `--data` is given, one flow-file × data-row pair — the same unit that `--data`'s iteration-major order produces). `<n>` must be an integer between 1 and 32; an out-of-range or non-integer value is rejected with a non-zero exit and no stack trace, the same way `--port`/`--last` are validated.

- **Default is 1 (sequential), not Hurl-style parallel-by-default**: klaus intentionally differs from tools like Hurl here. Without `--jobs`, execution is byte-for-byte identical to versions before this option existed — no worker pool, no reordering layer, nothing changes on the default path.
- **Steps inside a flow always stay sequential**, no matter how high `--jobs` is set — only the *units* (whole flow-file runs) are parallelized, never the steps within one. A flow that depends on step N's captured value in step N+1 behaves exactly as before.
- **Result order is always input order, not completion order**: `RunResult.flows` (and therefore the `--json` output, JUnit/TAP report ordering, and exit-code aggregation) lists units in the same iteration-major order `--data` already uses (row outer, flow inner) — regardless of which unit actually finished first. `runId`, `aggregateStatus`, and exit codes are unaffected by `--jobs`.
- **Text output ordering**: with `--jobs` 2 or higher, klaus buffers each unit's step-progress lines and flushes a unit's full block only once every earlier unit (in input order) has already flushed — so a human reading the text output still sees units in the same order as `--jobs 1`, never interleaved or out of order, even though the underlying requests ran concurrently. (Implementation note: klaus buffers each unit's output in full and releases it once it becomes the earliest not-yet-flushed unit, rather than live-streaming the currently-furthest-along unit.)
- **Execution history ordering is not guaranteed**: each step still appends exactly one line to `.klaus/history/*.jsonl` (see [Execution History](history.md)), but with `--jobs` > 1, lines from concurrently-running units can interleave in the file in whatever order their writes land — unlike the in-memory `RunResult`, the JSONL file's *line order* does not reflect input order. Every entry still carries `runId`/`flow`/`step`/`startedAt` so a consumer can reconstruct grouping and ordering itself if needed. The writes themselves are not corrupted or torn (each line is one atomic `O_APPEND` write), only their relative order is unspecified.
- **Cannot be combined with `--record`**: record mode appends every response to the same cassette file (`--record <dir>`) keyed by method+URL. With `--jobs` > 1, concurrent identical requests could get appended in a different relative order on every run, making the *replayed* response for a repeated method+URL pair (`findCassetteEntry` takes the first-recorded match) non-deterministic across recordings. `--record` combined with `--jobs` greater than 1 is therefore rejected with an error and exit code 1 before anything runs. `--replay` has no such restriction: each unit independently loads its own read-only copy of the cassette index before it starts sending requests (not a single index shared/hoisted across units) — since nothing writes to the cassette file during replay, those concurrent independent reads under `--jobs` > 1 are safe.

### Dry run (`--dry-run`)

`--dry-run` shows what `klaus run` would send, without sending it. For every step it prints the request after template expansion (method, URL with the query merged in, headers, body; for an SSE step the same, for a WebSocket step the URL, headers, and the messages that would be sent), together with the result of the same guard checks that run right before sending. Use it to check a flow against `guard.allowedHosts` and `$protected` environments before a real run.

Nothing is sent and nothing is written: no history entries, no cassette reads or writes, no retries, no assertions, no `capture`. The flow files, `--data`, `--tags`, `--exclude-tags`, `--env`, `--env-file`, `--var`, and `--allow-protected` are interpreted exactly as for a normal run, and parse errors still exit with 2. `--jobs` is accepted, but nothing runs concurrently and the output order stays the same (rows outer, flows inner, as with `--data`). `--dry-run` cannot be combined with `--record`, `--replay`, or `--report`; that is an argument error and exits with 1 without running anything, like the other argument conflicts of `klaus run`. A `run.report` default in `klaus.config.yaml` is ignored under `--dry-run`. It cannot be set from `klaus.config.yaml`.

- **Variables that depend on a capture**: a variable that an earlier step of the same flow defines through `capture` has no value yet, so it stays as <code v-pre>{{name}}</code> in the output and is listed in the step's `unresolved` field. That is not an error. Such a name is treated as unresolved even if the environment defines the same name, because at run time a captured value takes precedence over the environment.
- **Variables that cannot resolve at run time either**: a variable that is neither defined by an earlier step's `capture` nor in the environment, `--var`, or the data row, and an <code v-pre>{{env.X}}</code> whose OS environment variable is undefined, are reported in the step's `error` with the same message as at run time, and the step has no `request`.
- **Generated values**: <code v-pre>{{newUuid}}</code>, <code v-pre>{{newDate}}</code>, and <code v-pre>{{newTimestamp}}</code> are expanded like at run time, so the values differ from the ones a real run generates.
- **`if` conditions** depend on run-time statuses and captures, so they are not evaluated: the step is marked `conditional: true`, its `if` text is shown, and its request is still expanded.
- **Guards**: `guard.status` is `allowed`, `refused` (with the same reason as the run-time refusal, and the same [`errorCode`](history.md#error-codes) as `guard.errorCode`), or `undetermined` when `guard.allowedHosts` is set and the target host itself contains an unresolved variable (for example `url: "{{base}}/x"` where `base` is captured earlier). A refusal that does not depend on the host, such as a `POST` in a `$protected: readonly` environment, is still reported as `refused`. If only the path or query is unresolved, the host is known and the allowlist is checked. Each step is judged on its own: a refused step does not hide the steps after it, although a real run would skip them.

JSON output (non-TTY, or `--json`) is one compact object with a top-level `"dryRun": true` marker. Its `flows[].steps[]` structure and field names follow the [`run` JSON output](#json-output-for-machines), but there is no `status` per step, no `assertions`, and no `historyRef`, and request bodies are not truncated (a dry run has no history to fetch the full text from). Secrets from <code v-pre>{{env.X}}</code> are masked as usual (`--no-mask` disables it).

```jsonc
{
  "version": 1,
  "dryRun": true,
  "status": "ok",            // "error" (exit code 3) if any step is refused or fails to expand
  "summary": { "flows": 1, "steps": 2, "refused": 0, "undetermined": 0, "unresolved": 1, "errors": 0 },
  "flows": [
    {
      "name": "chain",
      "file": "flows/chain.yaml",
      "steps": [
        {
          "name": "login",
          "kind": "http",               // "http" | "sse" | "ws"
          "request": { "method": "POST", "url": "http://127.0.0.1:18766/login", "headers": { "X-Key": "***" }, "body": "{\"user\":\"alice\"}" },
          "unresolved": [],
          "conditional": false,
          "guard": { "status": "allowed" }
        },
        {
          "name": "me",
          "kind": "http",
          "request": { "method": "GET", "url": "http://127.0.0.1:18766/me?who=alice", "headers": { "Authorization": "Bearer {{token}}" } },
          "unresolved": ["token"],
          "conditional": true,
          "if": "steps.login.status == \"passed\"",
          "guard": { "status": "allowed" }
        }
      ]
    }
  ]
}
```

The text output (TTY, or `--text`) prints the same information per step and ends with a one-line summary. The JSON Schema is available through `klaus schema --target dry-run-report` (see [klaus schema](#klaus-schema)).

Exit code is **3** if any step would be refused by a guard, or fails to expand at run time (the `error` case above, which a real run would also end as a runtime error); otherwise **0**. Validation errors stay at 2. There is no exit code 4 because assertions are not evaluated.

### Snapshots (`--update-snapshots` / `--ci`)

A step with `assert.snapshot` ([details](flow-definition.md#snapshot-baseline-comparison)) compares its masked response with a baseline file next to the flow file. These two flags decide what happens when there is nothing to compare, or the response changed:

| Situation | Default (local run) | `--ci`, or `CI` set | `--update-snapshots` |
|---|---|---|---|
| Equals the baseline | passes (`matched`) | same | same |
| Differs from the baseline | fails with a structural diff, exit 4 (`mismatch`) | same | baseline rewritten, passes (`updated`) |
| No baseline | baseline written, passes (`written`) | fails, exit 4 (`missing`) | baseline written, passes (`written`) |
| Entry no step produces any more | warning (`obsolete`) | same | entry removed |

- Baselines are written once, at the end of the run, so a run that is killed halfway leaves the files as they were. The files written are listed in the output (`snapshot file written: ...` in text, `snapshots.files` in JSON): review and commit them.
- `--update-snapshots` is the explicit act of accepting a changed response. It is never read from `klaus.config.yaml`, and `--ci` cannot be combined with it (exit 1); with `CI=true` in the environment it still works. `klaus snapshot accept <runId>` is the other way to accept ([klaus snapshot](#klaus-snapshot)).
- A missing baseline is not recorded implicitly in three cases: the step's other assertions failed (the failed response would become the baseline), the run targets a `$protected` environment (production data would end up in a committed file; pass `--update-snapshots` to record it on purpose), and `--replay` (a replayed response is compared but never written, and `--update-snapshots` cannot be combined with it). The result is `missing`; it fails the step except in the first case, where the step already fails.
- A corrupt snapshot file (not JSON, or the wrong shape) exits with 2 before anything runs, without echoing its content. Fix or delete it, or run with `--update-snapshots` to recreate it.
- Obsolete entries (keys in the file that no step produced) are only judged after every step of the flow ran: nothing skipped, and every snapshot step reached its comparison. A partial run never deletes baselines. Running without `--data` against a file that holds `#<n>` keys from a data-driven run reports them as obsolete, so do not combine that with `-u`.
- `--dry-run` never touches snapshot files.
- A response is never recorded as a baseline when another assertion of the same step failed, and that includes the OpenAPI check of `--openapi`: with a missing baseline the result is `missing`, and with a baseline that differs it stays a `mismatch` (the message says the baseline was not updated), also under `--update-snapshots`. `klaus snapshot accept` refuses such a candidate too (`failed-step`, see [klaus snapshot](#klaus-snapshot)).
- Snapshot files are only read and written as regular files. The `__snapshots__` directory and the baseline file must not be symbolic links, even when they point inside the current directory; a named pipe or device at the baseline path is reported as a corrupt file instead of hanging the run; and a `__snapshots__` below a hidden directory such as `.git/` is refused (a violation makes the step `error`, exit 3). A baseline nested deeper than 200 levels is corrupt (exit 2, the content is not printed), and a response nested that deep is not recorded: the snapshot assertion fails with a message saying so.
- The key of a snapshot is the step name, plus the `--data` iteration and `name`. So a step with `assert.snapshot` cannot have a name that contains ` :: ` or ends with ` #<number>`, because it could collide with another step's key; that is a definition error (exit 2, also reported by `klaus validate`).
- Baselines are written under a lock file (`<baseline>.lock`, removed afterwards), re-reading the file just before writing, so two runs that write different keys of the same file at the same time (for example two runs started from the UI) do not lose each other's keys. A lock older than 30 seconds is treated as left behind by a crashed run and taken over, and a run waits up to 35 seconds for a lock held by another run. If the wait times out, the error names the lock file (`<baseline>.lock`); delete it if no other run is writing, then run again.
- Runs started from the UI server are not given the `CI` setting: they record a missing baseline like a local run, whatever the `CI` environment variable of the server process is. `CI` and `--ci` are read by `klaus run` only.

### OpenAPI validation (`--openapi`)

`--openapi <path>` checks every HTTP response of the run against an OpenAPI document and reports which operations the run exercised. Pass it more than once for several documents; set `run.openapi` in [`klaus.config.yaml`](config.md) to make it the default (an explicit `--openapi` replaces the configured list). The flows themselves need no change.

| Option | Description |
|---|---|
| `--openapi <path>` | OpenAPI 3.0 or 3.1 document, YAML or JSON (repeatable) |
| `--openapi-base-url <url>` | Also treat this URL as a server of the documents when matching requests, for example the staging URL when the document lists production. Absolute `http(s)` URL |
| `--openapi-strict` | Make requests that match no operation, status codes the document does not describe, and responses that cannot be validated into failures |
| `--openapi-coverage-min <percent>` | Fail the run (exit 4) when fewer than this percentage (0-100, decimal digits only; `0x10` and `1e1` are refused) of the operations were matched by a request |

`--openapi-base-url`, `--openapi-strict`, and `--openapi-coverage-min` need `--openapi` (otherwise exit 1). With `--dry-run`, `--openapi-strict` and `--openapi-coverage-min` are rejected (exit 1).

**Documents.** Only local files are read. A `$ref` to another local `.yaml`, `.yml`, or `.json` file is resolved (relative to the file that contains it, JSON Pointer fragments only); a remote `$ref` (`https://...`) is refused. A `$ref` target must be inside the directory of the OpenAPI document given to `--openapi` (symbolic links are resolved first): a target that is missing, outside that directory, or reached through a link to the outside is refused with the same message, so a document cannot be used to find out which files exist, and nothing from such a file ends up in an error or a violation. The message also says what to do: place the referenced files under the directory of the OpenAPI document, or bundle the document into a single file. Every `$ref` is checked before anything runs, and circular schemas are supported. YAML is parsed without printing parser warnings (their text can quote a line of a referenced file), and merge keys (`<<:`) are applied. A document that cannot be read or parsed, a Swagger 2.0 document, a `$ref` that cannot be resolved, or a file over the limits (8 MiB per file, 32 MiB and 100 files in total) exits with 2 and runs nothing; the message names the file and, for syntax errors, the line and column, never the contents of a referenced file. Nothing in a document is executed.

**Matching a request to an operation.** The request URL (without query and fragment) is matched against each operation's servers, then its path template and method:

- Servers come from `servers` (document, path item, or operation level; `/` when absent) plus `--openapi-base-url`. Server variables are supported: a variable with an `enum` matches those values, any other matches one path segment (several segments when its default contains `/`, for example `api/v1`). A relative server URL such as `/v1` matches any origin. Scheme and host are compared case-insensitively and default ports are ignored.
- Path templates match segment by segment, and a concrete path wins over a templated one (`/users/me` before `/users/{id}`); only operations with the request's method are candidates. A trailing slash is ignored, and `.` / `..` segments are resolved first, as in the URL that is actually sent (`/users/x/../me` is matched as `/users/me`).
- With several documents, the first one (in command-line order) that matches is used.
- A request that matches nothing is listed under `unmatched` in the coverage. It does not fail anything unless `--openapi-strict` is given.

**What is validated** for a matched response:

1. **Status**: the exact code, then `2XX` (the matching range), then `default`. A status the document does not describe is reported (`undocumented`) and fails only with `--openapi-strict`; nothing else is checked for it.
2. **Required headers**: every response header with `required: true` must be present (case-insensitive; `Content-Type` is ignored). Header values are not validated.
3. **Content type**: when the response defines `content` and has a body, the `Content-Type` (parameters ignored) must match one of the declared media types (`application/json`, `text/*`, `*/*`, ...). An empty body and `HEAD` requests skip the content type and the schema, except that an empty body for a response that declares a body with a schema (other than `204`, `205`, `304`) is a violation.
4. **Body**: for JSON media types (`application/json` and any `+json`), the body is validated against the schema with the bundled Ajv (JSON Schema 2020-12). A body that is not valid JSON is a violation, and a body nested deeper than 400 levels is not validated (`skipped`). Other media types are not validated beyond the content type. Validation runs in a worker thread with a time budget of 3 seconds per response: a schema whose `pattern` takes catastrophically long on the response (for example `^(a+)+$`) is abandoned, the response is `skipped` with a warning (a failure with `--openapi-strict`), and the same schema is not evaluated again in that run.

Violations make the step fail (an assertion with `kind: "openapi"`, exit 4). Each violation has a location (`status`, `content-type`, `header`, `body`) and, for the body, a JSON Pointer such as `/items/0/id`; at most 20 are kept, with the total in `violationCount`. Values from the response are never echoed in a violation.

**Schema keywords.** OpenAPI 3.1 schemas are JSON Schema 2020-12 and are used as written (`$ref` siblings included); `$id`, `$schema`, `$anchor`, and `$dynamicAnchor` are dropped, `$dynamicRef` and `$recursiveRef` are ignored with a warning, and `nullable` (an OpenAPI 3.0 keyword) is ignored with a warning (use `type: [..., "null"]`). For OpenAPI 3.0 the following are converted: `nullable: true` next to `type` (null is also added to `enum`), and boolean `exclusiveMinimum` / `exclusiveMaximum`; siblings of a `$ref` are ignored, as the 3.0 specification says. In both versions:

- `format` is never validated, known or not (a response is not failed for `date-time`, `uuid`, or an unknown format).
- `readOnly` has no effect on responses. A `writeOnly` property is removed from `required`, since a response does not contain it; that includes a `required` in one `allOf` branch for a property that another branch declares `writeOnly`.
- `discriminator`, `xml`, `externalDocs`, and `example` are annotations and are ignored. Every other keyword (`pattern`, `enum`, `allOf` / `oneOf` / `anyOf`, `additionalProperties`, ...) is validated as written.
- A schema Ajv cannot compile is reported as a warning and the response is not validated (`skipped`; a failure with `--openapi-strict`). The same applies to a schema where a part could not be used and was treated as accepting any value (an unresolvable `$ref`, a cycle of `$ref`s without a schema, `$dynamicRef`): a response with no violation is then `skipped`, never `valid`.

Request validation (parameters and request bodies) is not done.

**Coverage.** The run result gets an `openapi` summary: the documents, the number of operations and how many were matched (`operations.total` / `covered` / `percent`), for each covered operation the observed status codes next to the response keys the document describes, the uncovered operations, the unmatched requests (method and URL without query), the steps that are not validated, and the number of violating responses. It is shown in the JSON output, as `openapi:` lines before the text summary, in the HTML report, and in the GitHub summary.

- An operation is covered when at least one response was matched to it, whatever its status.
- `--tags` / `--exclude-tags` that select only some flows mark the coverage `partial: true` (the text says `partial run`): it is the coverage of that part only.
- SSE steps, WebSocket steps, and steps that followed redirects (the response is not for the first request) are not validated; they are listed under `excluded`.
- `--openapi-coverage-min` below the threshold prints an error to stderr, sets `coverageMin.met` to `false`, and ends the run as failed (exit 4) even when every step passed.
- It works with `--jobs` and `--data` (coverage is the union over all units) and with `--replay` (replayed responses are validated like live ones). Retried steps count every attempt.
- With `--dry-run` nothing is sent and nothing is validated: the expanded request URLs are matched, and the coverage is reported with `planned: true`. A URL whose base is still an unresolved variable is matched by its path.
- Schemas are compiled once per run, lazily per operation.

## Output Modes

- **Auto-detection**: text if stdout is a TTY, JSON if non-TTY (pipe / agent execution / CI). `--json` forces JSON even when non-TTY, and `--text` forces text even when not a TTY (the two cannot be combined)
- **Result data goes to stdout; diagnostic messages (parse errors, warnings) go to stderr** — the two are kept separate

### Text Output (for humans)

Output is streamed incrementally as each step completes. Successes get a single-line summary; details are shown only on failure (full detail remains available in the history JSONL).

```
auth flow (/path/to/auth-flow.yaml)
  PASS login (200, 6ms)
  FAIL get-me (200, 3ms)
    body $.email: expected "a@example.com" but got "b@example.com"
  SKIP logout: skipped because a previous step failed

1 flow, 3 steps: 1 passed, 1 failed, 1 skipped (12ms)
```

- Line types: `PASS` / `FAIL` (the failed assertion's expected/actual, with the response body truncated to about 500 characters) / `SKIP` (with a reason) / `ERROR` (the runtime error message)
- On a TTY, output is ANSI-colored (pass=green / fail=red / skip=yellow). No color with `--json`. The `NO_COLOR` (disable colors) and `FORCE_COLOR` (enable colors even off-TTY; `FORCE_COLOR=0` disables) environment variables are also honored, but making `FORCE_COLOR` take effect off-TTY requires `--text` to force text output in the first place (without it, non-TTY defaults to JSON output, which never reaches the colored text path)
- Control characters found in `FAIL` detail lines and `ERROR` messages (sourced from the response body) are converted to visible escapes (`\n` / `\r` / `\t` / `\xNN`) before being printed. Newlines are included in this so that a response body can't be used to forge a fake `PASS` line or otherwise spoof terminal output

### JSON Output (for machines)

After execution completes, a single compact JSON object (no pretty-printing, one line) is written to stdout. There is no incremental output.
The structure is **failure-focused** to keep the token count low for agents: steps that `passed` collapse to a
one-line summary of just `name` / `status` / `durationMs`, while `failed` / `error` / `skipped` steps carry the
full detail (request/response snapshots, assertions, etc).

```jsonc
{
  "version": 2,            // schema version of the output
  "runId": "<uuid>",
  "startedAt": "2026-08-08T…",
  "durationMs": 123,
  "status": "passed",      // "passed" | "failed" | "error"
  "summary": { "flows": 1, "steps": 2, "passed": 1, "failed": 1, "error": 0, "skipped": 0 },
  "flows": [
    {
      "name": "auth flow",
      "file": "…",
      "status": "failed",
      "durationMs": 120,
      "steps": [
        {
          // passed steps are a one-line summary only (historyRef is only added for steps recorded in history)
          "name": "login",
          "status": "passed",
          "durationMs": 6,
          "historyRef": { "date": "2026-08-08", "runId": "<uuid>", "step": "login" }
        },
        {
          // failed/error/skipped steps carry full detail
          "name": "get-me",
          "status": "failed",
          "durationMs": 4,
          "historyRef": { "date": "2026-08-08", "runId": "<uuid>", "step": "get-me" },
          "startedAt": "2026-08-08T…",
          "request": { "method": "GET", "url": "…", "headers": {}, "body": "…" },
          "response": { "status": 200, "headers": {}, "body": "…" },
          "assertions": [ { "ok": false, "kind": "status", "expected": 200, "actual": 401, "message": "…" } ]
        }
      ]
    }
  ]
}
```

- **Truncation**: the `body` of request/response snapshots in the detail (JSON bodies are stringified first), the `data` of SSE `events`, and the `data` of WS `wsMessages` are all truncated to about 500 characters (same rule as the text output). The full untruncated JSON body is only available from history
- Secrets sourced from <code v-pre>{{env.X}}</code> are masked by default (same rules as the history JSONL and `--report junit`, URL-encoded forms included (encodeURIComponent, form-urlencoded, and the encodeURI form used to approximate WHATWG URL normalization) as well as JSON-escaped forms; see [Execution History](history.md) for details). Pass `--no-mask` to disable masking for this JSON output only (the history JSONL and JUnit file output are always masked)
- Control-character escaping (as done in text output and JUnit reports) is **not** applied here — values are printed as-is
- **errorCode**: an `error` step also carries `errorCode` (for example `guard.allowed-hosts`, `response-too-large`) when its cause has a stable code, next to the `error` message. It is omitted for other errors and for passed / failed / skipped steps; the codes are listed in [Error Codes](history.md#error-codes)
- **historyRef**: when history recording is enabled (i.e. `--no-history` was not passed), every step that was actually recorded (including passed ones) gets a `historyRef: { date, runId, step }`. A step that ends with a runtime error that is not recorded (a failed capture, a timeout, a connection error, a response that is too large) has no history entry and therefore no `historyRef`. Fetch the full detail with `klaus history show <runId> --step <step>` (see [klaus history](#klaus-history) / [Execution History](history.md)). `historyRef.date` is the UTC date of the history file the step was written to (derived from the step's `startedAt`). `historyRef` is omitted entirely when run with `--no-history`
- For SSE / WebSocket steps, `response.body` is absent; received data instead goes into the `events` (SSE) / `wsMessages` (WS) fields
- **snapshots**: a top-level `snapshots: { matched, written, updated, mismatched, missing, obsolete, files, obsoleteEntries }` summary, present only when a step has a snapshot assertion, a snapshot file has obsolete entries, or snapshot files were written (`files` lists them, relative to the current directory). A snapshot assertion in `assertions` has `kind: "snapshot"`, `state` (`matched` / `written` / `updated` / `mismatch` / `missing`), `snapshotKey`, `snapshotFile`, and for a mismatch `differences` (`[{ "path": "$.body.name", "kind": "changed", "before": "a", "after": "b" }]`, at most 20) with the total in `differenceCount`. Passed steps are one-line summaries, so a baseline that was written shows up in `snapshots.written` / `snapshots.files` and, in text output, as `[snapshot written]` on its `PASS` line. The candidate that `klaus snapshot accept` writes is kept in history, never in this output
- **openapi**: a top-level `openapi` object, present only with `--openapi` (also in `--dry-run --json`, with `planned: true`): `documents` (`file`, `title`, `version`, `operations`), `operations` (`total`, `covered`, `percent`), `covered` (`operation`, `document`, `statuses`, `documented`), `uncovered`, `unmatched` (`method`, `url`, `count`), `excluded` (`flow`, `step`, `reason`: `sse` / `websocket` / `redirected`), `violations`, `partial`, `planned`, optionally `coverageMin` (`percent`, `met`) and `truncated` (a list was cut at 1000 entries). An OpenAPI assertion in `assertions` has `kind: "openapi"` and an `openapi` object: `state` (`valid` / `invalid` / `undocumented` / `unmatched` / `skipped`), `operation` (`GET /users/{id}`), `document`, `status`, and for `invalid`, `violations` (`[{ "location": "body", "path": "/id", "message": "must be integer" }]`, at most 20) with the total in `violationCount`. Passed steps are one-line summaries, so only the `openapi` summary shows what a passing run covered
- **redirects / droppedHeaders**: a step that followed redirects (`http.followRedirects`) carries `redirects` (the URLs visited after the first request, the last being the final response) whatever its status, and `droppedHeaders` (`[{ "hop": 1, "headers": ["authorization"] }]`, header names only) when credentials were dropped on a cross-origin hop. URLs are masked like any other. `FAIL` and `ERROR` lines in text output show the same information in one or two compact lines
- **warnings**: top-level `"warnings": ["..."]`, present only when there is at least one. It carries warnings that do not change a step's outcome, such as `http.tls.insecure is enabled: TLS certificate verification is DISABLED for this run` or a history write failure, without duplicates. The same warning still goes to stderr as a `klaus: warning:` line; text output prints it as a `warning:` line before the summary, and the HTML and GitHub reports show it too

### JUnit Report

With `--report junit`, an XML file is written to `--report-file` where each flow becomes a `<testsuite>` and each step a `<testcase>`. It can be combined with either the text or JSON stdout output independently. Special characters are XML-escaped.

Secrets sourced from <code v-pre>{{env.X}}</code> are masked using the same rules as history (URL-encoded forms included (encodeURIComponent, form-urlencoded, and the encodeURI form used to approximate WHATWG URL normalization) as well as JSON-escaped forms; see [Execution History](history.md) for details). This masking is also applied by default to the stdout text / JSON output (including `--json`). Pass `--no-mask` to disable masking on the stdout side only — the history JSONL and JUnit file output are always masked and are unaffected by `--no-mask`. Control characters sourced from the response body are converted to visible escapes (`\xNN`), except for the tab/LF/CR that XML 1.0 permits. **This control-character escaping applies only to the JUnit report and text output; it is not applied to the JSON output** (including `--json`).

### TAP Report

With `--report tap`, a [TAP version 13](https://testanything.org/) file is written to `--report-file`: a `1..N` plan line (N = total step count across all flows) followed by one `ok`/`not ok` line per step, in execution order, named `<flowName> > <stepName>`. A `skipped` step is reported as `ok` with a `# SKIP <reason>` directive (TAP has no separate "skip" line type). A `failed`/`error` step is reported as `not ok`, followed by one `# ...` diagnostic comment per failed assertion (or the runtime error message for `error` steps). Newlines and `#` in flow/step names or diagnostic messages are escaped so they cannot break the line-oriented TAP format.

Masking follows the same rules as the JUnit report (secrets from <code v-pre>{{env.X}}</code>, masked before control-character sanitization, unaffected by `--no-mask`).

Pass a comma-separated list to `--report` (e.g. `--report junit,tap`) to generate both formats in one run — see the `--report`/`--report-file` pairing rule above.

### HTML Report

With `--report html`, a single self-contained HTML file is written to `--report-file` (default `klaus-report.html`): inline CSS only, no external assets, and no JavaScript. It shows the run header (status, start time, duration, run ID, and the env, actor, and git commit when known), the summary counts, and one section per flow with one row per step (status, request line, response status, duration). `failed` and `error` steps are expanded by default (a `<details>` element) and list the failed assertions with expected/actual values plus the request and response, with bodies truncated to 500 characters as in the JSON output. The page follows the light/dark colour scheme of the browser and is printable. Steps that followed redirects show their route (and any dropped header names), and run warnings appear in a Warnings box under the counts. All dynamic text is HTML-escaped. Masking follows the same rules as the JUnit report (unaffected by `--no-mask`).

### GitHub Report

`--report github` is for GitHub Actions. It produces two outputs.

- **Job summary (Markdown)**: a status line, a counts table, a table of failed/error steps (flow, step, first failure message), and a collapsed `<details>` section per flow. Table cells are truncated (200 characters, messages 300) and escaped (pipes, backticks, `*`, `_`, `[`, newlines, HTML; URLs are defanged so no clickable link can be produced). The whole summary is hard-capped at 512 KiB (GitHub's step summary limit is 1 MiB): the failed-step table is capped at 200 rows, the collapsed details are cut off with a note when the budget runs out, and as a last resort the output is cut at a line boundary with open `<details>` closed. The destination is chosen as follows, and it is never stdout (so `--json` output stays machine-readable):
  1. `--report-file` given for this format: the Markdown is written (overwritten) to that path.
  2. Otherwise, if `GITHUB_STEP_SUMMARY` is set: the Markdown is appended to that file.
  3. Otherwise: written to `klaus-report.md`.
- **Annotations**: when `GITHUB_ACTIONS=true`, one `::error file=<flow file>,title=<flow> / <step>::<message>` line is printed per failed/error step, with the workflow-command escaping rules applied (`%`, CR, LF, and also `:` and `,` inside the properties). They go to stdout, or to stderr when stdout carries JSON (`--json`, or non-TTY); GitHub parses workflow commands from both. Long titles and messages are truncated (200 and 4000 characters). Outside GitHub Actions no annotation is printed. Annotations carry no `line=` because step source positions are not part of the run result.

Masking follows the same rules as the JUnit report.

## Exit code

| code | Meaning |
|---|---|
| 0 | All passed |
| 1 | General error (invalid CLI arguments, unexpected exception) |
| 2 | Definition file parse error |
| 3 | Runtime error (connection failure, timeout, capture failure, a step refused by `$protected` or `guard.allowedHosts`, etc.) |
| 4 | Assertion failure |

Details of the decision rules:

1. **All files are parse-validated before execution.** If even one has a parse error, nothing is run; the filename and reason are printed to stderr and it exits with 2
2. A parse error in an environment file (`environments/*.yaml`) encountered during execution also results in exit 2
3. After execution: if any flow contains a runtime error (status "error"), exit **3**; otherwise if there's an assertion failure (status "failed"), exit **4**; if everything passed, exit **0**. When both 3 and 4 apply, 3 takes priority
4. A failure to write the history JSONL only produces a warning on stderr — it does not affect step results or the exit code
5. With `--dry-run` nothing is sent, so assertions never run and 4 does not occur: 0 (everything would be sent), 1 (an argument error such as combining with `--record` / `--replay` / `--report`, or an empty tag selection), 2 (a parse error), or 3 (a step the guards would refuse, or an expansion error a real run would hit too); see [Dry run](#dry-run-dry-run)
6. With `--openapi`, an unreadable or invalid OpenAPI document is a definition error (exit 2, nothing runs), a response that violates the document fails its step (4), and a coverage below `--openapi-coverage-min` ends the run as failed (4) even when every step passed; see [OpenAPI validation](#openapi-validation-openapi)

An agent (such as Claude Code) can identify where things went wrong from the exit code alone: 2 means fix the definition, 3 means check whether the target API is up, and 4 means compare the assertion against the response.

## klaus req

```
klaus req <method> <url> [options]
```

Sends one ad-hoc HTTP request without writing a flow file. It runs through the same core path as the single-request feature of `klaus ui`, so the request is guarded (see "Guardrails" below), secret-masked, and recorded in the history. Use it instead of `curl` when exploring an API. `<method>` is case-insensitive. The URL, header values, query values, and the body are template-expanded exactly as in flows (<code v-pre>{{baseUrl}}</code>, <code v-pre>{{env.X}}</code>). Only HTTP is supported; a request that carries `Accept: text/event-stream` is received as SSE.

| Option | Description | Default |
|---|---|---|
| `-H`, `--header <name:value>` | Request header (repeatable). Split at the first `:`; a repeated name (case-insensitive) keeps the last value | — |
| `--query <key=value>` | Query string parameter merged into the URL (repeatable; the value may itself contain `=`). Overrides a same-named key already in the URL; a repeated key keeps the last value | — |
| `--body <json>` | Request body: a JSON value, or `@<file>` to read it from a file (see "Request body" below) | — |
| `-e`, `--env <name>` | Loads `environments/<name>.yaml` (cannot be combined with `--env-file`) | no environment |
| `--env-file <path>` | Loads environment variables from an arbitrary YAML file path (relative to cwd or absolute). Cannot be combined with `-e`/`--env` | — |
| `--var <key=value>` | Sets an ad-hoc template variable (repeatable), overriding same-named environment values. Not masked as a secret, same as for `klaus run` | — |
| `--timeout <ms>` | Request timeout in milliseconds (positive integer) | 30000 |
| `--json` | Forces JSON output even on a TTY | — |
| `--text` | Forces text output even when not a TTY (cannot be combined with `--json`) | — |
| `--no-history` | Disables writing to the history JSONL | history enabled |
| `--no-mask` | Disables secret masking in stdout output (JSON/text) | masking enabled |
| `--actor <name>` | Name recorded as `actor.name` in the history entry (1-100 characters) | — |

There is deliberately no `--allow-protected`, the same as for the single-request feature of `klaus ui`.

### Request body (`--body`)

- `--body '<json>'` sends the parsed JSON value. Objects and arrays are sent as JSON with `Content-Type: application/json` added when you did not set one.
- `--body @<file>` reads the value from a file. The path is relative to the cwd (or absolute) and must resolve inside the cwd, symbolic links included; anything else is refused with exit code 2. Reading is limited to the cwd so an agent cannot send arbitrary files to the target.
- Input that is not valid JSON (inline or from a file) is sent as a raw string, the same as a string `body` in a flow. No `Content-Type` is added in that case, so set one with `-H` when the API needs it. A JSON string such as `'"text"'` is likewise sent as the raw string `text`.
- String values inside the body are template-expanded.
- JSON nested deeper than 200 levels is sent as a raw string too (no `Content-Type` is added), for the same reason a deep response body is kept as text: the structured form is walked recursively by masking and history. The same limit applies to response bodies, which are kept as text, so JSONPath captures and assertions do not match them.

### Output

The mode is chosen like `klaus run`: JSON when stdout is not a TTY, text on a TTY, forced with `--json` / `--text`. Result data goes to stdout; diagnostics go to stderr.

The JSON output is one compact object. Its field names match the step objects of the [`run` JSON output](#json-output-for-machines), but `request` and `response` are always included because inspecting the response is the point of the command:

```jsonc
{
  "version": 1,               // schema version of this output
  "status": "passed",         // "passed" = a response was received (any HTTP status), "error" = not sent or refused
  "startedAt": "2026-11-15T…",
  "durationMs": 12,
  "request": { "method": "GET", "url": "…", "headers": {}, "body": "…" },
  "response": { "status": 200, "headers": {}, "body": "…" },
  "historyRef": { "date": "2026-11-15", "runId": "<uuid>", "step": "request" }
}
```

- `error` carries the failure reason when `status` is `"error"` (connection failure, timeout, unresolved template variable, guard refusal); `response` is then absent. `errorCode` is a stable code next to it for the causes that have one (for example `guard.allowed-hosts`); see [Error Codes](history.md#error-codes). `events` lists the received SSE events for an `Accept: text/event-stream` request.
- **Truncation**: request and response `body` and SSE `data` are truncated to about 500 characters. The full text is available through `historyRef`.
- **historyRef**: present only when a history entry was actually written (history enabled, and the request either got a response or was refused by a guard; connection failures and timeouts are not recorded). Fetch the full record with `klaus history show <runId> --step request`. The entry has `flow: "(single)"` and `source: "single"`, and carries the audit fields (`env`, `actor`, `git`) like any other entry; see [Execution History](history.md).
- Secrets from <code v-pre>{{env.X}}</code> are masked in the output by default, as for `klaus run`. Literal tokens typed into `-H` or `--body` are not secrets and are not masked; pass real secrets through <code v-pre>{{env.X}}</code>.
- The JSON Schema is available through `klaus schema --target req-report` (see [klaus schema](#klaus-schema)).

The text output starts with a `METHOD URL -> status (duration)` line, then the response headers and the response body (truncated to about 500 characters, control characters shown as visible escapes), and a `history:` line with the `klaus history show` command when a history entry was written. A request that was not sent prints `ERROR: <reason>` instead.

### Guardrails

`klaus req` applies the same guards as `klaus run`, evaluated right before sending on the template-expanded request:

- [`guard.allowedHosts`](config.md#host-allowlist-guard-allowedhosts) in `klaus.config.yaml` restricts the target host. `klaus req` reads only the `guard` and `http` sections of that file. The `run:` defaults (`run.env`, `run.history`, `run.mask`, ...) are for `klaus run` and are not applied to `klaus req`.
- An environment with `$protected: true` refuses every request. With `$protected: readonly`, only `GET` / `HEAD` / `OPTIONS` are sent, and a request carrying a method-override header is refused. See [Protected environments](#protected-environments-protected).

A refused request is reported as `status: "error"` with exit code 3, and the refusal is recorded in the history. Because `klaus req` has no `--allow-protected`, a protection refusal ends with a hint to run a flow with `klaus run --allow-protected` instead (see [Troubleshooting](troubleshooting.md)).

`--env-file` may point outside the current directory, for both `klaus run` and `klaus req`: it is an input you chose explicitly, and its values are ordinary variables, not secrets (only <code v-pre>{{env.X}}</code> values are masked).

### Exit codes

| code | Meaning |
|---|---|
| 0 | A response was received (any HTTP status code; there are no assertions) |
| 1 | Invalid arguments: `--json` with `--text`, `-e` with `--env-file`, or a malformed option rejected by the option parser (for example `--header` without a `:`); also an unexpected exception |
| 2 | Invalid input: a `--body` file that is missing or outside the cwd, an invalid request definition, or an invalid environment file or `klaus.config.yaml` |
| 3 | Runtime error: connection failure, timeout, unresolved template variable, or a request refused by `$protected` or `guard.allowedHosts` |

Exit code 4 is never returned. To fail on an HTTP status, write a flow with an `assert` and use `klaus run`.

## klaus ui

```
klaus ui [-p <n>] [-H <host>] [--no-open]
```

| Option | Description | Default |
|---|---|---|
| `-p`, `--port <n>` | The port to listen on | `4884` (fixed) |
| `-H`, `--host <host>` | The host to listen on | `127.0.0.1` |
| `--no-open` | Suppresses automatically opening the browser | opens automatically |

On startup, a URL with a token (`http://127.0.0.1:<port>/?token=…`) is printed to stdout and opened in the default browser. Press Ctrl+C to stop it. For the server's features, security model, and HTTP API, see [localhost UI](ui.md).

`--port` / `--host` / `--no-open` can have their defaults set via `klaus.config.yaml`. See [Default CLI options](config.md).

On a shared multi-user host, this token-bearing URL is passed as an argument to the browser-launch command, so it may be readable by other local users via the process list. On such hosts, pass `--no-open` and open the printed URL yourself instead.

### Using it with docker-compose

To use `klaus ui` inside a container, keep the default port (`4884`) so the port mapping can be pinned, and pass `--host 0.0.0.0` so it's reachable from outside the container.

```yaml
services:
  klaus:
    image: your-klaus-image
    command: ["klaus", "ui", "--host", "0.0.0.0", "--no-open"]
    ports:
      - "4884:4884"
```

`--host 0.0.0.0` makes the server reachable from other hosts on the network (the printed URL still shows `127.0.0.1` as an openable address, with a `(listening on 0.0.0.0)` note appended). Anyone who knows the token-bearing URL can access the UI/API, so be careful about handling it: don't expose it to untrusted networks and don't share the URL.

## klaus validate

```
klaus validate [files...] [options]
```

Schema-validates flow definition YAML only — it never executes anything or makes network calls. Environment files (`environments/*.yaml`) are out of scope.

| Option | Description | Default |
|---|---|---|
| `--json` | Forces JSON output even on a TTY | — |

- **With arguments**: validates only the given files
- **Without arguments**: recursively walks the current directory and validates flow candidate YAML files (top-level `steps` key, same discovery rules and excluded directories as `GET /api/flows` used by `klaus ui`)

Output mode follows the same rule as `run` (text on a TTY, JSON on non-TTY or with `--json`; results go to stdout, diagnostics to stderr).

### Text output

Prints one line per file: `OK` (valid) or `NG` (invalid), followed by the error list for `NG` files. A one-line fix-example hint is attached only for the main error cases (invalid/missing `method`, `request`/`ws` exclusivity or requiredness, `body`/`graphql` exclusivity, an invalid `ws` URL scheme, a missing `url`, an empty `steps`, and duplicate step names). When the issue's location can be resolved to a YAML node, `(line N)` is appended to the end of the error location (the column number is not included in text output).

```
OK   flows/login.yaml
NG   flows/broken.yaml
  - steps.0.request.method (line 6): request.method is required unless request.graphql is set
    example: method: GET
```

### JSON output

```jsonc
{
  "version": 1,
  "files": [
    {
      "path": "flows/broken.yaml",
      "valid": false,
      "errors": [
        {
          "path": "steps.0.request.method",
          "message": "request.method is required unless request.graphql is set",
          "hint": "example: method: GET",
          "line": 6,
          "column": 7
        }
      ]
    }
  ]
}
```

`errors[].path` is the zod issue path joined with dots (an empty string when the issue can't be located, e.g. a YAML syntax error). `hint` is only present for the main cases (it can be undefined). `line` / `column` are the 1-based line/column of the YAML node the issue's `path` points to; they're omitted when the node can't be resolved (they can be undefined).

Exit code is **0** if every file is valid, and **2** if at least one has a YAML syntax error or schema violation. Unexpected exceptions exit with 1, same as `run`.

## klaus schema

```
klaus schema [-t <target>]
```

| Option | Description | Default |
|---|---|---|
| `-t`, `--target <target>` | The schema to print: `flow` (the flow definition YAML), `run-report` (the `run --json` output payload), `req-report` (the `req --json` output payload), `dry-run-report` (the `run --dry-run --json` output payload), or `config` ([klaus.config.yaml](config.md)) | `flow` |

Prints the JSON Schema (generated from the zod schema, 2-space pretty-printed) to stdout only — nothing is written to disk.

Each schema is also published as a static file: `https://almondoo.github.io/klaus/schema/flow.schema.json`, `https://almondoo.github.io/klaus/schema/run-report.schema.json`, `https://almondoo.github.io/klaus/schema/req-report.schema.json`, `https://almondoo.github.io/klaus/schema/dry-run-report.schema.json`, and `https://almondoo.github.io/klaus/schema/klaus-config.schema.json`, and bundled in the npm package at `node_modules/@almondoo/klaus/dist/schema/*.json`.

The `version` field of the `run --json` payload is a plain literal (currently `2`; `1` for `req --json` and `run --dry-run --json`), independent of the package version. It is bumped only when a change to this schema would break existing consumers (a field is removed, a field's type changes, or its meaning changes) — purely additive changes such as a new optional field do not bump it. Consumers should branch on `version` rather than assume the current shape is permanent.

The `request`/`ws` exclusivity and requiredness, the `body`/`graphql` exclusivity, `method` being required unless `graphql` is set, the `ws.url` scheme constraint, and step name uniqueness are all custom validations expressed via zod's `superRefine` and can't be represented in JSON Schema, so they're instead noted in the `description` of the relevant subschema. Always exits 0.

## klaus init

```
klaus init
```

Takes no options. Generates a minimal starting point in the current directory.

| Generated file | Contents |
|---|---|
| `api/example.yaml` | A single GET to `https://example.com` with a status-200 assertion (with English comments) |
| `environments/local.yaml` | A minimal environment file with a `baseUrl` |
| `AGENTS.md` | A guide for AI coding agents, compressing the command set, YAML schema essentials, assert operating guidance, exit code table, and the api/flows directory convention into about 50 lines |

Existing files are never overwritten — they're skipped, with a message printed to stdout. Any needed directories are created automatically. Always exits 0. If at least one file was generated, a hint for the next command is printed at the end: `klaus run api/example.yaml -e local`

`AGENTS.md` also includes notes for agent execution environments: don't launch `klaus ui` casually — run it in the background with explicit timeout management if you do — and OpenAI Codex CLI disables sandbox network access by default, which can make `klaus run`'s HTTP requests fail (set `network_access = true` under `[sandbox_workspace_write]` in `~/.codex/config.toml` to allow them).

## klaus history

Inspect execution history (`.klaus/history/*.jsonl`) from the CLI without starting the browser UI. By default the output is limited to a small set of fields so agents aren't flooded with large response bodies. See [Execution History](history.md) for the file conventions and schema.

### Listing (klaus history)

```
klaus history [options]
```

| Option | Description | Default |
|---|---|---|
| `--flow <name>` | Filter by flow name (exact match) | — |
| `--failed` | Only entries whose status is failed (assertion failures; runs that ended as `error` are not listed). Cannot be combined with `--status` | — |
| `--status <statuses>` | Only entries whose status is one of the comma-separated values `passed`, `failed`, `skipped`, `error` (for example `--status failed,error` lists every run that did not pass). An unknown value, or combining it with `--failed`, is an invalid argument (exit code 1) | — |
| `--last <n>` | Number of entries to fetch | 20 |
| `--fields <csv>` | Comma-separated list of fields to output | `startedAt,runId,flow,step,status,durationMs` |
| `--json` | Forces JSON output even on a TTY | — |

Output mode follows the same TTY convention as `klaus run`: a concise text table (one line per entry) when stdout is a TTY, and a compact JSON array when non-TTY (pipe / agent execution) or with `--json`. Passing `request` / `response` / `assertions` etc. to `--fields` lets you opt into the request/response bodies that are excluded by default. A snapshot assertion's `candidate` (a full masked copy of the response) is never printed by the list, even with `--fields assertions`; see `klaus history show --step`.

```
$ klaus history --last 5 --fields step,status,durationMs
step     status  durationMs
get-me   failed  3
login    passed  6
```

```
$ klaus history --json --failed
[{"startedAt":"2026-08-08T…","runId":"<uuid>","flow":"auth flow","step":"get-me","status":"failed","durationMs":3}]
```

`--status error` lists the steps that were refused by a guard (the `error` entries of [Execution History](history.md#error-codes)); add `--fields step,status,errorCode` to see why. `--status` combines with `--flow`, `--last`, and `--fields`, and works with both the JSON and the text output.

### Detail view (klaus history show)

```
klaus history show <runId> [--step <name>]
```

Prints every history entry matching the given `runId`, as stored (secrets already masked), as a JSON array (always JSON, regardless of TTY). Pass `--step` to narrow it down to a single step. A snapshot assertion's `candidate` (the full masked response copy kept for `klaus snapshot accept`) is left out when the whole run is printed and included only with `--step`. If nothing matches, an error is printed to stderr and it exits with 1.

```
$ klaus history show 3fa1c2e0-... --step get-me
[{"v":1,"runId":"3fa1c2e0-...","flow":"auth flow","step":"get-me","status":"failed", …}]
```

The intended workflow is to use the `runId` / `step` from `klaus history`'s list output, then drill into the entries that need full detail with this command.

## klaus diff

Compare two recorded runs from history, step by step. Details (what is compared, ignoring volatile values, the JSON shape) are in [Comparing Runs](history.md#comparing-runs).

```
klaus diff [runA] [runB] [options]
```

Pass two run IDs (exact match), or `latest` / `previous` together with `--flow`. With `--flow <name>` and no run IDs, `previous` is compared with `latest`.

| Option | Description | Default |
|---|---|---|
| `--flow <name>` | Flow name. Required for `latest` / `previous`, and limits the comparison to that flow | — |
| `--ignore-header <name>` | Response header to exclude (repeatable, case-insensitive), in addition to the default list | — |
| `--no-default-ignores` | Do not exclude the default volatile response headers | — |
| `--ignore-path <jsonpath>` | JSON path to exclude from body comparisons (repeatable), e.g. `$.id`, `$.items[*].createdAt`, `$..updatedAt` | — |
| `--duration-threshold <ms>` | Report a step as different when its duration changed by more than this many milliseconds | durations ignored |
| `--max-differences <n>` | Differences kept per step and section; the rest is counted as "and N more" | 50 |
| `--max-value-length <n>` | Truncate values in the output to n characters | 80 in text, no limit in JSON |
| `--json` | Force JSON output even on a TTY | — |
| `--text` | Force text output even when stdout is not a TTY | — |

Output follows the usual TTY convention (JSON when stdout is not a TTY). `--json` and `--text` cannot be combined.

| Exit code | Meaning |
|---|---|
| 0 | No differences |
| 1 | Invalid arguments (including conflicting flags, a bad `--ignore-path`, `latest` / `previous` without `--flow`), an unknown run ID or no matching `latest` / `previous` (like `klaus history show`), or an unexpected error |
| 4 | Differences found |

## klaus promote

Turn recorded history into a re-runnable flow YAML with assertions inferred from the observed responses. Details (request reconstruction, inferred assertions, chained values) are in [Promoting Runs to a Flow](history.md#promoting-runs-to-a-flow).

```
klaus promote <runId...> [options]
```

| Option | Description | Default |
|---|---|---|
| `-o, --out <path>` | Output file, relative to the current directory and inside it | `api/<name>.yaml` for one step, `flows/<name>.yaml` for several |
| `--stdout` | Print the YAML to stdout instead of writing a file (the summary goes to stderr) | — |
| `--force` | Overwrite the output file if it exists | — |
| `--assert <mode>` | Assertions to infer: `status`, `schema` (status + content-type + bodySchema), `values` (status + content-type + stable scalar equals), `all` | `schema` |
| `--base-url-var <name>` | Replace the origin of every URL with <code v-pre>{{name}}</code> and print the value to put in the environment file | — |
| `--no-chain` | Do not infer capture links between steps | — |
| `--allow-template-literals` | Emit recorded request values that contain a literal <code v-pre>{{</code> instead of refusing (they are expanded as templates when the flow runs; review each one) | — |
| `--name <name>` | Flow name | the recorded flow name, or derived from the host |
| `--flow <name>` | When a run contains several flows, the flow to promote | — |
| `--json` | Force JSON summary output even on a TTY | — |
| `--text` | Force text summary output even when stdout is not a TTY | — |

Several run IDs are concatenated in the given order. `--stdout` cannot be combined with `--out` or `--force`, and `--json` cannot be combined with `--text`.

| Exit code | Meaning |
|---|---|
| 0 | The flow was generated (and written, unless `--stdout`) |
| 1 | Invalid arguments, an unknown run ID, a run with several flows and no `--flow` (like `klaus history show`), or an unexpected error |
| 2 | The output file already exists, an output path outside the current directory or through an unsafe symbolic link, nothing promotable, a recorded value containing a literal <code v-pre>{{</code> (without `--allow-template-literals`), a masked value that cannot be reproduced, or a generated flow that is invalid |

Secrets that history stores unmasked (values from environment files, `--var`, or captures) are replaced with <code v-pre>{{env.TODO_*}}</code> placeholders when they sit under sensitive keys or headers or look like tokens, and the command always prints a notice to review the file for sensitive data before committing it.

## klaus mock

Serve the responses recorded with `klaus run --record <dir>` from a local HTTP server, without any network access. Details (matching rule, responses, an example) are in [Mock server](record-replay.md#mock-server).

```
klaus mock <dir> [options]
```

| Option | Description | Default |
|---|---|---|
| `-p, --port <n>` | Port to listen on (`0` picks a free port) | 4885 |
| `-H, --host <host>` | Address to bind (`0.0.0.0` to accept outside connections) | `127.0.0.1` |
| `--cors` | Add permissive CORS headers and answer preflight requests | — |
| `--delay <ms>` | Fixed latency added to every response | — |
| `--ignore-query` | Match on method and path only | — |
| `--sequence` | Serve repeated recordings of the same request in recorded order | — |
| `--origin <url>` | Serve only entries recorded for this origin | — |
| `--allow-host <host>` | Also accept this `Host` header name (repeatable; widens the DNS-rebinding check) | — |
| `--json` | Startup line (stdout) and request logs (stderr) as JSON Lines | — |

The server runs until SIGINT / SIGTERM, then exits 0. Exit codes: **2** when the cassette is missing, invalid, or empty, or `--origin` matches no recorded entry; **1** for invalid option values (such as `--port 99999` or a malformed `--origin`), for the port being in use, and for any other runtime failure.

## klaus snapshot

Review and accept `assert.snapshot` results recorded in history ([snapshot](flow-definition.md#snapshot-baseline-comparison)). Both subcommands read history; only `accept` writes, and it writes only snapshot files.

```
klaus snapshot list [runId] [options]
klaus snapshot accept <runId> [options]
```

| Subcommand | Description |
|---|---|
| `list [runId]` | Lists the snapshot mismatches of a run, including baselines that were missing and not written. Without `runId` it uses the latest run in history that has a snapshot assertion. Read-only |
| `accept <runId>` | Writes each pending snapshot of the run as the new baseline, from the masked response stored in history. All pending snapshots of the run unless `--step` is given |

| Option | Description |
|---|---|
| `--step <name>` | Only the snapshots of this step (both subcommands) |
| `--json` | Force JSON output even on a TTY |
| `--text` | Force text output even when stdout is not a TTY |

`accept` validates the recorded candidate like any baseline entry (a malformed one is refused as `corrupt`) and refuses one recorded from a step whose other assertions failed (`failed-step`). It uses the candidate recorded in history when the run happened, so it does not call the API again and the baseline equals what that run saw. It writes only files named `<dir>/__snapshots__/<name>.snap.json` inside the current directory, never through a symbolic link, and leaves the other keys of a file untouched. Review the `git diff` of the snapshot files afterwards.

`list --json` prints `{ "version": 1, "runId": "...", "mismatches": [{ "flow", "step", "iteration"?, "flowFile"?, "snapshotFile", "key", "state", "message", "differences", "differenceCount", "otherAssertionsFailed" }] }`. `otherAssertionsFailed` is true when another assertion of that step (including the OpenAPI check) failed in the recorded run; such a candidate cannot be accepted. `accept --json` prints `{ "version": 1, "runId": "...", "accepted": [{ "key", "snapshotFile", "state": "written" | "updated" }], "failed": [{ "key", "snapshotFile", "kind", "message" }] }`.

| Exit code | Meaning |
|---|---|
| 0 | Success (`list` always; `accept` when everything was written) |
| 1 | Invalid arguments (including `--json` with `--text`), an unknown run ID, no run with snapshot assertions (`list` without a run ID), nothing pending to accept (`accept`), or an unexpected error |
| 2 | `accept`: a snapshot file or the recorded candidate is corrupt, a path cannot be written safely (outside the current directory, not under `__snapshots__`, a symbolic link, a hidden directory), or the step's other assertions failed (`kind: "failed-step"` in the JSON) |

## klaus mcp

Run a stdio [Model Context Protocol](https://modelcontextprotocol.io) server that exposes klaus operations as tools to an AI agent. Registration, the tool list, and the guardrails are in [MCP server for AI agents](./mcp.md).

```
klaus mcp [options]
```

| Option | Description |
|---|---|
| `--read-only` | Do not register the tools that write files (`klaus_promote`, `klaus_snapshot_accept`) |

There is no `--allow-protected`, no `--no-mask`, and no way to pass guard options: the guards come from `klaus.config.yaml` only. Set `guard.allowedHosts` when you use it: it is what limits where an agent can send, while `$protected` only gates runs that select that environment (see [MCP server for AI agents](mcp.md#what-the-guards-cover)). The server uses the current directory as the project, speaks MCP on stdin/stdout only (no network listener), and writes every diagnostic to stderr. It exits 0 when stdin closes or on SIGINT / SIGTERM; an unexpected failure before it starts exits 1.
