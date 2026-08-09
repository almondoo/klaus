# klaus

[![CI](https://github.com/almondoo/klaus/actions/workflows/ci.yml/badge.svg)](https://github.com/almondoo/klaus/actions/workflows/ci.yml)
![coverage](https://img.shields.io/badge/coverage-%E2%89%A590%25_lines-brightgreen)

A CLI tool for verifying local HTTP APIs. Request definitions are managed as plain YAML in git, with execution, assertions, and history management. Designed for use by both humans and AI agents (Claude Code, etc.).

Documentation site: https://almondoo.github.io/klaus/en/

[日本語](./README.md)

- **1 file = 1 flow**: Sequential execution of multiple steps, with variable capture from responses and chaining to subsequent steps
- **Built-in assertions**: Define status / header / body (JSONPath) / duration checks in the definition file
- **Agent-friendly output**: Failures can be identified from exit code alone. JSON output is the default in non-TTY environments
- **Local-first**: Execution history is appended to `.klaus/history/*.jsonl`. No cloud sync or account mechanism
- **SSE verification**: Receives `text/event-stream` with time / event-count limits and asserts on the events

## Installation

```bash
npm install -g @almondoo/klaus
# Requires Node.js >= 22.19.0
```

## Quick Start

```yaml
# api/auth-flow.yaml
name: auth flow
env: local          # References environments/local.yaml
steps:
  - name: login
    request:
      method: POST
      url: "{{baseUrl}}/login"
      headers:
        Content-Type: application/json
      body:
        email: "{{testEmail}}"
        password: "{{env.TEST_PASSWORD}}"   # References an OS environment variable
    capture:
      token: "$.token"                      # Captured via JSONPath
    assert:
      status: 200
      body:
        - path: "$.token"
          exists: true

  - name: get-me
    request:
      method: GET
      url: "{{baseUrl}}/me"
      headers:
        Authorization: "Bearer {{token}}"   # References the previous step's capture
    assert:
      status: 200
      body:
        - path: "$.email"
          equals: "{{testEmail}}"
```

```yaml
# environments/local.yaml
baseUrl: http://localhost:3000
testEmail: test@example.com
```

```bash
klaus run api/auth-flow.yaml
# PASS login (200, 45ms)
# PASS get-me (200, 12ms)
```

## CLI

```
klaus run <files...> [options]

  --env <name>          Overrides the flow's env setting
  --json                Forces JSON output even on a TTY
  --report junit        Generates a JUnit XML report
  --report-file <path>  Report output path (default: klaus-report.xml)
  --no-history          Disables writing to the history JSONL

klaus ui [options]      # Starts the localhost web UI (runner + history viewer)

  -p, --port <n>        Specifies the port (default: automatically selects a free port)
  --no-open             Suppresses automatically opening the browser
```

`klaus ui` starts a server bound to 127.0.0.1 only, and opens a URL with a startup token in the browser (protected by token authentication, Host validation, and CSRF protection; not accessible from outside).

- Human-readable text is used when stdout is a TTY; JSON is selected automatically for non-TTY (piped / agent execution)
- Text output is a one-line summary on success only. Details (expected / actual) are shown only on failure. Full details remain in the history JSONL

### Exit code

| code | meaning |
|---|---|
| 0 | All succeeded |
| 1 | General error (unexpected failure) |
| 2 | Definition file parse error |
| 3 | Runtime error (connection failure, timeout, etc.) |
| 4 | Assertion failure |

## Templates

- `{{var}}` — Reference to a captured variable or environment file value (captures take precedence)
- `{{env.X}}` — Reference to an OS environment variable. Use this instead of hardcoding secrets in definition files
- `{{newUuid}}` / `{{newDate}}` / `{{newTimestamp}}` — Template functions (UUID / ISO 8601 / epoch ms)

## Assertions

- `status: 200`
- `headers: [{ name, equals | contains | regex | exists }]`
- `body: [{ path, exists | equals | contains | regex }]` — JSONPath-based
- `bodyText: { equals | contains | regex }` — Raw text
- `duration: { maxMs }`
- For SSE: `eventCount: { min | max | equals }` / `events: [{ index?, path?, ...matchers }]`
- For WebSocket: `messageCount: { min | max | equals }` / `messages: [{ index?, path?, ...matchers }]` (same semantics as events)

## SSE Verification

For a request with `Accept: text/event-stream` (or an explicit `sse:` block), reception is cut off once the `maxEvents` / `maxDurationMs` limit is reached, and assertions run against the received event sequence.

```yaml
  - name: stream
    request:
      method: GET
      url: "{{baseUrl}}/events"
      headers:
        Accept: text/event-stream
    sse:
      maxEvents: 5
      maxDurationMs: 3000
    assert:
      eventCount: { min: 1 }
      events:
        - path: "$.type"
          equals: "message"
```

## GraphQL

When `request.graphql` is specified, if method is unspecified it defaults to POST, sending `{ query, variables }` with `Content-Type: application/json` (mutually exclusive with `body`). Assertions and captures work with regular JSONPath as-is.

```yaml
  - name: get-user
    request:
      url: "{{baseUrl}}/graphql"
      graphql:
        query: 'query { user(id: "{{userId}}") { id name } }'
    assert:
      status: 200
      body:
        - path: "$.data.user.id"
          exists: true
```

## WebSocket

Specify `ws:` instead of `request` on a step. Each message in `send` is sent sequentially, reception is cut off at the `maxMessages` / `maxDurationMs` limit and completes normally, and assertions run against the received message sequence.

```yaml
  - name: ws-echo
    ws:
      url: "{{wsBaseUrl}}/socket"
      send:
        - "ping"
        - { type: subscribe, channel: orders }
      maxMessages: 50        # default 100
      maxDurationMs: 5000    # default 10000
    assert:
      messageCount: { min: 1 }
      messages:
        - index: 0
          equals: "pong"
        - path: "$.type"
          contains: "order"
```

## Execution History

All requests / responses / durations are appended one step per line to `.klaus/history/<date>.jsonl` (the schema is versioned via the `v` field). Whether to manage this under git is up to the project (`.gitignore` is recommended when handling responses that contain secrets).

## Development

```bash
pnpm install
pnpm build      # tsup (core / cli / server); dist/ui is preserved
pnpm build:ui   # Vite (ui/ -> dist/ui)
pnpm build:all  # clean + build + build:ui (full build for release)
pnpm test           # vitest
pnpm test:coverage  # vitest + coverage (thresholds: 90% lines, enforced in CI; scope is src/, ui/ excluded)
pnpm typecheck      # tsc --noEmit
pnpm lint           # biome
```

Structure: `src/core` (CLI-independent execution engine) + `src/cli` (thin CLI layer) + `src/server` (API server for `klaus ui`) + `ui/` (Vite + React web UI, workspace). See `docs/en/guide/` for the user guide and `docs/en/dev/` for developer documentation (index: `docs/en/index.md`).

## Roadmap

npm publishing (GitHub Actions + Trusted Publishing) was completed in v0.1.1. See [GitHub Issues](https://github.com/almondoo/klaus/issues) for future plans.

## License

[Elastic License 2.0](LICENSE) — Free to use, modify, and redistribute, but this software may not be provided to third parties as a hosted/managed service.
