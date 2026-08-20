# 0006 — Bot listen keys come from the profile `.env`

The Gate, running as the logged-in user, inventories Hermes profiles (`hermes profile list`) and reads **only** `API_SERVER_KEY` from each profile's `.env`. That listen key is vaulted like the existing hermes-local key and used on `/p/<name>/`. A Bot with no listen key is visible and not routable.

This is a narrow exception to ADR 0002's "do not copy Hermes credential stores." 0002 rejected treating Hermes as an xAI provider and ingesting vendor keys. A listen key is how the already-attached API server authenticates; it is not a provider credential. The Gate must not copy provider keys, OAuth tokens, messaging bot tokens, or SOUL into Gate records.

## Considered

- **A (accepted):** Read listen keys from the host profile `.env`.
- **B:** Operator pastes each key. Rejected — already-configured desktop Bots would show as dead.
- **C:** Ask Hermes to accept the default key on named prefixes. Rejected — they reversed that in July 2026.

## Invariant

Refresh, don't fork: if Hermes rotates a profile listen key, the next inventory pass updates the vault. The Gate is not the system of record for the key.
