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
ui:
  port: 4884
  host: 127.0.0.1
  open: true
```

| Key | Corresponding CLI option | Type |
|---|---|---|
| `run.env` | `klaus run --env <name>` | string |
| `run.report` | `klaus run --report <type>` | `"junit"` |
| `run.reportFile` | `klaus run --report-file <path>` | string |
| `run.history` | `klaus run --no-history` (equivalent to disabling with `false`) | boolean |
| `run.mask` | `klaus run --no-mask` (equivalent to disabling with `false`) | boolean |
| `ui.port` | `klaus ui --port <n>` | number (1-65535) |
| `ui.host` | `klaus ui --host <host>` | string |
| `ui.open` | `klaus ui --no-open` (equivalent to disabling with `false`) | boolean |

All keys are optional. Unknown keys cause a schema validation error (see [Error handling](#error-handling) below).

## Intentionally unconfigurable keys

The following options cannot be set in `klaus.config.yaml` (the schema has no field for them; specifying them fails as an unknown key).

| Option | Reason |
|---|---|
| `--allow-protected` | Setting this to `true` by default via config would erode the guardrail that refuses execution against `$protected: true` environments |
| `--record` / `--replay` | These record/replay modes change the execution side effects (whether real network access happens) significantly, so they must be made explicit on every invocation |
| `--json` / `--text` | The output mode depends on the caller (a human reading it vs. an agent or script parsing it), so it should be made explicit on every command-line invocation |
| `--var` / `--env-file` | Both are ad-hoc, per-invocation overrides by nature (a one-off variable, or a one-off environment file path); giving them a persistent default in config would defeat that purpose |

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
