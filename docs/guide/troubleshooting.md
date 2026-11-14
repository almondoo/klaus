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

For `$protected: readonly` environments, only `GET` / `HEAD` / `OPTIONS` are allowed without the flag. Any other method is refused with:

```
environment "production" is protected ($protected: readonly) and only allows GET, HEAD, and OPTIONS by default; refusing POST. Pass --allow-protected to run against this environment intentionally.
```

A `GET` carrying a method-override header (`X-HTTP-Method-Override`, `X-HTTP-Method`, `X-Method-Override`) is refused with:

```
environment "production" is protected ($protected: readonly) and refuses requests carrying the x-http-method-override header, which can turn a read into a write. Pass --allow-protected to run against this environment intentionally.
```

The fix is the same (`--allow-protected`), or switch the step to a safe method. GraphQL steps default to `POST`, so they are refused too. See [Protected environments](cli.md#protected-environments-protected).

`klaus req` and single requests from `klaus ui` have no `--allow-protected` option, so their refusals end with a different hint instead of the `Pass --allow-protected ...` sentence:

```
Single requests (klaus req, klaus ui) cannot override environment protection; run a flow with `klaus run --allow-protected` instead.
```

### "host \"X\" is not in guard.allowedHosts (klaus.config.yaml); refusing to send the request."

**Symptom**

```
host "api.other.com" is not in guard.allowedHosts (klaus.config.yaml); refusing to send the request.
```

**Cause**: `klaus.config.yaml` sets `guard.allowedHosts`, and the step's URL (after template expansion) points to a host that matches none of the entries. Note that `*.example.com` does not match `example.com` itself, and an entry with a port matches only that port.

**Fix**: if the host is intended, add it to `guard.allowedHosts` in `klaus.config.yaml` (restart `klaus ui` if it is running); otherwise fix the URL. There is no CLI flag to bypass the check. See [Host allowlist](config.md#host-allowlist-guard-allowedhosts).

### "redirect hop N (after STATUS) refused: ..."

**Symptom**

```
redirect hop 1 (after 302) refused: host "other.example.com" is not in guard.allowedHosts (klaus.config.yaml); refusing to send the request.
```

**Cause**: `http.followRedirects` is on, and a redirect points to a host that the guards refuse. Every hop is checked like a normal request, so a redirect cannot leave `guard.allowedHosts`.

**Fix**: if the target is intended, add it to `guard.allowedHosts`; otherwise fix the server or the URL. See [HTTP client](config.md#http-client-http).

### "http.proxy and http.tls can only be set in klaus.config.yaml, not in a flow file ..."

**Symptom**

```
http.proxy and http.tls can only be set in klaus.config.yaml, not in a flow file (they decide where traffic goes and whom it trusts)
```

**Cause**: a flow file has `http.proxy` or `http.tls`. These keys decide where traffic goes and whom it trusts, so a flow (which an agent may have written) cannot set them.

**Fix**: move the setting into the `http` section of `klaus.config.yaml`. See [HTTP client](config.md#http-client-http).

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

## `klaus req` errors

### "klaus: --body file resolves outside the current directory: \"X\""

**Symptom**

```
klaus: --body file resolves outside the current directory: "../payload.json"
```

The command exits with code 2 and sends nothing.

**Cause**: `--body @<file>` only reads files inside the current working directory, symbolic links included, so that an agent cannot send arbitrary files to the target host.

**Fix**: copy the file into the working directory (or run `klaus req` from a directory that contains it), or pass the body inline with `--body '<json>'`. See [klaus req](cli.md#request-body-body).

## Snapshot assertions (`assert.snapshot`)

### "snapshot \"X\" differs from the baseline (N differences): ..."

**Symptom** (the step fails, exit code 4)

```
snapshot "get-user" differs from the baseline (1 difference): $.body.name "alice" -> "bob"
```

**Cause**: the response no longer equals the baseline stored in `__snapshots__/<flow file>.snap.json`. The paths start with `$.status`, `$.headers`, or `$.body`; the JSON output lists up to 20 of them under `differences`.

**Fix**: if the change is a bug, fix the API. If it is expected, accept it with `klaus run <file> --update-snapshots` or `klaus snapshot accept <runId>` and review the `git diff` of the snapshot file. If the differing value is volatile (an id, a timestamp), add its path to `snapshot.ignore`. See [snapshot](flow-definition.md#snapshot-baseline-comparison).

### "snapshot \"X\" has no baseline, and a baseline is not recorded in CI ..."

**Symptom** (the step fails, exit code 4)

```
snapshot "get-user" has no baseline, and a baseline is not recorded in CI (run it locally and commit "flows/__snapshots__/a.yaml.snap.json", or pass --update-snapshots)
```

**Cause**: the run has `--ci`, or the `CI` environment variable is set, and the flow has no baseline for this step. The same result (with a different reason in the message) happens when the run targets a `$protected` environment or uses `--replay`, because a baseline is not recorded implicitly there.

**Fix**: run the flow once locally, review, and commit the snapshot file. To record from a protected environment on purpose, pass `--update-snapshots`. Do not commit a snapshot that was recorded from production data you do not want in the repository. See [Snapshots](cli.md#snapshots-update-snapshots-ci).

### "snapshot file \"X\" is corrupt: ..."

**Symptom** (exit code 2, nothing is run)

```
klaus: parse error: snapshot file "flows/__snapshots__/a.yaml.snap.json" is corrupt: the file is not valid JSON. Fix it, delete it, or run with --update-snapshots to recreate it
```

**Cause**: the snapshot file is not a JSON object of `{ status?, headers?, body }` entries, for example after an unresolved merge conflict. klaus never prints the file's content in this message.

**Fix**: resolve the conflict or delete the file, then run again (a missing file is simply a missing baseline), or run with `--update-snapshots` to recreate it.

## `klaus ui` errors

### "Forbidden: environment \"X\" is protected and cannot be edited via this API (edit the file directly)"

**Symptom**: saving the environment editor, or the "save captured value to environment" action, fails with HTTP 403 and this message:

```
Forbidden: environment "production" is protected and cannot be edited via this API (edit the file directly)
```

**Cause**: the environment file has `$protected: true` or `$protected: readonly`. The UI is a route an agent may drive, so it cannot write to protected environments.

**Fix**: edit `environments/<name>.yaml` directly in your editor. See [File Structure](flow-definition.md#file-structure).

### "... EADDRINUSE ... (port \<n\> is already in use; specify a different port with --port)"

**Symptom**

```
listen EADDRINUSE: address already in use 127.0.0.1:4884 (port 4884 is already in use; specify a different port with --port)
```

**Cause**: `klaus ui`'s default port (`4884`) is fixed and not auto-incremented, so another `klaus ui` instance (or any other process) already bound to it causes startup to fail.

**Fix**: pass a different port with `klaus ui --port <n>`, or stop the process already using the default port.
