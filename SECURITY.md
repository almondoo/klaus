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

- `klaus ui` is a **localhost-only** tool. Reports about exposing it to untrusted networks are out of scope by design, but authentication-bypass issues on the localhost boundary (e.g. token leakage, DNS rebinding) are in scope.
- Values resolved from OS environment variables via `{{env.X}}` templates (4 characters or longer) are masked to `***` before being written to local history files (`.klaus/history/*.jsonl`), covering the request's url/headers/body, the response's headers/body, assertion results (expected/actual/message), and SSE events (event/id/data). This masking has narrow boundaries and is **not** a general secrets-redaction guarantee:
  - Only values resolved through the `{{env.X}}` syntax are covered. Values sourced from environment files (`environments/*.yaml`) are **not** masked and are recorded resolved.
  - Values shorter than 4 characters are **not** masked (to avoid over-masking on incidental substring matches).
  - Live run output — the in-progress execution view / `StepResult` returned to callers — is **not** masked; only what gets written to history is.
  This is documented, intentional behavior for a local tool, not a vulnerability — but reports of unmasked secrets leaking beyond the local machine (or a bypass of the masking above) are in scope.

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
