# API Verification CLI "klaus" Implementation Requirements

> [!summary] Role of this document
> Handoff document for the implementation session. Records **only decided items**. Used by copying into a new repository as `docs/requirements.md`.
> The background discussion (tool comparison, deep-research findings) lives in the research vault at [[Claude CodeでのAPI検証環境の選定]]. **This link cannot be resolved from the implementation repository**, but this document alone is sufficient for implementation.

## Purpose

A CLI tool that lets both Claude Code (an AI agent) and humans verify a local HTTP API implemented in Go / Node. Request definitions are git-managed, and execution history is kept locally. Installed globally via `npm -g`.

> [!info] Name (decided 2026-08-07)
> The tool/command name is **klaus**. The unscoped npm name `klaus` is already taken (an unrelated package dating from 2017), so the package name is scoped as `@<username>/klaus`, with the command name set to `klaus` via `bin` in `package.json`.

## Out of scope (must not be implemented)

1. **No GUI app or VS Code extension**. The only future UI is "a localhost web UI served by the CLI" (out of scope for this phase, but the core separation should leave room for it)
2. **Do not reimplement the HTTP layer**. Retries, TLS, and redirects are delegated to undici
3. **Do not create a custom DSL**. Request definitions are plain YAML
4. Cloud sync and account mechanisms will never be built (local-first)

## Technology stack (finalized)

| Layer | Choice |
|---|---|
| Language / runtime | TypeScript + Node.js >=22.19, distributed via `npm -g` |
| HTTP engine | undici |
| Definition format | YAML (schema validated with zod) |
| Assertions | jsonpath-plus + custom matchers |
| CLI framework | commander |
| Build / test / lint | tsup / vitest / biome |
| Package structure | Single package. Separate `src/core` (CLI-independent library) from `src/cli` (thin shell). Add `src/server` + `ui/` (Vite + React) in the future |

## Request definition format (sample / starting point)

The following is the starting point for M1. The details of field names may be adjusted during implementation, but the structure of **"one file = one flow (multiple steps)" and "capture and assertions embedded in the definition"** must be preserved.

```yaml
# api/auth-flow.yaml
name: 認証フロー
env: local          # environments/local.yaml を参照
steps:
  - name: login
    request:
      method: POST
      url: "{{baseUrl}}/login"
      headers:
        Content-Type: application/json
      body:
        email: "{{testEmail}}"
        password: "{{env.TEST_PASSWORD}}"   # OS 環境変数の参照
    capture:
      token: "$.token"                      # jsonpath でキャプチャ
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
        Authorization: "Bearer {{token}}"   # 前ステップのキャプチャを参照
    assert:
      status: 200
      body:
        - path: "$.email"
          equals: "{{testEmail}}"
```

## Functional requirements

### Required

- **YAML request definitions**: Method, URL, headers, body, and assertions described in a single file. Supports sequential execution of multiple requests (collections)
- **Variable capture and chaining**: Extract values from responses via jsonpath etc. and reference them in subsequent requests with <code v-pre>{{var}}</code> (the representative case is login → token → Authorization header). Template functions such as `newUuid` / `newDate`
- **Environment variables**: Per-environment files (local / staging, etc.) plus references to OS environment variables. Secrets must not be hardcoded into definition files
- **Assertions**: At minimum, status / header / body string / JSONPath. regex / duration are extension candidates
- **Exit code scheme**: 0 = all passed / 1 = general error / 2 = definition parse error / 3 = runtime error (e.g. connection failure) / 4 = assertion failure. An agent must be able to identify the point of failure from the exit code alone
- **Machine-readable report**: JSON output (`--json`). JUnit / TAP are extension candidates
- **Execution history**: Append all requests / responses / durations to `.klaus/history/*.jsonl`. Git-manageable text

### Required (output design for agents)

- **Automatic TTY detection**: Human-readable text by default when stdout is a TTY; JSON by default when non-TTY (piped / Claude Code's Bash)
- **A single-line summary on success** (e.g. `PASS login (200, 45ms)`). Response details are shown only on failure. Full details are relegated to the history JSONL

### Recommended

- **SSE verification**: For requests with `Accept: text/event-stream`, receive events with a time / event-count cap, cut off, and run assertions against the received events (a differentiating feature absent from existing tools)
- WebSocket / GraphQL support

### Optional (not implemented for now)

- gRPC, mock server, load testing

## Constraints for the future localhost UI (to be honored in the current phase)

- Keep all execution, assertion, and history logic in `src/core`, importing it from the CLI only (so the core can be reused when the UI is added)
- Version the history JSONL schema (it becomes a contract the UI reads)
- At UI implementation time: bind only to 127.0.0.1, protect against CSRF / DNS rebinding with a startup token, serve the UI from the same origin as the server

## Milestone plan

1. **M1**: YAML definition → execution → assertion → text / JSON output + exit code (minimal working version)
2. **M2**: Variable capture, chaining, environment variables, history JSONL
3. **M3**: SSE verification, template functions, report extensions, **npm publish** (publish the scoped `@<username>/klaus` with `npm publish --access public`. Automate build + test + publish via GitHub Actions on tag push, using npm Trusted Publishing (OIDC) for authentication so no token is placed in Secrets. Check the package contents with `npm pack --dry-run` before publishing)
4. **M4**: localhost UI (server started via `klaus ui` + browser display)

## Reference existing tools

- Definition + assertion integration, exit code scheme: Hurl (hurl.dev)
- Local-first, git-native, shared core between CLI and GUI: Bruno
- Agent-facing CLI design: Arcjet, "Designing a CLI for AI agents"
