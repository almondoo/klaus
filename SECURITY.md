# Security Policy

## Supported Versions

Only the latest published version of `@almondoo/klaus` receives security fixes.

| Version | Supported |
| ------- | --------- |
| latest (0.1.x) | Yes |
| older | No |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's private vulnerability reporting instead:

1. Go to the [Security tab](https://github.com/almondoo/klaus/security) of this repository
2. Click **Report a vulnerability**
3. Fill in the details (affected version, reproduction steps, impact)

You will receive a response within 7 days. Once the issue is confirmed and a fix is released, the report will be disclosed as a security advisory with credit to the reporter (unless you prefer to remain anonymous).

## Scope Notes

- `klaus ui` is a **localhost-only** tool. Reports about exposing it to untrusted networks are out of scope by design, but authentication-bypass issues on the localhost boundary (e.g. token leakage, DNS rebinding) are in scope. Note that the startup token is passed as a command-line argument to the browser-launch command (`open` / `xdg-open` / `cmd /c start`) and is also printed to stdout, so on a **shared multi-user host** it is readable by other local users via the process table (`ps`, `/proc/<pid>/cmdline`). This is a known limitation, not a new finding; use `--no-open` on shared hosts to avoid passing the token through the launch command's argv (it is still printed to stdout).
- Values resolved from OS environment variables via `{{env.X}}` templates (4 characters or longer) are masked to `***` before being written to local history files (`.klaus/history/*.jsonl`) and to JUnit report files (`--report junit`), covering the request's url/headers/body, the response's headers/body, assertion results (expected/actual/message), and SSE events (event/id/data). Masking matches both the raw secret value and its URL-encoded representations (percent-encoding, and the `+`-for-space form `URLSearchParams` produces), so a secret placed in `request.query` is masked in its encoded form too. This masking has narrow boundaries and is **not** a general secrets-redaction guarantee:
  - Only values resolved through the `{{env.X}}` syntax are covered. Values sourced from environment files (`environments/*.yaml`) are **not** masked and are recorded resolved.
  - Values obtained through `capture:` are **not** masked either, and this is the exclusion most likely to surprise: the documented idiom for `capture:` is extracting a login token and reusing it as a bearer token in later steps, so a live credential is recorded resolved in the history JSONL, the JUnit report, and record/replay cassettes. Since these files are plain text that a team may deliberately commit and share, check them for captured credentials before doing so.
  - Values shorter than 4 characters are **not** masked (the length check applies to the raw value, to avoid over-masking on incidental substring matches).
  - The file outputs (the history JSONL and JUnit report) are **always** masked. Stdout — both the text reporter and `--json` — is masked by default as well, but only that side can be turned off, with `--no-mask` (or `run.mask: false` in `klaus.config.yaml`); the file outputs are unaffected by that flag. Never masked at all: the `StepResult` returned to programmatic callers of the core API, `klaus ui`'s SSE stream, and the in-progress execution view that stream feeds.
  This is documented, intentional behavior for a local tool, not a vulnerability — but reports of unmasked secrets leaking beyond the local machine (or a bypass of the masking above) are in scope.
- Assertion `regex` matchers (`assert.headers[].regex`, `assert.body[].regex`, `assert.bodyText.regex`, `assert.events[].regex`, `assert.messages[].regex`) are compiled with Node's built-in `RegExp` and evaluated with no execution timeout and no complexity limit. A catastrophic-backtracking pattern can therefore block the single Node event loop until the process is killed — either because a flow file you did not write carries a hostile pattern, or because a benign-looking pattern of your own meets crafted response data from the API under test. Node offers no way to interrupt a running regex; a linear-time engine (RE2) is a native module that the bundled-dependency model described below cannot ship, and a length cap on the pattern would not help, since the shortest catastrophic patterns are only a few characters. Treat flow files as code you are choosing to run, and run only the ones you trust. This is a known limitation, not a new finding.
- Environment files (`environments/<name>.yaml`) are located by searching upward from the cwd through ancestor directories. For a candidate found **above** the cwd (the cwd's own `environments/` is the user's explicit choice and isn't checked), klaus refuses to load it (exit 2) if the `environments` directory or the candidate file is owned by another user or is other-writable — this closes a local-privilege boundary where another user on a shared host could otherwise plant a hostile environment file in an ancestor directory. Group-writable directories/files are intentionally still allowed — only other-writable ones are rejected — because on systems using umask `002` with a private group per user (common on RHEL-family distributions), ordinary files are group-writable by default, and rejecting them would incorrectly block normal use. Since any ancestor owned by someone else is already rejected by the ownership check regardless of its mode, this leaves only a narrow residual case open: a **self-owned** ancestor that is group-writable and whose group happens to have other members. This check is **POSIX-only** and is skipped on Windows (`process.getuid()` doesn't exist there, and permission bits don't map to the ACL model); reports specific to that Windows gap are a known limitation.

## Release Integrity

Versions from 0.1.1 onward are published via GitHub Actions Trusted Publishing (OIDC) with [provenance attestations](https://docs.npmjs.com/generating-provenance-statements). You can verify a version was built from this repository by checking the provenance on its npm package page, or with:

```bash
npm audit signatures
```

## Supply Chain: Bundled Runtime Dependencies

Runtime dependencies (`commander`, `eventsource-parser`, `hono`, `jsonpath-plus`, `undici`, `yaml`, `zod`, and `jsonpath-plus`'s own transitive dependencies) are bundled directly into `dist` at build time via tsup, rather than being resolved from `node_modules` at install time. This means:

- Published artifacts are **fixed at release time**: a compromised or maliciously updated version of one of these packages on npm cannot affect an already-published version of `@almondoo/klaus`, since the bundled code was captured at build time from the versions locked in this repository's lockfile.
- Dependency updates (including security fixes) reach users through a new `@almondoo/klaus` release, driven by Dependabot pull requests against this repository's own `package.json` / `pnpm-lock.yaml`, followed by a re-publish.
- Because these dependencies are bundled, they will **not** appear in `npm audit` results run against a project that depends on `@almondoo/klaus` — consumers only see klaus itself as a dependency. klaus's own lockfile and Dependabot configuration remain the source of truth for tracking and updating these bundled dependencies; see [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md) for the license of each bundled package.
