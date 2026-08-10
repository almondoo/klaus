# Changelog

Records what changed in each release, plus **the decisions behind it and the pitfalls I hit along the way**.
The current spec lives in the respective references ([CLI](../../guide/cli.md) / [Flow definition](../../guide/flow-definition.md) / [Architecture](architecture.md)) — this is the place I keep "why it ended up this way."

## 0.1.1

No functional changes. First release that switches the npm publish path from manual publishing to GitHub Actions' Trusted Publishing (OIDC).

### Migrated the publish path to the OIDC pipeline

0.1.0 was published manually before the pipeline existed, so it carries no provenance attestation. From this release on, pushing a `v*` tag drives build → approval → OIDC publish, and npm attaches provenance automatically.

**Why the first release was manual**: npm's Trusted Publisher can't be configured for a package that doesn't exist yet (you can't even reach the settings screen until the package exists), so the very first publish had to be a local, interactive 2FA-authenticated publish. No tokens were ever created.

**Traps found during pre-publish verification**:

- Prefixing the `bin` path with `./` makes npm 11 treat it as invalid, and it **silently drops the `bin` entry and publishes anyway with only a warning**. That would have shipped a broken package where installing it produces no command
- Without a `default` (or `require`) condition in `exports`, CommonJS `require()` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. This has nothing to do with Node 24's `require(esm)` support — it fails at the resolution stage, before any file is even read
- Neither of these shows up under static analysis. They were only caught by actually installing the tarball in isolation and running `klaus --version` plus `require()` / `import()` against it

### Switched the license to Elastic License 2.0 (`773e8d6`)

Changed from MIT to ELv2. Use, modification, and redistribution remain free, but **offering this software to third parties as a hosted or managed service is prohibited**. I accepted, as a tradeoff, that this is no longer OSI-defined open source. The MIT version was never published or committed anywhere, so the switch was clean.

### Security design of the release workflow (`5667a99`)

The configuration that came out of adversarial review (two attack-lens passes, one legitimacy-lens pass).

