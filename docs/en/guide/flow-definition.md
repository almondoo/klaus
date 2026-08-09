# Flow Definition Reference

klaus request definitions are plain YAML. **One file = one flow (a sequence of steps)**, with captures and assertions embedded directly in the definition. The schema is validated with zod; violations result in exit 2 (ParseError).

## File Structure

```yaml
name: auth flow        # Required: flow name
env: local             # Optional: references environments/local.yaml
steps:                 # Required: at least one. name must be unique within the flow
  - name: login
    request: { ... }   # Exactly one of request / ws is required (mutually exclusive)
    sse: { ... }       # Optional: SSE receive settings
    capture: { ... }   # Optional: captures variables from the response
    assert: { ... }    # Optional: assertions
```

- Environment files are resolved as `environments/<name>.yaml` by searching upward from the cwd (stopping at the first ancestor directory containing `.git`, or at the filesystem root). See [Getting Started](getting-started.md) for details. `klaus run --env <name>` overrides the flow's `env:`
- Environment files are a flat map of `key: string value`. Values can use templates (such as <code v-pre>{{env.X}}</code>)

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
  token: "$.token"     # variable name: JSONPath
```

- Applies a JSONPath to the JSON response, making the result available as a template variable in subsequent steps (the classic case being login → token → Authorization header)
- **If it doesn't match, or the response isn't JSON, this is a RuntimeError** and the step becomes error (exit 3). A silent chain like `Bearer undefined` cannot happen. A capture whose value is `null` is treated as a success
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
| Duration | `duration` | `maxMs` |
| SSE event count | `eventCount` | `min` / `max` / `equals` |
| SSE event | `events[]` | `index?` + `path?` + the matchers above |
| WS message count | `messageCount` | `min` / `max` / `equals` |
| WS message | `messages[]` | `index?` + `path?` + the matchers above |

Common semantics for `events` / `messages`:

- When `index` is given: evaluated against the received data at that index
- When `index` is omitted: **passes if any received data item matches**
- When `path` is given: the received data (`data`) is JSON-parsed and the JSONPath is applied. When omitted, the matcher is applied to the raw string

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

**Note**: constraints enforced via `superRefine` and described elsewhere on this page — the mutual exclusivity of `request.body` and `request.graphql`, requiring exactly one of `step.request` / `step.ws`, the `ws.url` scheme restriction, and step name uniqueness — are not expressible in the JSON Schema structure itself (they are noted in the `description` of the relevant properties). These are enforced only by runtime validation in `klaus validate` / `klaus run`.
