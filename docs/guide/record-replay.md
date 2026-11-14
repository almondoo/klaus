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

## Mock server

`klaus mock <dir>` starts a local HTTP server that serves the responses recorded in `<dir>/cassette.jsonl`, so another client (a frontend, a script, another tool) can talk to `localhost` instead of the real API. It never forwards anything to the network.

```bash
klaus run api/create-user.yaml --record ./cassettes
klaus mock ./cassettes --port 4885
# klaus mock started: http://127.0.0.1:4885
curl http://127.0.0.1:4885/users/1
```

The listening URL is printed to stdout; per-request logs go to stderr. Stop it with Ctrl+C (SIGINT / SIGTERM); it then exits with code 0. Other exit codes: **2** if the cassette is missing, invalid, or empty, or `--origin` matches no recorded entry; **1** for an invalid option value (for example `--port 99999` or a malformed `--origin`), the port being in use, or any other runtime failure.

| Option | Description |
|---|---|
| `-p, --port <n>` | Port to listen on. Default `4885` (the UI uses 4884). `0` picks a free port |
| `-H, --host <host>` | Address to bind. Default `127.0.0.1`; pass `0.0.0.0` explicitly to accept outside connections |
| `--cors` | Add permissive CORS headers and answer preflight (`OPTIONS` with `Access-Control-Request-Method`). Off by default |
| `--delay <ms>` | Add a fixed latency to every response |
| `--ignore-query` | Match on method and path only |
| `--sequence` | Serve repeated recordings of the same request in recorded order, repeating the last one when exhausted |
| `--origin <url>` | Serve only entries recorded for this origin (for example `http://api.example.com`) |
| `--allow-host <host>` | Also accept this `Host` header name, without a port (repeatable). Widens the Host check, see below |
| `--json` | Print the startup line (stdout) and request logs (stderr) as JSON Lines |

### Host header check

To block DNS rebinding (a web page on another site re-pointing its hostname at your machine to read recorded responses from your browser), the mock rejects any request whose `Host` header is not expected, with `403` and a small JSON body, before matching anything.

- Bound to a loopback address (the default): only `127.0.0.1:<port>`, `localhost:<port>`, and `[::1]:<port>` are accepted (case-insensitive), where `<port>` is the actual listening port, including with `--port 0`. A missing `Host` is rejected.
- Bound to a non-loopback address (`--host 0.0.0.0` and similar): the host name cannot be known in advance, so only the port must match.
- `--allow-host <host>` adds host names (for example a docker-compose service name) that are accepted with the listening port. Every use widens the check, so list only names you control.
- `--cors` does not relax this check.

### Mock matching rule

The mock matches on **method + path + query**. The recorded host is dropped, because the client now talks to localhost (this differs from replay, which matches the full URL).

- The query string is compared exactly first. If nothing matches, it is compared again with the query parameters in any order.
- If several recorded entries share the same key, the first one is served every time (same as replay). With `--sequence` they are served in recorded order and the last one repeats.
- If the cassette holds more than one origin, all of them are merged. When two origins record the same method + path + query, the first one in the cassette wins and a warning listing the collisions is printed at startup. Use `--origin` to pick one origin.
- The request target is read as a path: `//host/path` is not treated as a host, an absolute-form target (`GET http://host/path`) uses its path and query, and any other form (`*`, `CONNECT`) is refused with `400` / `405`.
- A request with no match gets a `404` with a small JSON body (`error`, `method`, `path`, and `closest` recorded paths; recorded bodies are never included), and a log line.

### Mock responses

The recorded status, headers, and body are served as stored. `content-length` is recomputed, and headers that would be wrong when re-served (`transfer-encoding`, `content-encoding`, `connection`, `keep-alive`, and other hop-by-hop headers) are dropped. Bodyless responses follow HTTP: a recorded 1xx, 204, or 304 is sent without a body or `content-length`, and a `HEAD` request gets the headers (with the `content-length` of the corresponding GET) but no body. Recorded `access-control-*` headers are always dropped, since the recorded origin's CORS policy does not apply to the mock; with `--cors` the mock adds its own permissive set instead. Because recording masks secrets, any secret in a recorded body or header is served as `***`; the mock does not restore it.

## Example

```bash
# 1. Record a cassette while sending real requests
klaus run api/create-user.yaml --record ./cassettes

# 2. Replay the same checks afterward with no network access
klaus run api/create-user.yaml --replay ./cassettes
```
