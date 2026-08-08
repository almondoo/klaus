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
- Secrets referenced via `{{env.*}}` templates are recorded **resolved** in local history files (`.klaus/history/*.jsonl`). This is documented behavior for a local tool, not a vulnerability — but reports of secrets leaking beyond the local machine are in scope.

## Release Integrity

Versions from 0.1.1 onward are published via GitHub Actions Trusted Publishing (OIDC) with [provenance attestations](https://docs.npmjs.com/generating-provenance-statements). You can verify a version was built from this repository by checking the provenance on its npm package page, or with:

```bash
npm audit signatures
```
