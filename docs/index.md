# klaus Documents

Documentation index for klaus, the API verification CLI.

## User Guide

- [Getting Started](guide/getting-started.md) — from installation to running your first flow
- [CLI Reference](guide/cli.md) — all options for `klaus run` / `klaus ui`, the exit code scheme, and output modes
- [Flow Definition Reference](guide/flow-definition.md) — the complete YAML reference (request / GraphQL / WebSocket / SSE / templates / capture / assert)
- [Execution History](guide/history.md) — the schema and versioning contract for `.klaus/history/*.jsonl`
- [localhost UI](guide/ui.md) — how to use `klaus ui`, and its security model

## Developer Guide

Developer-facing docs are not part of this published site; they live in the repository and are linked here as GitHub pages.

### Current documentation (reflects the implementation)

- [Architecture](https://github.com/almondoo/klaus/blob/main/docs/en/dev/architecture.md) — the structure and responsibilities of core / cli / server / ui, the public API, and build/test setup
- [Changelog](https://github.com/almondoo/klaus/blob/main/docs/en/dev/changelog.md) — changes in each release, along with the reasoning and pitfalls behind them
- [Improvement Proposals](https://github.com/almondoo/klaus/blob/main/docs/en/dev/improvement-proposals.md) — improvements identified through implementation and verification, with priorities
- [klaus ui — HTTP API and Internal Structure](https://github.com/almondoo/klaus/blob/main/docs/en/dev/ui-api.md) — the HTTP API reference used by the UI and its place in the architecture
- [UI Design System](https://github.com/almondoo/klaus/blob/main/ui/docs/design-system.md) — the shadcn/ui + Tailwind v4 token implementation (source of truth for actual values)
- [UI Component Design](https://github.com/almondoo/klaus/blob/main/ui/docs/components.md) — primitive composition, state management, and a11y rules

### Design-time records (diverge from the implementation)

These are snapshots taken during earlier design work, and some parts no longer match the current implementation. Differences from the implementation are noted in the "Current documentation" section above and in each `ui/docs/` file.

- [Implementation Requirements](https://github.com/almondoo/klaus/blob/main/docs/en/dev/requirements.md) — project decisions (scope, tech stack, milestones)
- [UI Architecture Design](https://github.com/almondoo/klaus/blob/main/docs/en/dev/ui-design.md) — server structure, API contract, and security design for the localhost UI
- [UI Visual / UX Design](https://github.com/almondoo/klaus/blob/main/docs/en/dev/ui-ux-design.md) — design direction, color tokens, and UX rules
- [Design System](https://github.com/almondoo/klaus/blob/main/docs/en/dev/design-system/klaus/MASTER.md) — the original generated design tokens
