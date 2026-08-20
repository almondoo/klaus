# Execution History

klaus appends every request, response, and duration to a local JSONL file. The reason CLI text output stays a one-line summary on success is that full detail is offloaded here. The localhost UI's history browser also reads this file.

To inspect it directly from the CLI without the browser UI, use `klaus history` (list) / `klaus history show <runId>` (detail). See the [CLI Reference](cli.md#klaus-history) for the options.

## File Conventions

- Path: `.klaus/history/<YYYY-MM-DD>.jsonl` (**relative to the cwd**; the date is the local date)
- The directory is created automatically
- Writing can be disabled with `klaus run --no-history`
- **A write failure does not affect the execution result** (only a warning is printed to stderr; step pass/fail is unaffected)

## Per-Line Schema (v: 1)

One line = one step execution. `runId` lets you group steps from the same run.

```jsonc
{
  "v": 1,                       // schema version
  "runId": "<uuid>",            // ID for the run unit (shared across all flows)
  "flow": "auth flow",          // flow name
  "step": "login",              // step name
  "startedAt": "2026-08-08T…",  // ISO 8601
  "durationMs": 6,
  "status": "passed",           // "passed" | "failed" | "skipped" (may be absent on older entries; see Operational Notes)
  "request": {                  // omitted for skipped steps
    "method": "POST",
    "url": "http://…",          // template-resolved (secrets masked)
    "headers": { … },           // template-resolved (secrets masked)
    "body": { … }
  },
  "response": {                 // omitted for skipped steps
    "status": 200,
    "headers": { … },
    "body": { … }               // the parsed value if JSON, otherwise text
  },
  "events": [                   // present only for SSE steps (received events)
    { "event": "message", "id": "1", "data": "…" }
  ],
  "assertions": [
    { "ok": true, "kind": "status", "expected": 200, "actual": 200, "message": "…" }
  ]
}
```

### Content by Step Type

| Type | request | response | events |
|---|---|---|---|
| HTTP / GraphQL | method / url / headers / body | status / headers / body | — |
| SSE | as usual | status / headers, **body is undefined** | array of received events (`{event?, id?, data}`) |
| WebSocket | method is `"WS"`, body is the array of sent messages | status is fixed at `101`, body is the array of received messages (data strings) | — |
| skipped | omitted | omitted | — |

**Skipped steps are recorded too** (`status: "skipped"`, no request/response, empty assertions). Steps that resulted in a runtime error are not recorded in the history.

Newly written entries always include `status`. Older entries without a `status` field can still be read by deriving pass/fail from `assertions`, as before (backward compatible).

## Versioning Contract

The history JSONL is a **contract** read by the localhost UI (and future tools), and evolves under the following rules:

- A change that doesn't bump `v` may **only add fields** (additive). Removing an existing field, or changing its meaning or type, requires a version bump
- Readers ignore unknown fields, and skip lines with an unknown `v`

## Operational Notes

- **Template-resolved values are recorded.** However, values resolved from an OS environment variable via <code v-pre>{{env.X}}</code> (length 4 or more) are masked to `***` right before writing, inside the request's url/headers/body, the response's headers/body, assertion results (expected/actual/message), and events (event/id/data). Masking matches not only the raw value but also its URL-encoded representations (percent-encoding, the `+`-for-space form `URLSearchParams` produces, and the encodeURI form that approximates WHATWG URL normalization), so a secret placed in `request.query` or written directly into a `request.url` template is masked in its encoded form too, not just literally. Only values resolved through this path are masked — values sourced from `environments/*.yaml`, values obtained through `capture:`, and live run output (the in-progress UI / `StepResult`), are not covered. See [SECURITY.md](https://github.com/almondoo/klaus/blob/main/SECURITY.md) for details
- Projects handling values that aren't masked (secrets shorter than 4 characters, or values sourced from environment files) should still add `.klaus/` to `.gitignore` (this repository's scaffolding ignores it from the start)
- Since it's a plain text file, it's also possible to deliberately commit it to git and share execution records across a team (after confirming no unmasked values are included)
