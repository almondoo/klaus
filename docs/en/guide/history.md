# Execution History

klaus appends every request, response, and duration to a local JSONL file. The reason CLI text output stays a one-line summary on success is that full detail is offloaded here. The localhost UI's history browser also reads this file.

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
  "request": {
    "method": "POST",
    "url": "http://…",          // template-resolved
    "headers": { … },           // template-resolved
    "body": { … }
  },
  "response": {
    "status": 200,
    "headers": { … },
    "body": { … }               // the parsed value if JSON, otherwise text
  },
  "assertions": [
    { "ok": true, "kind": "status", "expected": 200, "actual": 200, "message": "…" }
  ]
}
```

### Content by Step Type

| Type | request | response |
|---|---|---|
| HTTP / GraphQL | method / url / headers / body | status / headers / body |
| SSE | as usual | status / headers, **body is undefined** (received events are not persisted to history — a known limitation) |
| WebSocket | method is `"WS"`, body is the array of sent messages | status is fixed at `101`, body is the array of received messages (data strings) |

**Skipped steps are not recorded** (since they were never run). Steps that resulted in a runtime error are recorded along with the error details.

## Versioning Contract

The history JSONL is a **contract** read by the localhost UI (and future tools), and evolves under the following rules:

- A change that doesn't bump `v` may **only add fields** (additive). Removing an existing field, or changing its meaning or type, requires a version bump
- Readers ignore unknown fields, and skip lines with an unknown `v`

## Operational Notes

- **Template-resolved values are recorded as-is.** Secrets referenced via <code v-pre>{{env.TEST_PASSWORD}}</code> also remain in history as their resolved, raw values, so projects handling secrets should add `.klaus/` to `.gitignore` (this repository's scaffolding ignores it from the start)
- Since it's a plain text file, it's also possible to deliberately commit it to git and share execution records across a team (only when no secrets are included)
