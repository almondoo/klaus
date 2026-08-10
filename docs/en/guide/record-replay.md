# record / replay mode

Passing `--record <dir>` or `--replay <dir>` to `klaus run` switches HTTP request/response handling to go through a file (a cassette) instead of always hitting the network directly. This is useful for verifying flows inside network-isolated sandboxes, or for exercising destructive APIs (payments, outbound messages, etc.) without actually triggering them every run.

- **record mode (`--record <dir>`)**: sends real HTTP requests and, after masking secrets in the response, appends it to a cassette file in `<dir>`.
- **replay mode (`--replay <dir>`)**: never touches the network; responses are served from the cassette in `<dir>`.

`--record` and `--replay` cannot be combined (passing both prints a message to stderr, exits with code 1, and runs nothing).

## Cassette format

A cassette is always a single file at `<dir>/cassette.jsonl` (JSON Lines). Each line holds one recorded response, with the schema below (`v: 1`).

```jsonc
{
  "v": 1,
  "method": "GET",              // uppercased HTTP method
  "url": "http://…",            // rendered URL (already masked)
  "status": 200,
  "headers": { … },
  "bodyText": "…"                // raw response body text
}
```

- `url` is masked using the resolved secrets at record time before being written, so plaintext secrets never end up in the cassette file. The masking rules match the [Execution History](history.md) and `--report junit` (values resolved via <code v-pre>{{env.X}}</code>, including their URL-encoded, form-urlencoded, and JSON-escaped forms).
- `bodyText` is masked the same way before being written.
- The same masking (maskDeep) is applied to the whole entry, including `headers` (the response headers), so secrets found in response headers are masked too.
- During replay, `bodyText` is re-parsed as JSON only when the recorded Content-Type includes `application/json` (otherwise it's returned as text); parse failures also fall back to text.

## Matching rule

During replay, the cassette is looked up by an **exact match on method + masked URL** for the step currently being executed.

- Recording and replaying are assumed to happen with the **same env / secrets** (the URL is masked with whatever secrets are known at execution time before comparing, so a mismatch between the secrets resolved during record vs. replay will break matching).
- If multiple lines share the same key (method + URL), the **first recorded line** wins. Repeated requests to the same key always return the same response (non-consuming — entries are not "used up" in request order).
- A request that doesn't match any cassette entry fails its step with a clear `error`, and the CLI exits with code **3**. The error message includes the (masked) key that failed to match and a hint to re-record with `--record <dir>`.
- If `--replay` is given but the cassette file itself can't be loaded (missing, unreadable, etc.), the same exit code 3 error is raised, deferred until the first HTTP step is actually executed.

## SSE / WebSocket steps are not supported

When `--record` / `--replay` is given, a flow that includes an SSE step (Accept: text/event-stream, or a step with an `sse` block) or a WebSocket step (a step with a `ws` block) fails that step with an explicit `error` instead of silently falling through to the real network. record/replay only covers HTTP steps (including GraphQL over HTTP).

## Effect on history and other output

Even in record/replay mode, writes to `.klaus/history/*.jsonl` still happen as usual (unless `--no-history` is passed). Other options — stdout text/JSON output, `--report junit`, secret masking (`--no-mask`) — behave the same regardless of the mode.

## Use cases

- **Verification inside a network-isolated sandbox**: when a CI or agent execution environment has no network access, you can record a cassette ahead of time (locally or in another environment) and then `--replay` it to still validate request/assertion logic.
- **Avoiding re-running destructive APIs**: for APIs with side effects on every call (payments, sending emails, deleting resources), record once and then `--replay` the same responses afterward, keeping calls with real side effects to a minimum.

## Example

```bash
# 1. Record a cassette while sending real requests
klaus run api/create-user.yaml --record ./cassettes

# 2. Replay the same checks afterward with no network access
klaus run api/create-user.yaml --replay ./cassettes
```