- Every action is pinned to a commit SHA. pnpm is also pinned to an exact version (`version: 11` would fetch the latest 11.x at run time)
- Starts from `permissions: {}` and grants least privilege per job
- Separated the build job, which runs dependency code, from the publish job, which holds the OIDC token. The publish side does no checkout and no dependency install — it only publishes the already-verified tarball (`npm publish <tarball>` doesn't run lifecycle scripts)
- Deliberately left `registry-url` unset in `setup-node`. Setting it writes a `NODE_AUTH_TOKEN` placeholder into `.npmrc`, which can conflict with OIDC (actions/setup-node#1440, #1551)

**Something that has to be configured outside the YAML**: Actions runs the workflow as it exists at the commit the tag points to, so whoever can create a tag can run a tampered workflow along with it. The only thing that closes this is a repository ruleset restricting creation/update/deletion of `v*` tags. The `npm-publish` environment also needs to be created ahead of time — if it isn't, it gets auto-created with no protection, and the approval gate silently disappears.

## 0.1.0

### Migrated the UI to shadcn/ui (`df9de3d`)

Replaced hand-written CSS and custom components wholesale with shadcn/ui (style: new-york) + Radix primitives + Tailwind CSS v4.

- 11 components introduced: `badge` / `button` / `card` / `collapsible` / `progress` / `scroll-area` / `select` / `separator` / `skeleton` / `table` / `tooltip`
- Dependencies: 7 Radix packages plus `class-variance-authority` / `clsx` / `tailwind-merge` (`cn()`), with `lucide-react` for icons
- Tailwind v4 uses a CSS-first setup, so there's no `tailwind.config.js` — tokens are defined in an `@theme` block
- The source of truth for implementation tokens is [ui/docs/design-system.md](https://github.com/almondoo/klaus/blob/main/ui/docs/design-system.md), and for component structure it's [ui/docs/components.md](https://github.com/almondoo/klaus/blob/main/ui/docs/components.md)

See [ui-ux-design.md](ui-ux-design.md) for the intent and design direction of the migration.

### Fixed a bug where the environment (env) couldn't be changed while a flow was selected

**Symptom**: switching the env selector while a flow was selected snapped straight back to the original value — you couldn't actually change it.

**Cause**: the `useEffect` that initializes env in `ui/src/App.tsx` had `selectedEnv` itself in its dependency array, so the same effect re-fired on every user change and rolled it back to the initial value.

**Fix**: used `initializedEnvForPathRef` so initialization only happens when the flow itself changes, and the user's selection is never overwritten.

**Verification**: in a real browser, selected `development`, confirmed the value stuck, and confirmed the actual outgoing HTTP request carried the `development` value (`dev@example.com`) — checked in all three of the raw SSE response, the execution view, and the history.

### Fixed missing focus rings (a11y)

A regression introduced during the shadcn migration. **This stems from a Tailwind CSS v4 behavior, so writing `outline-none` again in the future can reintroduce the same trap.**

- In v4, `outline-none` **unconditionally** sets `--tw-outline-style: none`
- `focus-visible:outline-2` only sets the thickness and reads that same variable, so combined with `outline-none` **nothing renders even when focused**
- Fixed by adding `focus-visible:outline-solid`, which restores the style on focus

Fixed in `button` / `select`, then swept the codebase for the same pattern and found and fixed the identical bug in `scroll-area` as well. Verified visually via before/after screenshots comparing the focused and unfocused states.

### Dependency updates and security response

- Raised the Node.js floor to **`>=22.19.0`** (previously `>=20`)
- Updated commander 15 / undici 8 / zod 4 / vite 8 / vitest 4 / biome 2. The major version bumps required **no** code changes
- Resolved an esbuild vulnerability flagged by `pnpm audit` via `overrides` in `pnpm-workspace.yaml`

**Pitfall**: this override **must be pinned to an exact version**.

- A range (`">=0.28.1"`) is **silently ignored, with no warning**
- `pnpm.overrides` in `package.json` is not read by pnpm 11 — it prints `[WARN] The "pnpm" field in package.json is no longer read by pnpm`

```yaml
# pnpm-workspace.yaml
overrides:
  esbuild: 0.28.1   # A range doesn't take effect here
```

The security review of the code turned up zero findings at 80%+ confidence. Confirmed the UI's `dangerouslySetInnerHTML` escaping actually neutralizes attack payloads by sending real ones through it.

### Tightened tsconfig

Applied the full set of strict flags, including `exactOptionalPropertyTypes`. This surfaced 19 type errors, which I resolved by extending type definitions and adding real guards — not by papering over them with `!` (non-null assertion) or `as`.

### Added a port option to `klaus ui`

```bash
klaus ui -p 4400        # or --port 4400
```

When omitted, it still auto-selects a free port as before. See the [CLI reference](../../guide/cli.md) for details.

### Reworked the build setup

After hitting the accident three times where `pnpm build` took out `dist/ui` along with it and broke `klaus ui` with a 503, I disabled tsup's `clean` and moved to a setup where only the full release build empties `dist/` via `scripts/clean.mjs`.

- Confirmed by experiment that even a glob array (`clean: ["dist/*.js", ...]`) still wipes the whole outDir
- See the "Build" section of [architecture.md](architecture.md) for the full division of responsibility

### Documentation work

- Placed the UI design docs under `ui/docs/` (README / design-system / components). Everything in them is backed by the actual code, and in the process I found 7 discrepancies against the existing docs (icon library, focus ring color, etc.) and **corrected the docs to match the implementation, treating the implementation as ground truth**
- Added [Improvement proposals](improvement-proposals.md). Grounded only in things that actually happened, with a verdict (recommended / conditional / deferred) and a rough cost estimate on each item

### Verification results

| Item | Result |
|---|---|
| Clean full build (`pnpm build:all`) | Success (confirmed `dist/ui/index.html` was generated) |
| root tests (vitest) | 121 passed / 121 |
| ui tests (vitest + jsdom) | 10 passed / 10 |
| Type check (`pnpm typecheck`) | OK |
| Lint (`pnpm lint`) | 102 files, no fixes needed |
| `pnpm audit` | No known vulnerabilities found |
| CLI smoke test | Confirmed `--version` / `ui --help` (including the `-p` short form) work |

**Not verified**: couldn't run `npm pack --dry-run`, so I substituted by checking the contents of `dist/` directly for what gets bundled into publish (no stale artifacts remained since this was right after a clean build). Run this check when preparing an actual npm publish.

## Initial implementation (`4cc0495`)

Implemented M1–M3 of the requirements ([requirements.md](requirements.md)): the core execution engine, a CLI with an exit-code system, a localhost UI server (Hono) and SPA, GraphQL / WebSocket / SSE support, run history in JSONL, and the accompanying docs.

Notable bugs found and fixed during implementation:

- **A history write failure was corrupting the step result** — the `historySink` call was inside the main try/catch, so a disk error would turn an already-successful step into `status: "error"` and drop its capture. Moved the history write outside the try/catch, and failures are now reported to stderr via `onWarning` instead
- **A capture failure was propagating as the literal string `"undefined"`** — when a JSONPath didn't match, the value became `undefined`, which template expansion turned into the string `"undefined"`, resulting in sending `Authorization: Bearer undefined`. Fixed to throw a `RuntimeError` (exit 3) instead (a legitimate `null` still succeeds as before)
- **A client disconnect froze the SSE run forever** — `res.write()` on an already-torn-down response returns `false` and `'drain'` never fires, causing a deadlock. Raced it against `'close'` / `'error'`, made subsequent SSE writes no-ops, while **still running the flow to completion so history is preserved**
- **A WebSocket socket leak** — `fail()` wasn't closing the socket on a send failure. Consolidated into a shared `cleanup()`
- **Path traversal via `env`** (security) — `POST /api/runs` validated `path` but not `env`. Addressed with two layers: a boundary check on the core side and a 403 on the server side
- **Assertion expected values weren't going through template expansion** — found via manual E2E (<code v-pre>equals: "{{testEmail}}"</code> was failing because it never got expanded). Applied `renderDeep` to the `assert` block as well and added a regression test
