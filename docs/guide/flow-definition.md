# Flow Definition Reference

klaus request definitions are plain YAML. **One file = one flow (a sequence of steps)**, with captures and assertions embedded directly in the definition. The schema is validated with zod; violations result in exit 2 (ParseError).

## File Structure

```yaml
name: auth flow        # Required: flow name
env: local             # Optional: references environments/local.yaml
steps:                 # Required: at least one. name must be unique within the flow
  - name: login
    request: { ... }   # Exactly one of request / ws / use is required (mutually exclusive)
    sse: { ... }       # Optional: SSE receive settings
    capture: { ... }   # Optional: captures variables from the response
    assert: { ... }    # Optional: assertions
```

- Environment files are resolved as `environments/<name>.yaml` by searching upward from the cwd (stopping at the first ancestor directory containing `.git`, or at the filesystem root). See [Getting Started](getting-started.md) for details. `klaus run --env <name>` overrides the flow's `env:`. `klaus run --env-file <path>` loads an environment file from an arbitrary path instead (no upward search), and `klaus run --var <key=value>` adds or overrides individual variables on top — see [CLI Reference](cli.md#klaus-run)
- Environment files are a flat map of `key: string value`. Values can use templates (such as <code v-pre>{{env.X}}</code>)
- Setting the reserved key `$protected: true` in an environment file makes `klaus run` refuse to run against that environment by default (exit 3). It only runs when `--allow-protected` is explicitly passed. This is a guardrail against accidentally running against a production-like environment; `$protected` cannot be referenced as a template variable (<code v-pre>{{...}}</code>). Execution via `klaus ui` / the server API never passes this flag, so protected environments are always refused there
- `$protected` can only be set or unset by editing the file directly. It is not shown in the `klaus ui` environment editor, and saving from the UI leaves any existing `$protected` value untouched

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
  timeoutMs: 30000              # Optional. Defaults to 30000. Exceeding it is a RuntimeError (exit 3)
```

If the Content-Type is JSON, the response is automatically parsed and becomes the target of JSONPath assertions / captures. Otherwise it's kept as text and becomes the target of `bodyText` assertions. Redirect and TLS behavior follow undici's defaults (klaus does not control these).

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
```

- Applies a JSONPath to the JSON response, making the result available as a template variable in subsequent steps (the classic case being login → token → Authorization header)
- **If it doesn't match, or the response isn't JSON, this is a RuntimeError** and the step becomes error (exit 3). A silent chain like `Bearer undefined` cannot happen. A capture whose value is `null` is treated as a success
- **Captured values are not masked.** Secret masking covers only values resolved via <code v-pre>{{env.X}}</code>, so a token captured here is written as-is to the history JSONL, the JUnit report, and record cassettes. See [SECURITY.md](https://github.com/almondoo/klaus/blob/main/SECURITY.md) for the masking boundaries
- Ignored on SSE / WS steps

## assert (assertions)

All fields are optional. If multiple are given, all are evaluated; if even one fails, the step becomes failed (exit 4). Writing multiple matchers on a single entry produces a separate result (`AssertionResult`) per matcher.

```yaml
assert:
  status: 200
  headers:
    - { name: content-type, contains: json }
  body:
    - { path: "$.token", exists: true }
    - { path: "$.email", equals: "{{testEmail}}" }
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
| Status | `status` | exact numeric match |
| Headers | `headers[]` | `name` + `equals` / `contains` / `regex` / `exists` |
| Body (JSONPath) | `body[]` | `path` + `exists` / `equals` / `contains` / `regex` |
| Body (raw text) | `bodyText` | `equals` / `contains` / `regex` |
| Body (JSON Schema) | `bodySchema` | a JSON Schema object |
| Duration | `duration` | `maxMs` |
| SSE event count | `eventCount` | `min` / `max` / `equals` |
| SSE event | `events[]` | `index?` + `path?` + the matchers above |
| WS message count | `messageCount` | `min` / `max` / `equals` |
| WS message | `messages[]` | `index?` + `path?` + the matchers above |

Common semantics for `events` / `messages`:

- When `index` is given: evaluated against the received data at that index
- When `index` is omitted: **passes if any received data item matches**
- When `path` is given: the received data (`data`) is JSON-parsed and the JSONPath is applied. When omitted, the matcher is applied to the raw string

### bodySchema (JSON Schema body validation)

- `bodySchema` takes a JSON Schema object embedded directly in the YAML (referencing an external file is not supported yet)
- Validation is performed with [ajv](https://ajv.js.org/) using **draft 2020-12** (`Ajv2020`). Schemas originating from OpenAPI 3.1 generally work as-is
- When the schema has multiple violations, **a separate `AssertionResult` is returned for each violation** (evaluation is not short-circuited on the first failure; all violations are reported together). Each result's `message` includes ajv's `instancePath` (`(root)` for a root-level violation) and the violation detail
- SSE / WS steps, which have no body, always yield ok:false. An HTTP response whose body exists but fails to parse as JSON is validated against the schema as the raw string (e.g. a schema requiring `type: object` fails, while `type: string` may pass)
- If the schema itself is invalid and ajv fails to compile it, this does not throw; it's reported as an ok:false assertion failure instead

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

## Flow Behavior on Step Failure

- When a step becomes **failed** (assertion failure) or **error** (runtime error), the **remaining steps in that flow are not run and are recorded as skipped**
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
