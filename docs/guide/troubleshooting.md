# Troubleshooting

This page collects error messages klaus actually prints, grouped by where they come from, with the cause and the fix for each. For the exit code scheme referenced below, see [CLI Reference](cli.md#exit-code).

## Flow / environment definition errors

### "klaus: parse error: \<file\>: schema validation failed: ..."

**Symptom**

```
klaus: parse error: flows/broken.yaml: schema validation failed: steps.0.request.method: request.method is required unless request.graphql is set
```

**Cause**: the flow definition YAML fails schema validation — a required key is missing, two mutually-exclusive keys are both set (`request`/`ws`, `body`/`graphql`), or an unknown key is present (a likely typo).

**Fix**: run `klaus validate` on the file. Unlike `run`, it lists every issue (not just the first), attaches a one-line fix-example hint for the main cases, and — in text output — appends the YAML line number. See [klaus validate](cli.md#klaus-validate).

### "klaus: parse error: \<file\>: YAML syntax error (line N, column M): ..."

**Symptom**

```
klaus: parse error: flows/broken.yaml: YAML syntax error (line 4, column 3): Unexpected scalar at node end
```

**Cause**: the file isn't valid YAML (bad indentation, an unclosed quote, etc.) — this is caught before schema validation even runs.

**Fix**: fix the YAML syntax at the reported line/column. `klaus run` refuses to execute **any** of the given files if even one fails to parse (exit code 2), so nothing is executed until it's fixed. `klaus validate` still validates every given file independently and reports a per-file result; the exit code is 2 if any file fails.

## Runtime errors during `klaus run` (exit code 3)

These surface as an `ERROR` line in text output, a step with `"status": "error"` in `--json` output, and always take priority over assertion failures (exit 4) when both occur in the same run.

### "template variable \"X\" could not be resolved (available: ...)"

**Symptom**

```
template variable "userId" could not be resolved (available: env: baseUrl, testEmail; captures: token)
```

**Cause**: a <code v-pre>{{userId}}</code> placeholder in the flow doesn't match any prior step's `capture` name or any key in the active environment file. This is usually a typo, a capture defined on a step that ran *after* the one that references it, or a step that was skipped so its capture never ran.

**Fix**: check the spelling against the `available` list in the message (env/capture variable names only — never values, so this is safe to paste into a bug report). Reorder steps if the capture hasn't run yet, or add the missing key to the environment file.

### "OS environment variable \"X\" is not defined"

**Symptom**

```
OS environment variable "TEST_PASSWORD" is not defined
```

**Cause**: <code v-pre>{{env.X}}</code> always resolves against the OS process environment (not the environment YAML file — that's the bare <code v-pre>{{var}}</code> form), and `X` isn't set in the shell that invoked `klaus run`.

**Fix**: export the variable before running, e.g. `TEST_PASSWORD=xxx klaus run api/login.yaml -e local`. See [Templates](flow-definition.md#templates) for the full variable resolution order.

### "capture \"X\": JSONPath \"$.foo\" matched no value (step \"Y\")"

**Symptom**

```
capture "userId": JSONPath "$.data.user.id" matched no value (step "login")
```

**Cause**: the step's `capture` JSONPath didn't match anything in the response body — commonly because the response shape differs from what was expected (an error response instead of the success shape, a renamed field, or an extra nesting level).

**Fix**: inspect the actual response body for that step (`klaus history show <runId> --step <step>`, or the `response.body` field in `--json` output) and correct the JSONPath expression.

### "environment \"X\" is protected (\$protected: true) and refuses execution by default. ..."

**Symptom**

```
environment "production" is protected ($protected: true) and refuses execution by default. Pass --allow-protected to run against this environment intentionally.
```

**Cause**: the environment file has `$protected: true` set, and the run didn't opt in. This is a deliberate guardrail against accidentally running against a production-like environment.

**Fix**: if running against this environment is intentional, pass `--allow-protected` to `klaus run`. Note that `klaus ui` / the server API never accept this flag — protected environments are always refused there, with no override. See [File Structure](flow-definition.md#file-structure).

## `--record` / `--replay` errors (exit code 3)

### "no recorded response for \"METHOD url\" in replay mode. ..." / "failed to read cassette file ... for replay mode: ..."

**Symptom**

```
no recorded response for "GET http://localhost:3000/me" in replay mode. This request was not captured in the cassette (or the method/URL does not match exactly). Re-record this flow with --record <dir> to update the cassette.
```

```
failed to read cassette file "cassettes/login/cassette.jsonl" for replay mode: ENOENT: no such file or directory, open '...'. Record a cassette first with --record.
```

**Cause**: either the cassette directory/file doesn't exist yet (`--replay` was used before any `--record` run), or the request's method + rendered URL doesn't exactly match any recorded entry — often because the resolved secrets (and therefore the masked URL used for matching) differ between the record and replay runs.

**Fix**: record a cassette first with `klaus run <files> --record <dir>` using the same env, then replay with `--replay <dir>`. If specific requests are missing, re-record with the same `--record <dir>` to update the cassette; see [record / replay mode](record-replay.md#matching-rule).

### "step \"X\": SSE/WS steps are not supported in record/replay mode ..."

**Symptom**

```
step "subscribe": SSE/WS steps are not supported in record/replay mode (HTTP only, and GraphQL over HTTP). Remove --record/--replay, or exclude this step from the flow.
```

**Cause**: the flow has an SSE or WebSocket step, and `--record`/`--replay` only covers HTTP (including GraphQL over HTTP) in the current version.

**Fix**: run this flow without `--record`/`--replay`, or split the SSE/WS step out into a separate flow file that's run normally. See [SSE / WebSocket steps are not supported](record-replay.md#sse-websocket-steps-are-not-supported).

## `klaus ui` errors

### "... EADDRINUSE ... (port \<n\> is already in use; specify a different port with --port)"

**Symptom**

```
listen EADDRINUSE: address already in use 127.0.0.1:4884 (port 4884 is already in use; specify a different port with --port)
```

**Cause**: `klaus ui`'s default port (`4884`) is fixed and not auto-incremented, so another `klaus ui` instance (or any other process) already bound to it causes startup to fail.

**Fix**: pass a different port with `klaus ui --port <n>`, or stop the process already using the default port.
