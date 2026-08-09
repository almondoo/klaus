# klaus improvement proposals

Improvement proposals drawn from the session where I implemented and verified klaus. Grounded in **things that actually happened during this session** (no speculative generalities). Each item comes with a verdict on whether it's worth doing and a rough cost estimate.

Verdict legend: **Recommended** = should be done / **Conditional** = worth it under a specific usage pattern / **Deferred** = cost outweighs benefit.

---

## A. Product (klaus itself) improvements

### A-1. `pnpm build` destroys `dist/ui` — done (2026-08-08)

**Basis**: hit this **twice** during this session. The first entry in `tsup.config.ts` had `clean: true`, which wipes all of `dist/`, so running `pnpm build` (and `pnpm test`, which calls build internally) deletes the `dist/ui` that Vite produced. The result: `klaus ui` returns a 503 "static files not found."

Users would hit the same thing: `pnpm build` is a natural command to run, and afterward `klaus ui` breaks. Docs (`VERIFICATION.md`, `docs/dev/architecture.md`) worked around it with a warning, but **a design that relies on a doc warning to work around it is itself the wrong design**.

**Candidate fixes** (either one):
1. Set `clean` to `false` on every tsup entry, move the equivalent of `"clean": "rimraf dist"` into its own script, and run it only at the start of `build:all`
2. Move the UI's output out of `dist/ui` into an independent directory (e.g. `ui-dist/`) and point `resolveStaticDir()` there. Add it to `files`

**Fix adopted**: set `clean` to `false` in `tsup.config.ts`. Initially tried option 1 with a glob (`clean: ["dist/*.js", ...]`), but **tsup deletes the entire outDir regardless of the array passed in** — confirmed by experiment (the contents of `dist/ui` were completely wiped, leaving just an empty directory) — so switched to disabling it instead. tsup's own output (`index.js` / `cli.js` / `server.js` plus maps and type definitions) is overwritten every run, so the artifacts still update correctly with clean disabled.

However, this alone creates **a separate risk**: when entries are removed or renamed, stale artifacts can linger in `dist/` and get bundled into the publish via `files: ["dist"]` (flagged in the security review). So I added `scripts/clean.mjs`, and **the release build `build:all` now runs clean → build → build:ui** in that order. A plain `pnpm build` during development doesn't clean, so `dist/ui` is preserved.

Verified: (1) `dist/ui/index.html` survives a standalone `pnpm build` and `pnpm test` (which calls build internally); (2) planting stale files in `dist/` and running `build:all` removes them and correctly regenerates `dist/ui`. Removed the workaround warnings in `VERIFICATION.md` and `docs/dev/architecture.md`.

### A-2. Received SSE events don't end up in history — Implemented (2026-08-08)

**Basis**: the SSE branch in `src/core/runner.ts` sets `responseSnapshot.body = undefined`, and `events` only ever lands in `StepResult`. WebSocket, on the other hand, records received messages as an array in `response.body`. **The same "stream reception" concept is persisted asymmetrically**, so the UI's history browser shows nothing at all of what an SSE step received.

The history schema's contract is that additive changes can stay at `v: 1`, so adding `events?: SseEvent[]` to `HistoryEntry` would be enough.

**Cost**: roughly 1 hour (runner recording, types, UI display, tests). **Verdict: recommended** — SSE verification is positioned in the requirements as "a differentiating feature no off-the-shelf tool has," so it's an incomplete feature if the result doesn't survive into history.

**Resolution**: added `events?: SseEvent[]` to `HistoryEntry`, so SSE steps now record their received events in history (`response.body` still stays undefined, as before). The UI's history browser also renders the events expanded. See [history.md](../guide/history.md) for details.

### A-3. Skipped steps don't end up in history — Implemented (2026-08-08)

**Basis**: the skip branch in `runner.ts` never calls `historySink`, so skipped rows never appear in the history JSONL. You can't trace from the UI's history "where it stopped and what didn't run downstream" (though you can infer it, since the failed step itself does get recorded).

This also implies a design change: `HistoryEntry` has no `status` field today (success/failure is currently inferred from the contents of assertions).

