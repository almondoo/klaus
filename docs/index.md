# klaus Documents

Documentation index for klaus, the API verification CLI.

## Getting Started

- [Getting Started](guide/getting-started.md) — from installation to running your first flow

## Guides

- [Generating Flows from OpenAPI](guide/generate.md) — bootstrap flow definition YAML files from an OpenAPI 3.x spec
- [record / replay mode](guide/record-replay.md) — verify flows against a recorded cassette instead of the live network
- [localhost UI](guide/ui.md) — how to use `klaus ui`, and its security model
- [Agent Skill (Claude Code / Codex)](guide/agent-skill.md) — teach an AI coding agent klaus's workflow via a bundled Agent Skill
- [Troubleshooting](guide/troubleshooting.md) — real error messages klaus prints, with their cause and fix

## Reference

- [CLI Reference](guide/cli.md) — all options for `klaus run` / `klaus ui`, the exit code scheme, and output modes
- [Flow Definition Reference](guide/flow-definition.md) — the complete YAML reference (request / GraphQL / WebSocket / SSE / templates / capture / assert)
- [Default CLI options (klaus.config.yaml)](guide/config.md) — set project-wide defaults for CLI options
- [Execution History](guide/history.md) — the schema and versioning contract for `.klaus/history/*.jsonl`
