# Flow Definition Reference

klaus request definitions are plain YAML. **One file = one flow (a sequence of steps)**, with captures and assertions embedded directly in the definition. The schema is validated with zod; violations result in exit 2 (ParseError).

## File Structure

```yaml
name: auth flow        # Required: flow name
env: local             # Optional: references environments/local.yaml
tags: [smoke, auth]    # Optional: flow-level tags, used by `klaus run --tags` / `--exclude-tags`
steps:                 # Required: at least one. name must be unique within the flow
  - name: login
    request: { ... }   # Exactly one of request / ws / use is required (mutually exclusive)
    sse: { ... }       # Optional: SSE receive settings
    capture: { ... }   # Optional: captures variables from the response
    assert: { ... }    # Optional: assertions
```

- Environment files are resolved as `environments/<name>.yaml` by searching upward from the cwd (stopping at the first ancestor directory containing `.git`, or at the filesystem root). See [Getting Started](getting-started.md) for details. `klaus run --env <name>` overrides the flow's `env:`. `klaus run --env-file <path>` loads an environment file from an arbitrary path instead (no upward search), and `klaus run --var <key=value>` adds or overrides individual variables on top — see [CLI Reference](cli.md#klaus-run)
- Environment files are a flat map of `key: string value`. Values can use templates (such as <code v-pre>{{env.X}}</code>)
- Setting the reserved key `$protected: true` in an environment file makes `klaus run` refuse to run against that environment by default (exit 3). It only runs when `--allow-protected` is explicitly passed. This is a guardrail against accidentally running against a production-like environment; `$protected` cannot be referenced as a template variable (<code v-pre>{{...}}</code>). Execution via `klaus ui` / the server API never passes this flag, so flows are always refused there
- `$protected: readonly` is a milder mode: without `--allow-protected`, `GET` / `HEAD` / `OPTIONS` steps run, and every other method (and WebSocket) is refused with exit 3. GraphQL steps default to `POST`, so they are refused. See [CLI Reference](cli.md#protected-environments-protected)
- `$protected` can only be set or unset by editing the file directly. It is not shown in the `klaus ui` environment editor, and saving to a protected environment (`true` or `readonly`) from the UI is refused with 403, so edit the file directly

## tags

```yaml
name: auth flow
tags: [smoke, auth]   # Optional: array of non-empty strings. No uniqueness constraint
steps: [ ... ]
```

- Flow-level only — there is no step-level tag
- Used exclusively for flow selection via `klaus run --tags <list>` / `--exclude-tags <list>` (see [CLI Reference](cli.md#tag-based-flow-selection-tags-exclude-tags)); tags themselves have no other effect on execution
- Not exposed in `klaus ui` or the server API

## http (HTTP client settings)

```yaml
name: login flow
http:
  followRedirects: true   # Optional: follow 3xx one hop at a time (default false)
  maxRedirects: 5         # Optional: default 10
  cookies: true           # Optional: keep Set-Cookie in memory for this run (default false)
steps: [ ... ]
```

- `auth` is the flow-wide default [authentication helper](#auth-authentication-helpers); a step's own `request.auth` takes precedence.
- One HTTP client is created per run of the flow and shared by all steps (HTTP, SSE, and WebSocket). It is closed when the run ends; cookies are never persisted.
- Each key overrides the same key in the `http` section of `klaus.config.yaml` ([HTTP client](config.md#http-client-http)). With nothing set, redirects are not followed and no cookies are kept.
- Every redirect hop is checked against `guard.allowedHosts` and `$protected` like a normal request; a refused hop makes the step `error` (exit code 3) and is recorded in history. The visited URLs appear as `redirects` in the step result, history, and the `run` JSON output.
- Moving to another origin (scheme, host, or port differs, including an https to http downgrade on the same host) drops `Authorization`, `Cookie`, and `Proxy-Authorization`, plus every header whose value contains a registered secret (an <code v-pre>{{env.X}}</code> value, a cookie value, and their encoded forms), since API keys often travel in custom headers such as `X-Api-Key`. Headers without a secret (`Accept`, `User-Agent`, `Content-Type` when the body is kept, other custom headers) are still forwarded. The dropped header names (names only, per hop) are recorded as `droppedHeaders` in the step result and history. A secret shorter than 4 characters is not recognized.
- Cookie values are secrets: they are masked in history and output. Cookies are re-derived from the jar for every hop and for WebSocket handshakes. A `Secure` cookie is never sent over `http://`.
- Cookies are never shared across subdomains: every cookie is stored for the exact host that set it, even when `Domain` names a parent (there is no public suffix list, so this is the safe fallback). A flow that logs in on one subdomain and then calls another must pass the session explicitly, for example by capturing it from the login response and sending it in a header.
- `proxy` and `tls` are **not accepted in a flow** (validation error, exit code 2). They decide where traffic goes and whom it trusts, so they can only be set in `klaus.config.yaml`.

## request (HTTP step)

```yaml
request:
  method: POST                  # Can be omitted only when graphql is specified (defaults to POST). Treated as uppercase
  url: "{{baseUrl}}/login"      # Required. Supports templates
  headers:                      # Optional. Values support templates
    Content-Type: application/json
  query:                        # Optional. Values support templates
    page: "1"                   #   Merged into the url's query string. If url already has the same key, query wins
  body:                         # Optional. object → sent as JSON (application/json is auto-set if Content-Type is unspecified)
    email: "{{testEmail}}"      #        string → sent as-is
  # form / multipart / bodyFile: alternatives to body (see below)
  timeoutMs: 30000              # Optional. Defaults to 30000. Exceeding it is a RuntimeError (exit 3)
```

If the Content-Type is JSON, the response is automatically parsed and becomes the target of JSONPath assertions / captures. Otherwise it's kept as text and becomes the target of `bodyText` assertions. Redirects are not followed unless `http.followRedirects` is set (see [http](#http-http-client-settings)).

The query string already written in `url` is kept byte for byte (it is not re-parsed or re-encoded, so a value containing `&`, `+`, `=`, or `/` reaches the server as written). Only the `query` entries are added, form-urlencoded; an entry whose key already appears in `url` replaces the first occurrence and drops later ones.

### form, multipart, and bodyFile

```yaml
request:
  method: POST
  url: "{{baseUrl}}/login"
  form:                          # application/x-www-form-urlencoded
    username: "{{user}}"
    password: "{{env.PASSWORD}}"
```

```yaml
request:
  method: POST
  url: "{{baseUrl}}/upload"
  multipart:                     # multipart/form-data
    title: "Quarterly report"    #   a string is a text field
    attachment:                  #   an object with `file` uploads a file
      file: reports/q3.pdf       #     relative to the cwd (required)
      filename: q3.pdf           #     optional, defaults to the file's base name
      contentType: application/pdf   # optional
```

```yaml
request:
  method: PUT
  url: "{{baseUrl}}/blobs/1"
  headers: { Content-Type: application/octet-stream }
  bodyFile: blobs/one.bin        # the file's bytes are sent as the body
```

- `body`, `graphql`, `form`, `multipart`, and `bodyFile` are mutually exclusive (validation error otherwise). Values and file paths support templates.
- `form` adds `Content-Type: application/x-www-form-urlencoded` unless you set one. `multipart` always sets `Content-Type: multipart/form-data` with its boundary; a `Content-Type` header you set on a multipart request is ignored. `bodyFile` adds no `Content-Type`; set one in `headers` if the API needs it.
- Files must be inside the current directory (symbolic links are resolved first), the same rule as `step.use` and `klaus req --body @file`, so a flow cannot send arbitrary files from elsewhere on the machine. A path outside the cwd is refused like a guard refusal: the step ends as `error` (exit code 3), nothing is sent, and the refusal is recorded in history. A missing file or a directory is also an `error`. The files are read right before sending.
- History, `--json` output, and `--dry-run` record only the file name and size for file parts and `bodyFile` (for example `{ "bodyFile": "blobs/one.bin", "size": 5 }`), never the content. Secrets inside `form` values and multipart text fields are masked, including their form-encoded forms.
- With `http.followRedirects`, `307` / `308` re-send the body (including the file) and `301` / `302` on `POST` and `303` become a body-less `GET`.

## auth (authentication helpers)

```yaml
http:
  auth:                                  # Optional: default for every HTTP / SSE step in the flow
    bearer: { token: "{{env.API_TOKEN}}" }
steps:
  - name: admin call
    request:
      method: GET
      url: "{{baseUrl}}/admin"
      auth:                              # Optional: overrides http.auth for this step
        basic: { username: admin, password: "{{env.ADMIN_PASSWORD}}" }
  - name: public call
    request:
      method: GET
      url: "{{baseUrl}}/public"
      auth: none                         # Disables an inherited http.auth for this step
  - name: machine to machine
    request:
      method: GET
      url: "{{baseUrl}}/reports"
      auth:
        oauth2:
          grant: client_credentials      # The only supported grant
          tokenUrl: "{{authUrl}}/oauth/token"
          clientId: "{{clientId}}"
          clientSecret: "{{env.CLIENT_SECRET}}"
          scope: "reports:read"          # Optional
          audience: "https://api.example.com"   # Optional
```

- Exactly one of `basic`, `bearer`, `oauth2` (or the string `none`). All values support templates. The helper sets the `Authorization` header; a step that also sets its own `Authorization` header is an error.
- `basic` sends `Authorization: Basic <base64(username:password)>`, `bearer` sends `Authorization: Bearer <token>`.
- `oauth2` fetches an access token with `POST` to `tokenUrl` (`application/x-www-form-urlencoded`, with `grant_type`, `client_id`, `client_secret`, and the optional `scope` / `audience` in the body) and sends it as `Authorization: Bearer <token>` (or the `token_type` the server returns). The token is cached for the run and fetched again when its `expires_in` has passed (5 seconds early); without `expires_in` it is kept for the whole run. The token request is not a step and is not recorded in history, but it goes through the same checks as any request: it must satisfy `guard.allowedHosts`, so the token endpoint's host has to be allowed too, and under `$protected: readonly` it is refused because it is a `POST` (use `--allow-protected` to run such a flow). It never follows redirects, and works with `--record` / `--replay`. A failed token request ends the step as `error` without echoing the secret.
- Passwords, tokens, client secrets, fetched access tokens, and the base64 form of `username:password` are secrets: they are masked in history, stdout, JSON, reports, and error messages (a secret shorter than 4 characters is not recognized).
- `auth` applies to HTTP and SSE steps; WebSocket steps set their own `headers`.
- The `Authorization` header is dropped when a redirect moves to another origin (see [http](#http-http-client-settings)). `klaus run --dry-run` shows the header with secrets masked and never fetches a token (an OAuth2 step shows a placeholder).

## GraphQL

Specifying `request.graphql` is sugar for a GraphQL request. **It's mutually exclusive with `body`** (specifying both is a ParseError).

```yaml
request:
  url: "{{baseUrl}}/graphql"
  graphql:
    query: 'query { user(id: "{{userId}}") { id name } }'   # Supports templates
    variables:                                              # Optional. Supports templates
      limit: 10
```

- If method is omitted it defaults to POST; if Content-Type is unspecified it defaults to application/json
- The sent body is `{ query, variables }` (just `{ query }` if variables is unspecified)
- The response is treated as regular JSON, so JSONPath assertions and captures against `$.data.…` / `$.errors` work as usual

## SSE (Server-Sent Events)

A step becomes SSE mode if it has an `Accept: text/event-stream` header, or if an `sse:` block is written.

```yaml
request:
  method: GET
  url: "{{baseUrl}}/events"
  headers:
    Accept: text/event-stream
sse:
  maxEvents: 5          # Defaults to 100
  maxDurationMs: 3000   # Defaults to 10000
```

- Receiving stops as soon as **either `maxEvents` or `maxDurationMs` is reached, and the step ends successfully** (stopping is not a failure)
- Received events go into the result's `events` field as an array of `{ event?, id?, data }`. `response.body` is undefined
- `capture` is **ignored** for SSE steps
- Assertions use `eventCount` / `events` (described below)

## WebSocket

Write `ws:` in place of `request` for the step (**mutually exclusive — exactly one is required**).

```yaml
ws:
  url: "{{wsBaseUrl}}/socket"   # ws:// / wss:// (http(s):// is a ParseError). Supports templates
  headers:                      # Optional
    Authorization: "Bearer {{token}}"
  send:                         # Optional: sent in order after connecting. string is sent as-is, object is JSON-encoded. Supports templates
    - "ping"
    - { type: subscribe, channel: orders }
  maxMessages: 50               # Defaults to 100
  maxDurationMs: 5000           # Defaults to 10000
```

- The connection is closed and the step ends successfully once received messages reach either `maxMessages` or `maxDurationMs`. A normal close from the other side also ends successfully
- Connection failure or an abnormal close is a RuntimeError (exit 3)
- Received messages go into the result's `wsMessages` field as an array of `{ data }`. There is no `response`
- `capture` is **ignored** for WS steps
- Assertions use `messageCount` / `messages` (described below)

## use (step reference)

A step can write `use:` instead of `request` / `ws` to reuse another flow definition file (one that contains a single step) by pulling in its request / sse / assert. It's **mutually exclusive** with `request`, `ws`, and `sse` (writing both is a ParseError). This lets multiple flows reuse the same API check without copy-pasting the request definition, while the referenced file itself can still be run standalone as before (the design treats `api/` as an "executable API catalog" — see the [examples](https://github.com/almondoo/klaus/tree/main/examples) for details).

```yaml
# api/login-check.yaml — still runnable standalone
name: Login API check
steps:
  - name: login
    request:
      method: POST
      url: "{{baseUrl}}/login"
      body: { email: "{{testEmail}}" }
    assert:
      status: 200
      body:
        - path: "$.token"
          exists: true
```

```yaml
# flows/auth-flow.yaml — reuse login without rewriting it
name: Auth flow
steps:
  - name: login
    use: ../api/login-check.yaml   # path relative to this flow file
    capture:
      token: "$.token"
  - name: me
    request:
      method: GET
      url: "{{baseUrl}}/me"
      headers:
        Authorization: "Bearer {{token}}"
    assert:
      status: 200
```

- **Resolution timing**: at flow load time (`klaus run` / `klaus validate` / the UI's flow detail endpoint). The referenced file's single step is expanded into a normal step (taking its `request` / `sse` / `assert`) before execution
- **`name` / `capture` always come from the calling step**; the referenced step's values are ignored
- **`assert` is merged additively** (not replaced): `headers` / `body` / `events` / `messages` are concatenated in referenced-then-caller order. `status` / `bodyText` / `duration` / `eventCount` / `messageCount` / `bodySchema` become a ParseError / a `klaus validate` FlowIssue if defined on both sides, since that would weaken the guarantee made by the standalone check (define it on only one side, or let the referenced step's definition win)
- **The referenced file's `env:` is not pulled in** (the environment is always decided by the flow that's actually running). Placeholders (<code v-pre>{{var}}</code>) are resolved as usual, after expansion, using the calling flow's env / captures
- **The path must be relative to this flow file.** Absolute paths are rejected. A resolved path that falls outside the project directory (the cwd `klaus` is run from) is also rejected (no escaping the project root via `../`)
- If the referenced step itself has `use`, it's resolved recursively. Circular references are detected and rejected

### v1 Limitations

- The referenced file must contain **exactly one step** (pulling in multiple steps, inheritance, or overriding request fields is out of scope)
- The referenced step must be an **HTTP request step** (referencing a `ws:` step is not supported)
- A broken reference, a circular reference, a reference to a multi-step file, or a scalar `assert` conflict becomes a hinted, structured issue in `klaus validate`, and a ParseError (exit 2) in `klaus run`

## Templates

<code v-pre>{{...}}</code> is resolved in the following order. **An unresolved variable or an undefined OS environment variable results in a RuntimeError (exit 3)** (it does not silently become an empty string).

| Syntax | Resolves to |
|---|---|
| <code v-pre>{{var}}</code> | ① capture variables from prior steps → ② values from the environment file (captures take precedence) |
| <code v-pre>{{env.X}}</code> | The OS environment variable `X`. Use this for secrets instead of hard-coding them into the definition file |
| <code v-pre>{{newUuid}}</code> | A UUID from `crypto.randomUUID()` |
| <code v-pre>{{newDate}}</code> | The current time as an ISO 8601 string |
| <code v-pre>{{newTimestamp}}</code> | The current time as epoch milliseconds |

Where expansion applies: `request.url` / values of `request.headers` / values of `request.query` / `request.body` (deep expansion of string values) / `graphql.query` / `graphql.variables` / `ws.url` / `ws.headers` / `ws.send` / assertion expected values (such as <code v-pre>equals: "{{testEmail}}"</code>).

## capture (variable capture)

```yaml
capture:
  token: "$.token"            # variable name: JSONPath
  userId: "$.data.user.id"    # nested field
  firstId: "$.items[0].id"    # array index
  requestId: { header: X-Request-Id }          # response header (name is case-insensitive)
  session: { cookie: sid }                     # cookie from the run's cookie jar (needs http.cookies: true)
  orderNo: { regex: "order=(\\w+)", group: 1 }  # regex over the response body text
  code: { status: true }                       # HTTP status code (a number)
```

- Applies a JSONPath to the JSON response, making the result available as a template variable in subsequent steps (the classic case being login → token → Authorization header)
- **If it doesn't match, or the response isn't JSON, this is a RuntimeError** and the step becomes error (exit 3). A silent chain like `Bearer undefined` cannot happen. A capture whose value is `null` is treated as a success
- **Captured values are not masked.** Secret masking covers only values resolved via <code v-pre>{{env.X}}</code>, so a token captured here is written as-is to the history JSONL, the JUnit report, and record cassettes. See [SECURITY.md](https://github.com/almondoo/klaus/blob/main/SECURITY.md) for the masking boundaries
- Object forms (exactly one key each; mixing keys is a ParseError):
  - `{header: name}`: the response header value. Not found is a RuntimeError
  - `{cookie: name}`: the cookie's current value in the run's cookie jar, looked up for the final URL (cookies set by a redirect hop are included). Requires `http.cookies: true`; with no jar, or no such cookie, it is a RuntimeError
  - `{regex, group?}`: applied to the response body text (works on non-JSON bodies too). `group` defaults to 1 when the pattern has capture groups, otherwise 0 (the whole match). No match, or a group that did not participate, is a RuntimeError. The pattern is used as written (capture definitions are not template-rendered), so it cannot be steered by another capture
  - `{status: true}`: the status code as a number
- Error messages never include the captured value or the response body
- Ignored on SSE / WS steps

## assert (assertions)

All fields are optional. If multiple are given, all are evaluated; if even one fails, the step becomes failed (exit 4). Writing multiple matchers on a single entry produces a separate result (`AssertionResult`) per matcher.

```yaml
assert:
  status: 200                 # also: [200, 201] (any of) or "2xx" (a status class)
  headers:
    - { name: content-type, contains: json }
    - { name: content-length, lte: 100000 }
  body:
    - { path: "$.token", exists: true, type: string, length: { min: 20 } }
    - { path: "$.email", equals: "{{testEmail}}" }
    - { path: "$.total", gte: 0 }
    - { path: "$.state", oneOf: [pending, paid] }
  bodyText:
    contains: "ok"
  bodySchema:
    type: object
    required: [id, email]
    properties:
      id: { type: integer }
      email: { type: string, format: email }
  duration:
    maxMs: 1000
  # For SSE
  eventCount: { min: 1, max: 10 }
  events:
    - { index: 0, path: "$.type", equals: "message" }
  # For WebSocket
  messageCount: { min: 1 }
  messages:
    - { path: "$.type", contains: "order" }
```

### Matcher List

| Target | Field | Matcher |
|---|---|---|
| Status | `status` | a number (exact), an array of numbers (any of), or `"2xx"` (class `1xx`-`5xx`) |
| Headers | `headers[]` | `name` + `equals` / `contains` / `regex` / `exists` + the comparison matchers below |
| Body (JSONPath) | `body[]` | `path` + `exists` / `equals` / `contains` / `regex` + the comparison matchers below |
| Body (raw text) | `bodyText` | `equals` / `contains` / `regex` |
| Body (JSON Schema) | `bodySchema` | a JSON Schema object |
| Duration | `duration` | `maxMs` |
| SSE event count | `eventCount` | `min` / `max` / `equals` |
| SSE event | `events[]` | `index?` + `path?` + the matchers above |
| WS message count | `messageCount` | `min` / `max` / `equals` |
| WS message | `messages[]` | `index?` + `path?` + the matchers above |

Comparison matchers (`headers[]` and `body[]` only; each produces its own result and fails when the value does not exist):

| Matcher | Passes when |
|---|---|
| `gt` / `gte` / `lt` / `lte` | the value is a number satisfying the comparison. In `body[]` a numeric string such as `"7"` does **not** count as a number; header values are always strings, so a numeric string is compared as a number there (a non-numeric header fails) |
| `length` | a string or array has exactly this length (number), or a length within `{min, max}` (inclusive, either bound optional). Objects and other types fail |
| `type` | the JSON type is `string` / `number` / `integer` / `boolean` / `null` / `array` / `object` (`number` also accepts integers) |
| `oneOf` | the value structurally equals any element of the array (objects and arrays included) |

Common semantics for `events` / `messages` (they accept `exists` / `equals` / `contains` / `regex` only):

- When `index` is given: evaluated against the received data at that index
- When `index` is omitted: **passes if any received data item matches**
- When `path` is given: the received data (`data`) is JSON-parsed and the JSONPath is applied. When omitted, the matcher is applied to the raw string

### bodySchema (JSON Schema body validation)

- `bodySchema` takes a JSON Schema object embedded directly in the YAML (referencing an external file is not supported yet)
- Validation is performed with [ajv](https://ajv.js.org/) using **draft 2020-12** (`Ajv2020`). Schemas originating from OpenAPI 3.1 generally work as-is
- When the schema has multiple violations, **a separate `AssertionResult` is returned for each violation** (evaluation is not short-circuited on the first failure; all violations are reported together). Each result's `message` includes ajv's `instancePath` (`(root)` for a root-level violation) and the violation detail
- SSE / WS steps, which have no body, always yield ok:false. An HTTP response whose body exists but fails to parse as JSON is validated against the schema as the raw string (e.g. a schema requiring `type: object` fails, while `type: string` may pass)
- If the schema itself is invalid and ajv fails to compile it, this does not throw; it's reported as an ok:false assertion failure instead

### `regex` patterns are template-rendered

Like other assertion values, the pattern given to a `regex` matcher (`assert.headers[].regex`, `assert.body[].regex`, `assert.bodyText.regex`, `assert.events[].regex`, `assert.messages[].regex`) is template-rendered before matching, so <code v-pre>{{...}}</code> in it is not limited to a literal — it can resolve from a capture or a `--var`. Because a capture is populated from the response body of the API under test, a flow that feeds a captured value into `regex` effectively lets that API choose the pattern used to check it. A catastrophic-backtracking pattern (e.g. `^(a+)+$`) then makes matching take exponentially longer per added character of input — a few dozen characters is already enough to hang for well over a minute — and no timeout bounds assertion evaluation (unlike `request.timeoutMs`, which covers only the HTTP request itself). In `klaus ui`, this blocks the shared server process, not just the run.

This is an availability effect only (the run hangs; no data is exposed or altered), and reaching it already requires the ability to run/edit flows (the session token in `klaus ui`). It also only happens when a flow deliberately routes a captured or `--var` value into `regex` — a literal pattern written directly in the flow file is unaffected. `contains` and `equals` do not evaluate a pattern, so they are unaffected regardless of where their value comes from. See [SECURITY.md](https://github.com/almondoo/klaus/blob/main/SECURITY.md) for the related regex-timeout scope note.

## if

```yaml
steps:
  - name: login
    request: { method: POST, url: "{{env.baseUrl}}/login" }
    assert: { status: 200 }
  - name: cleanup
    request: { method: DELETE, url: "{{env.baseUrl}}/session" }
    if: steps.login.status == "passed"   # only run when login passed
  - name: use-token
    request: { method: GET, url: "{{env.baseUrl}}/me", headers: { Authorization: "Bearer {{token}}" } }
    if: captures.token != ""
```

- `if` gates whether the step runs at all. It is a small, intentionally limited condition grammar — **not** a general expression language — evaluated by `src/core/condition.ts`:
  - `ref op literal`, where `ref` is `steps.<name>.status` or `captures.<name>`, `op` is `==` or `!=`, and `literal` is a double-quoted string, a single-quoted string, or a bare token with no whitespace
  - `stepName` / `captureName` may not contain `.` or whitespace
  - Quoted literals do not support escape sequences; to include the other quote character in a value, wrap it in the opposite quote style (e.g. use single quotes to include a `"`)
  - A literal that starts with `'` or `"` must end with the same quote character; an unterminated quote (e.g. `captures.token == "abc`) is **not** silently treated as a bare token — it is rejected as a malformed expression (RuntimeError)
  - Comparison is always done as a string. The `captures.<name>` side is coerced the same way template rendering (e.g. <code v-pre>{{token}}</code>) stringifies values — objects/arrays are JSON-stringified, other values via `String()`; `steps.<name>.status` is already a string
- **No <code v-pre>{{...}}</code> template rendering is applied inside `if`.** Reference prior captures directly via `captures.<name>` (not <code v-pre>{{name}}</code>)
- `steps.<name>.status` can only reference a step that appears **earlier** in the same flow and has already completed (including one that finished via `continueOnError`, in which case its real `failed`/`error` status is visible to later conditions — this is the point of combining `if` with `continueOnError`, e.g. running cleanup only when setup passed)
- When the condition evaluates to **false**, the step becomes `skipped` **without executing** (no request is sent, `retry` does not apply) with `error: "skipped because condition not met: <expression>"`. This does not skip the rest of the flow — later steps still run as normal (see [Flow Behavior on Step Failure](#flow-behavior-on-step-failure) for the distinct "previous step failed" skip reason)
- When the condition **throws** — a malformed expression, or a reference to an unknown step/capture name — the step becomes `error` with the underlying message (e.g. listing the available step/capture names), and this follows the normal error semantics described below (remaining steps are skipped unless `continueOnError` is set)
- A `skipRest` in effect from an earlier unhandled failure (see below) takes priority: if the flow is already skipping remaining steps, `if` is not even evaluated for this step

## retry

```yaml
retry:
  count: 3          # Required. Number of retries after the first attempt (1-100)
  intervalMs: 500   # Optional. Fixed wait between attempts in milliseconds. Defaults to 1000
```

- `count` is the number of *retries* after the first attempt, so the step runs **at most `count + 1` times in total**
- The step is retried when its outcome is **`failed`** (assertion failure) or **`error`** (thrown exception, such as a connection failure or timeout). A `passed` outcome stops the loop immediately, even before `count` is exhausted
- The wait between attempts is fixed at `intervalMs` (no backoff, no condition expressions)
- Applies uniformly to `request`, `sse`, and `ws` steps — the whole step (request/response and assertions) is re-run on each attempt
- **Only the final attempt is recorded**: one entry in the step results, one history entry, and a single `onStepStart` / `onStepComplete` pair per step. Earlier failed/error attempts are not kept
- When `retry` is set, the result and history entry carry an `attempts` field with the number of executions actually performed (1 or more). Without `retry`, `attempts` is omitted. `durationMs` remains the final attempt's own duration, as before

## continueOnError

```yaml
steps:
  - name: optional-check
    request: { method: GET, url: "{{env.baseUrl}}/optional" }
    assert: { status: 200 }
    continueOnError: true   # Optional. Defaults to false
  - name: next-step
    request: { method: GET, url: "{{env.baseUrl}}/next" }
```

- When `continueOnError: true` is set on a step, a final outcome of **`failed`** or **`error`** on that step does not skip the remaining steps — the flow keeps running from the next step
- "Final outcome" means **after `retry` is exhausted**, if `retry` is also set: retries run first as usual, and `continueOnError` only takes effect once no more retries remain
- The step itself keeps its `failed`/`error` status, and the flow's (and run's) aggregate status and exit code are unaffected — they still reflect the failure as usual (see [CLI Reference](cli.md#exit-code))
- `continueOnError` only affects *that step's own* failure. If a *later* step without `continueOnError` fails, it still skips the steps after it, as described below

## Flow Behavior on Step Failure

- When a step becomes **failed** (assertion failure) or **error** (runtime error), the **remaining steps in that flow are not run and are recorded as skipped** (`error: "skipped because a previous step failed"`) — unless the failing step has `continueOnError: true` set, in which case the remaining steps still run (see [continueOnError](#continueonerror))
- A step whose [`if`](#if) condition evaluates to false is also recorded as `skipped`, but for a different reason (`error: "skipped because condition not met: <expression>"`) and **without** triggering the above "remaining steps skipped" behavior — the flow keeps running from the next step either way
- When multiple flow files are passed, **other flows still run** even if one flow fails
- The final exit code follows the priority rules in the [CLI Reference](cli.md#exit-code)

## JSON Schema

The flow definition schema is also published as JSON Schema. Use it for editor completion/validation, or as a reference when an AI agent generates flow YAML.

- Published URL: `https://almondoo.github.io/klaus/schema/flow.schema.json`
- Path bundled in the npm package: `node_modules/@almondoo/klaus/dist/schema/flow.schema.json`

Adding a `# yaml-language-server: $schema=` comment at the top of a YAML file enables completion and validation in editors that support it (such as VS Code's YAML extension).

```yaml
# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/flow.schema.json
name: auth flow
steps:
  - name: login
    request:
      method: POST
      url: "{{baseUrl}}/login"
```

**Note**: constraints enforced via `superRefine` and described elsewhere on this page — the mutual exclusivity of `request.body` and `request.graphql`, requiring exactly one of `step.request` / `step.ws` / `step.use`, the `ws.url` scheme restriction, and step name uniqueness — are not expressible in the JSON Schema structure itself (they are noted in the `description` of the relevant properties). These are enforced only by runtime validation in `klaus validate` / `klaus run`. `use:` reference resolution (path boundaries, circular references, additive `assert` merging, etc.) is likewise enforced during load-time validation in `klaus validate` / `klaus run`, not by the schema.
