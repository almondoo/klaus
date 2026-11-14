# klaus.config.yaml (default values for CLI options)

Options you frequently pass to `klaus run` / `klaus ui` can be written as defaults in `klaus.config.yaml`, so you don't have to pass them as command-line arguments every time.

## File name and search rule

The file name is fixed: `klaus.config.yaml`. It is resolved via an upward search from the cwd (the same rule as the [environment file](flow-definition.md) search).

- Starting from the cwd, each ancestor directory is checked in turn for a `klaus.config.yaml` directly under it. The first one found is used.
- The search stops at whichever comes first: the first ancestor directory containing a `.git` entry (that directory itself is checked before stopping), or the filesystem root. The search never crosses a repository root.
- If no ancestor directory has the file, no defaults are applied (this is not an error).

If the file is found in an ancestor directory above the cwd, the owner and permissions of that directory and file are checked (to avoid silently loading a config planted by another user on a shared host). If the owner is someone else, or the directory/file is other-writable, it is rejected with an error. A `klaus.config.yaml` placed directly in the cwd itself is not subject to this check.

## Priority

**Explicit CLI option > `klaus.config.yaml` > built-in default**

An option explicitly passed on the command line always takes precedence over the value in `klaus.config.yaml`. Only options that were not passed on the command line get the value from `klaus.config.yaml` (if set). Negated flags such as `--no-history` / `--no-mask` / `--no-open` work the same way: if you explicitly pass `--no-xxx` on the CLI, that value wins; only when nothing was specified does the `klaus.config.yaml` value apply.

## Configurable keys

```yaml
# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/klaus-config.schema.json
run:
  env: local
  report: junit
  reportFile: klaus-report.xml
  history: true
  mask: true
  jobs: 4
ui:
  port: 4884
  host: 127.0.0.1
  open: true
guard:
  allowedHosts:
    - api.example.com
    - "*.example.com"
    - localhost:3000
```

| Key | Corresponding CLI option | Type |
|---|---|---|
| `run.env` | `klaus run --env <name>` | string |
| `run.report` | `klaus run --report <list>` | comma-separated list of `"junit"` / `"tap"` (e.g. `"junit,tap"`) |
| `run.reportFile` | `klaus run --report-file <path>` | string |
| `run.history` | `klaus run --no-history` (equivalent to disabling with `false`) | boolean |
| `run.mask` | `klaus run --no-mask` (equivalent to disabling with `false`) | boolean |
| `run.jobs` | `klaus run --jobs <n>` | number (1-32) |
| `ui.port` | `klaus ui --port <n>` | number (1-65535) |
| `ui.host` | `klaus ui --host <host>` | string |
| `ui.open` | `klaus ui --no-open` (equivalent to disabling with `false`) | boolean |
| `guard.allowedHosts` | none (config only; see [Host allowlist](#host-allowlist-guard-allowedhosts)) | array of strings |

All keys are optional. Unknown keys cause a schema validation error (see [Error handling](#error-handling) below).

`run.reportFile` only supports a single value (unlike the CLI's repeatable `--report-file`). If `run.report` lists more than one format (e.g. `junit,tap`) and `run.reportFile` is also set, that counts as one `--report-file` for N formats — the same count-mismatch error as passing too few `--report-file` flags on the CLI (see [CLI Reference](cli.md#klaus-run)). To set per-format paths for a multi-format `run.report`, pass `--report-file` on the command line instead (CLI values always take precedence over `klaus.config.yaml`, per the priority rule above).

## Host allowlist (guard.allowedHosts)

`guard.allowedHosts` restricts which hosts requests may be sent to. It is a guardrail against a flow (or a single request from `klaus ui`) hitting an unintended server.

```yaml
guard:
  allowedHosts:
    - api.example.com
    - "*.example.com"
    - localhost:3000
    - "[::1]:3000"
```

| Entry form | Matches |
|---|---|
| `api.example.com` | exactly that host |
| `*.example.com` | subdomains at any depth (`a.example.com`, `a.b.example.com`), never the apex `example.com` |
| `localhost:3000` / `[::1]:3000` | that host on that port only. An entry without a port matches any port. IPv6 literals are written in brackets |

- Matching is case-insensitive.
- Entries are validated strictly. Rejected (validation error, exit code 2): `*.` followed by fewer than two labels (`*.com`, `*.localhost`), empty labels (`a..b`, a trailing dot), percent-encoded hosts, and numeric hosts other than plain dotted-quad IPv4 (`0`, `2130706433`, `0x7f.1`, octal forms). Plain IPv4 such as `127.0.0.1`, bracketed IPv6, `localhost`, and single-label internal names such as `backend` are valid. Request URLs are compared after URL normalization, so `http://2130706433/` is treated as `127.0.0.1`.
- If `guard.allowedHosts` is unset, there is no restriction. An empty array or a malformed entry is a validation error (exit code 2, see [Error handling](#error-handling)).
- The check runs right before sending, on the template-resolved URL, for HTTP, SSE, and WebSocket steps and for single requests from `klaus ui`. It is not applied with `--replay` (nothing is sent), and is applied with `--record`.
- A refused step ends as `error` and the run exits with code 3. See [Troubleshooting](troubleshooting.md#host-x-is-not-in-guard-allowedhosts-klaus-config-yaml-refusing-to-send-the-request).
- There is deliberately no CLI flag to override it. `klaus ui` reads the config at startup, so restart it after changing the list.

## Intentionally unconfigurable keys

The following options cannot be set in `klaus.config.yaml` (the schema has no field for them; specifying them fails as an unknown key).

| Option | Reason |
|---|---|
| `--allow-protected` | Setting this to `true` by default via config would erode the guardrail that refuses execution against `$protected: true` environments |
| `--allow-hosts` (no such option exists) | `guard.allowedHosts` can only be changed by editing `klaus.config.yaml`; a per-invocation flag would let an agent lift the restriction it is meant to enforce |
| `--record` / `--replay` | These record/replay modes change the execution side effects (whether real network access happens) significantly, so they must be made explicit on every invocation |
| `--json` / `--text` | The output mode depends on the caller (a human reading it vs. an agent or script parsing it), so it should be made explicit on every command-line invocation |
| `--var` / `--env-file` / `--data` | All three are ad-hoc, per-invocation overrides by nature (a one-off variable, a one-off environment file path, or a one-off data file for a data-driven run); giving them a persistent default in config would defeat that purpose |
| `--tags` / `--exclude-tags` | Also a per-invocation choice of what to run this time; a persistent default in config risks silently excluding some flows on every run without it being obvious |

## Error handling

If `klaus.config.yaml` is invalid YAML, or fails schema validation (including unknown keys), `klaus run` / `klaus ui` prints the file path and reason to stderr and exits with **exit code 2** (the same handling as parse errors in flow definitions and environment files).

## JSON Schema

The schema for `klaus.config.yaml` is also published as JSON Schema.

- Published URL: `https://almondoo.github.io/klaus/schema/klaus-config.schema.json`
- npm package path: `node_modules/@almondoo/klaus/dist/schema/klaus-config.schema.json`
- `klaus schema --target config` prints the same content to stdout (see [CLI Reference](cli.md#klaus-schema))

Adding a `# yaml-language-server: $schema=` comment at the top of the file enables completion and validation in editors that support it (such as VS Code's YAML extension).

```yaml
# yaml-language-server: $schema=https://almondoo.github.io/klaus/schema/klaus-config.schema.json
run:
  env: local
```
