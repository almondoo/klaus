# klaus

[![CI](https://github.com/almondoo/klaus/actions/workflows/ci.yml/badge.svg)](https://github.com/almondoo/klaus/actions/workflows/ci.yml)
![coverage](https://img.shields.io/badge/coverage-%E2%89%A590%25_lines-brightgreen)

A CLI tool for verifying local HTTP APIs. Request definitions are managed as plain YAML in git, with execution, assertions, and history management. Designed for use by both humans and AI agents (Claude Code, etc.).

Documentation site: https://almondoo.github.io/klaus/

[日本語](./README.ja.md)

- **1 file = 1 flow**: Sequential execution of multiple steps, with variable capture from responses and chaining to subsequent steps
- **Built-in assertions**: Define status / header / body (JSONPath) / duration checks in the definition file
- **Protocol coverage**: SSE / GraphQL / WebSocket flows use the same assertion matchers as plain HTTP requests, applied to protocol-specific fields (`events` / `messages`)
- **Web UI**: `klaus ui` launches a localhost runner + history viewer alongside the CLI
- **record/replay & OpenAPI generation**: `--record`/`--replay` for cassette-based testing, `klaus generate` to scaffold flows from an OpenAPI spec
- **Agent-friendly output**: Failures can be identified from exit code alone. JSON output is the default in non-TTY environments
- **Local-first**: Execution history is appended to `.klaus/history/*.jsonl`. No cloud sync or account mechanism

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

The full syntax for templates, assertions, and SSE / GraphQL / WebSocket flows is in the [Flow Definition Reference](https://almondoo.github.io/klaus/guide/flow-definition).

## CLI

| Command | Description |
|---|---|
| `klaus run <files...>` | Runs flow YAML files |
| `klaus ui` | Launches the localhost web UI (runner + history viewer) |
| `klaus validate [files...]` | Schema-validates flow YAML without running it |
| `klaus schema` | Prints the JSON Schema for flow YAML / `run --json` output / `klaus.config.yaml` |
| `klaus generate <spec>` | Generates flow YAML scaffolding per operation from an OpenAPI spec |
| `klaus init` | Generates a minimal flows/environments setup in the current directory |
| `klaus history [show <runId>]` | Lists execution history, or prints one entry as JSON |

See the [CLI reference](https://almondoo.github.io/klaus/guide/cli) for the full option list of each subcommand.

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

## Documentation

- [Getting Started](https://almondoo.github.io/klaus/guide/getting-started) — Installation through your first flow run
- [Flow Definition Reference](https://almondoo.github.io/klaus/guide/flow-definition) — Full YAML schema: steps, templates, captures, assertions, SSE/GraphQL/WebSocket syntax
- [CLI Reference](https://almondoo.github.io/klaus/guide/cli) — Full option list for every subcommand
- [Configuration (klaus.config.yaml)](https://almondoo.github.io/klaus/guide/config) — Default values for frequently used CLI options
- [Generating Flows from OpenAPI](https://almondoo.github.io/klaus/guide/generate) — `klaus generate` usage and what it scaffolds per operation
- [record / replay mode](https://almondoo.github.io/klaus/guide/record-replay) — Cassette-based testing for network-isolated or destructive-API scenarios
- [Web UI](https://almondoo.github.io/klaus/guide/ui) — The `klaus ui` runner + history viewer, and its token / CSRF / Host-validation security model
- [Execution History](https://almondoo.github.io/klaus/guide/history) — The `.klaus/history/*.jsonl` schema and file conventions
- [Troubleshooting](https://almondoo.github.io/klaus/guide/troubleshooting) — Error messages klaus actually prints, with cause and fix
- [Agent Skill (Claude Code / Codex)](https://almondoo.github.io/klaus/guide/agent-skill) — Install locations and what the bundled SKILL.md teaches agents

## Agent Skill (Claude Code / Codex)

An Agent Skill document is bundled as `skills/klaus/SKILL.md`. Copy it to `~/.claude/skills/klaus/` (Claude Code) or `~/.agents/skills/klaus/` (Codex) so agents can learn how to write flow YAML and what each exit code means without reading the source. See [Agent Skill (Claude Code / Codex)](https://almondoo.github.io/klaus/guide/agent-skill) for setup instructions.

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

Structure: `src/core` (CLI-independent execution engine) + `src/cli` (thin CLI layer) + `src/server` (API server for `klaus ui`) + `ui/` (Vite + React web UI, workspace). See `docs/guide/` for the user guide and `docs/en/dev/` for developer documentation (index: `docs/index.md`).

## Roadmap

npm publishing (GitHub Actions + Trusted Publishing) was completed in v0.1.1. See [GitHub Issues](https://github.com/almondoo/klaus/issues) for future plans.

## License

[Elastic License 2.0](LICENSE) — Free to use, modify, and redistribute, but this software may not be provided to third parties as a hosted/managed service.
