# How klaus compares to Hurl, Bruno, runn, and Step CI

This page positions klaus against four tools that overlap with it: [Hurl](https://hurl.dev), [Bruno](https://www.usebruno.com), [runn](https://github.com/k1LoW/runn), and [Step CI](https://stepci.com). It says where klaus fits, and where one of the others is the better choice. Statements about the other tools reflect what was verified as of November 2026; check each project's own documentation before deciding, since they change.

## What klaus is for

klaus verifies HTTP APIs from YAML request flows. It is built for two kinds of users working on the same flows: humans, and AI agents that run commands on their behalf. That shapes what it emphasizes:

- **Safety guardrails.** A host allowlist (`guard.allowedHosts` in `klaus.config.yaml`) and protected environments (`$protected: true` / `readonly`) refuse a request before it is sent. There is deliberately no command-line flag that lifts the allowlist, so an agent cannot turn off a restriction that was set for it. See [Default CLI options](config.md) and the [CLI Reference](cli.md).
- **Local history as evidence.** Every run is recorded under `.klaus/history/`, with secrets masked and audit fields (environment, file, who ran it, git state). Output designed for agents (`--json`) stays short and points into that history for full detail. See [Execution History](history.md).
- **A localhost UI.** `klaus ui` runs the same flows from a browser and shows past runs, with token authentication and CSRF protection. See [localhost UI](ui.md).
- **record / replay.** Save real responses once, then verify flows against the saved cassette without the network. See [record / replay mode](record-replay.md).
- **An Agent Skill.** A bundled skill teaches coding agents the `validate`, `run`, `history` workflow and the exit codes. See [Agent Skill](agent-skill.md).

Beyond that, klaus covers the usual ground for flow-style API checks: assertions, JSONPath capture between steps, per-step `retry`, `if` conditions, data-driven runs (`--data`), tag selection (`--tags`), parallel runs (`--jobs`), JUnit and TAP reports, and SSE and WebSocket steps next to plain HTTP and GraphQL.

## Where klaus is the weaker choice

- **It needs Node.js.** klaus runs on Node.js 22.19 or later. It is not a single self-contained binary.
- **No gRPC.** klaus speaks HTTP (including GraphQL), SSE, and WebSocket. It has no gRPC support.
- **No scripting.** Flows are declarative YAML. There is no embedded JavaScript or other scripting for custom logic.
- **Fewer protocols overall.** Some of the tools below cover databases, SSH, SOAP, or a browser in the same workflow; klaus does not.
- **A younger project.** It has a shorter history and a smaller user base than the established tools.
- **Not OSI open source.** klaus is licensed under the Elastic License 2.0: free to use, modify, and redistribute, but it may not be offered to third parties as a hosted or managed service.

## The alternatives

### Hurl

As of November 2026, Hurl describes requests in a plain-text `.hurl` format and ships as a single binary. It handles HTTP only. It writes reports in HTML, JSON, JUnit, and TAP, runs in parallel (`--parallel` / `--jobs`), retries (`--retry`), redacts secrets with `--secret`, and can export curl commands. It has no response snapshot mode and no local web UI with run history.

Choose Hurl if you want a single binary with no Node.js runtime, a plain-text request format, curl export, or HTML reports. Choose klaus if you want guardrails, a history that records who ran what, a local UI, or record / replay.

### Bruno

As of November 2026, Bruno is a desktop GUI API client that stores collections as plain files in git, and it is MIT licensed. Its `bru` CLI produces JSON, JUnit, and HTML reports. It supports JavaScript scripting (the CLI defaults to a sandboxed "Safe Mode" since v3), supports REST, GraphQL, gRPC, and WebSocket, and integrates with secret managers (Vault, AWS, Azure, GCP).

Choose Bruno if you want a full desktop client for exploring and authoring requests, need gRPC, want scripting, or need to pull secrets from a secret manager. Choose klaus if you want a CLI-first workflow with declarative flows, guardrails that apply to agent-driven runs, and a history that serves as evidence.

### runn

As of November 2026, runn defines "runbooks" in YAML and ships as a single Go binary. Its steps cover HTTP, gRPC, databases, SSH, and the browser (through CDP). It publishes a JSON Schema for editors, and uses expression-based conditions and tests.

Choose runn if a single scenario has to cross protocols (for example an HTTP call followed by a database check), if you want a single binary, or if you want expression-based tests. Choose klaus if your scope is HTTP-shaped APIs and you want guardrails, history, and a UI around them.

### Step CI

As of November 2026, Step CI defines workflows in YAML, JSON, or JavaScript, and covers REST, GraphQL, gRPC, tRPC, and SOAP. The latest GitHub release observed is from 2024.

Choose Step CI if you need its protocol coverage (tRPC or SOAP in particular) or JavaScript-defined workflows. When weighing it, look at the project's recent release activity yourself. Choose klaus if guardrails, local history, and the localhost UI matter more than protocol breadth.

## Feature table

"Not assessed" means this page makes no claim either way; it does not mean the feature is absent.

| Aspect | klaus | Hurl | Bruno | runn | Step CI |
|---|---|---|---|---|---|
| Definition format | YAML | Plain-text `.hurl` | Plain files in git, authored in a desktop GUI | YAML runbooks | YAML / JSON / JavaScript |
| Runtime | Node.js 22.19 or later | Single binary | Desktop app plus the `bru` CLI | Single Go binary | Not assessed |
| Protocols | HTTP, GraphQL, SSE, WebSocket | HTTP only | REST, GraphQL, gRPC, WebSocket | HTTP, gRPC, databases, SSH, browser (CDP) | REST, GraphQL, gRPC, tRPC, SOAP |
| Scripting | None (declarative) | Not assessed | JavaScript (CLI defaults to sandboxed Safe Mode since v3) | Expression-based conditions and tests | JavaScript workflows |
| Reports | JSON, text, JUnit, TAP | HTML, JSON, JUnit, TAP | JSON, JUnit, HTML | Not assessed | Not assessed |
| Parallel runs and retry | `--jobs`, per-step `retry` | `--parallel` / `--jobs`, `--retry` | Not assessed | Not assessed | Not assessed |
| Secret handling | Masked in output, history, and cassettes | Redacted with `--secret` | Integrates with Vault, AWS, Azure, GCP | Not assessed | Not assessed |
| Local web UI with run history | Yes (`klaus ui`) | No | Desktop GUI | Not assessed | Not assessed |
| record / replay of responses | Yes (`--record` / `--replay`) | No response snapshot mode | Not assessed | Not assessed | Not assessed |
| Guardrails (host allowlist, protected environments) | Yes | Not assessed | Not assessed | Not assessed | Not assessed |
| Editor JSON Schema | Yes (`klaus schema`) | Not assessed | Not assessed | Yes | Not assessed |
| Bundled Agent Skill | Yes | Not assessed | Not assessed | Not assessed | Not assessed |
| License | Elastic License 2.0 | Not assessed | MIT | Not assessed | Not assessed |

## Related

- [Getting Started](getting-started.md): install klaus and run a first flow
- [Flow Definition Reference](flow-definition.md): everything a flow can express