**Cost**: 2-3 hours (schema extension + fixing the UI's grouping display logic + tests). **Verdict: conditional** — worth it once the history UI actually sees heavy use. Since the failing row is still recorded, the missing information is limited.

**Resolution**: added `status?: "passed" | "failed" | "skipped"` to `HistoryEntry`, so skipped steps are now recorded as a row with `status: "skipped"`, no request/response, and empty assertions. Older entries without `status` still fall back to being derived from assertions, preserving read compatibility. See [history.md](../guide/history.md) for details.

### A-4. Secrets persist in history in plaintext — Implemented (2026-08-08)

**Basis**: history records **already-resolved template values**, so a value passed via <code v-pre>{{env.TEST_PASSWORD}}</code> ends up in plaintext in `.klaus/history/*.jsonl`. There's a warning in `docs/guide/history.md` and it's in `.gitignore`, but **`klaus ui`'s history browser displays that same content in the browser**.

**Candidate fix**: declare masked fields in the flow definition (`request.secretFields: ["password"]`), or auto-mask based on header/key names like `Authorization` / `*token*` / `*password*`.

**Cost**: 3-4 hours (designing the masking layer, wiring it into core, UI display, tests). **Verdict: conditional** — as long as this stays personal, local verification, the existing warning is enough. It becomes necessary once history gets shared across a team.

**Resolution**: took a different approach than the candidate fixes above. Values resolved from OS environment variables via <code v-pre>{{env.X}}</code> (length 4 or more) are now automatically replaced with `***` right before a history entry is written (`maskHistoryEntry`), covering the request's url/headers/body, the response's headers/body, and the `data` field of SSE events. It applies to both the default file sink and custom sinks; live run output (the UI's execution view) and values sourced from environment files are not covered. See [SECURITY.md](https://github.com/almondoo/klaus/blob/main/SECURITY.md) and [history.md](../guide/history.md) for the precise boundary.

**Addendum (2026-08-09)**: an audit raised two follow-up findings, both since fixed. (1) Masking only matched the raw value by substring, so a secret placed in `request.query` still leaked in plaintext once `URLSearchParams` percent-encoded it (`expandSecretVariants` now also covers the encoded variants). (2) The JUnit report produced by `klaus run --report junit` wasn't going through the same mask, leaving plaintext secrets in CI artifacts (masking was added to `formatJUnit`; stdout text/JSON output and live run output remain unmasked, as before).

### A-5. `environments/` resolution is cwd-only — Implemented (2026-08-08)

**Basis**: `resolveEnvironmentPath(cwd, name)` is based on the runtime current directory. Even in this session, running the samples required `cd examples` first. Running `klaus run api/foo.yaml` from a project subdirectory fails to find the environment file.

**Candidate fix**: search upward from cwd for `environments/` (stopping at `.git` or the filesystem root), or a `--env-dir <path>` option. The former gives a "works no matter where you invoke it from" experience, but needs an explicit upper bound on the search (the same kind of boundary the path-traversal fix needed).

**Cost**: 1-2 hours. **Verdict: recommended** — directly affects the CLI's first-run experience. Just make sure the search behavior is documented clearly.

**Resolution**: went with the former (upward search). `resolveEnvironmentPath` now walks from cwd up through parent directories, stopping at the first ancestor directory containing `.git` (that directory itself is still checked) or the filesystem root. Each candidate directory is boundary-checked for path traversal before it's ever touched on the filesystem.

**Addendum (2026-08-09)**: an audit flagged a missing trust boundary — an attacker could plant an environment file in an ancestor directory above the cwd. Fixed: a candidate found above the cwd now has its owner and other-writable bit checked, and is refused (fail closed) if untrustworthy (`assertTrustedAncestorEnvironmentsSource`; POSIX only, skipped on Windows). See [SECURITY.md](https://github.com/almondoo/klaus/blob/main/SECURITY.md) for details.

### A-6. No `klaus init` — Implemented (2026-08-08)

**Basis**: starting a new project requires hand-creating `environments/local.yaml` and a sample flow. Even in this session I created `examples/` by hand. A `klaus init` that scaffolds a template would shorten the first-run experience.

**Cost**: 1-2 hours. **Verdict: conditional** — pays off once this is distributed to others (published on npm). While it's just for personal use, copying `examples/` is enough.

**Resolution**: added a `klaus init` subcommand (`src/cli/init.ts`).

### A-8. Mobile drawer focus management — Deferred (for now)

**Basis**: found via browser QA. Opening the drawer at 767px and below **doesn't move focus into it** — it stays on the hamburger button behind it. The close button isn't reachable via forward Tab; it needs Shift+Tab. This doesn't meet the usual conventions for overlay UI (move focus inside on open, return it to the triggering element on close, trap focus while open).

**Verdict: deferred** — fixing this properly needs a focus trap plus focus restoration, which means deciding between hand-rolling it or switching to Radix's Dialog/Sheet (cost: 2-3 hours). On the other hand, this drawer **only appears below 768px**, and the affected audience — "someone operating a local dev tool by keyboard on a narrow screen" — is a rare combination. Escape-to-close already works, so there's a minimal way out. Will revisit with a switch to Radix Sheet if mobile-width usage actually shows up.

### A-7. Parallel execution of multiple flows — Deferred (for now)

**Basis**: `runFlows` runs sequentially. With many independent flows, total time grows linearly.

**Verdict: deferred** — at the current expected scale (a handful of local API flows), there's no perceptible difference. Parallelizing would require care around output ordering, history ordering, and rate limits — the added complexity outweighs the benefit. Revisit once flow counts grow and this shows up as a measured problem.

---

## B. Process (how I worked) improvements

Failures that **actually happened** during this session, and the lessons from them. Notes to carry into similar work next time.

### B-1. I wrote a warning down but didn't fold it back into my own workflow

I wrote in `docs/dev/architecture.md` that "the `build:all` order is mandatory (tsup's clean wipes dist/ui)" — and then, during later verification, ran `pnpm test` and started the UI anyway, hitting the 503. **Twice.**

**Lesson**: a constraint written into docs needs to become a check in my own execution steps too. More fundamentally, per A-1, **fix designs that rely on documentation as a workaround** rather than living with them.

### B-2. I was slow to give up on a failing subagent

A documentation-writing subagent stalled or errored out **5 times** (one large task → split it → still failing). I only switched to "just write it myself" on the third attempt, but **should have switched at the second**.

**Lesson**: after the same task fails twice, consider switching who executes it (the main model doing it directly) rather than splitting it further. Especially once "research is done, all that's left is writing" — at that point the main model writing it directly is faster.

### B-3. Manual E2E found 2 real bugs even after passing automated tests and a multi-lens review

Running through the `VERIFICATION.md` steps surfaced **assertion expected values not going through template expansion** (<code v-pre>equals: "{{testEmail}}"</code> was being compared as a literal string) and **a date-dependent test** — despite having already passed 118 tests and four review lenses (correctness / simplification / test coverage / security).

**Lessons**:
- Something like template expansion that amounts to a "**full coverage matrix of the spec**" (which locations expansion applies to) needs a table that tests every combination explicitly. Individual behavior tests leave gaps invisible
- Actually running commands end-to-end doesn't replace automated tests, but **automated tests don't replace E2E either** — both are needed

### B-4. Wrote a time-dependent test

A history test hardcoded `new Date("2026-08-07")`, and it failed the next day when the date changed.

**Lesson**: if a test needs a fixed date/time value, either make it possible to inject that same fixed value into the production code too (e.g. `appendHistory(dir, entry, date)`), or have the test use "the date at execution time" instead.

### B-5. Added a defense but didn't sweep for the same input pattern elsewhere

The `env` path-traversal issue found in `POST /api/runs` during the security review existed even though **`path` in that very same request body already had a boundary check**. Once a defense goes in at one spot, sweeping "what about other parameters on the same path" would have caught this without waiting for review.

**Lesson**: whenever you add input validation or a boundary check, always enumerate the other inputs that cross the same trust boundary. Fixing one means checking what's around it.

### B-6. What worked well (keep doing this)

- **Parallel multi-lens review** (correctness / simplification / test coverage / security) worked. In particular, the "test coverage" lens flagged not just 6 missing cases but also **one duplicate test with zero detection power**, preventing test padding
- The **80%+-confidence-only reporting rule** made triangulation across review results possible (multiple lenses independently flagging the same root cause from different angles). The double-held `response.body` for SSE was flagged by both the simplification lens and the test-coverage lens, revealing they shared one root cause
- Requiring **verification with a reproduction script** turned the SSE disconnect freeze and the WS socket leak from "theoretical concerns" into **confirmed, demonstrated bugs**

---

## Priority (proposed)

| Rank | Item | Reason |
|---|---|---|
| 1 | A-1 build clean issue | Users will hit this for certain. Minimal cost |
| 2 | A-2 SSE history recording | A differentiating feature is incomplete if its result doesn't persist |
| 3 | A-5 environments resolution | Directly affects the first-run experience |
| 4 | A-4 secret masking | Before moving to a shared-history workflow |
| 5 | A-3 / A-6 | After seeing actual usage patterns |

A-7 (parallel execution) is recommended to **not** be done at this time.
