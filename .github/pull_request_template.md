# Pull request

## Summary

<!-- What does this change do, and why? One or two sentences. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / internal change
- [ ] Documentation only
- [ ] CI / tooling

## Related issues

<!-- e.g. "Closes #12". Leave blank if none. -->

## How this was tested

- [ ] `npm run verify` (config check, `tsc --noEmit`, lint, Jest + coverage ratchet, Gate tests)
- [ ] `npm run smoke:portal`
- [ ] `npm run smoke:live` against a gateway (state the gateway kind below)
- [ ] Manually on a device / simulator (state the platform below)

Notes (gateway kind, platform, Bot vs configurable chat, anything not covered):

<!-- -->

## Checklist

- [ ] The change stays inside this repository's scope; no app code, lockfiles, secrets, or `.env*` files are touched unless the PR is explicitly about them.
- [ ] **No secrets**: no tokens, listen keys, provider keys, credential-bearing gateway URLs, `.env` contents, hostnames, or IP addresses.
- [ ] Terminology matches `CONTEXT.md` (gateway, gateway profile, Bot, roster, Gate, Hermes, run, approval, and so on).
- [ ] Tests are added or updated for behaviour changes; no tests were skipped, deleted, or weakened.
- [ ] Docs are updated where the change is user-visible or architectural (`README.md`, `docs/`, ADRs).
- [ ] This PR contains no unrelated changes.

## Screenshots / recordings

<!-- For UI changes (dark-only, portrait). Delete this section if not applicable. -->
