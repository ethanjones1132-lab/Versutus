# 0009 — A Bot is a selector on the Hermes backend

A Bot is not a backend and not a nested REST tree. Chat, sessions, and jobs keep `backendId` as the CLI environment (ADR 0003). When the backend is Hermes, an additional `bot=<name>` selects that profile's multiplex prefix and listen key (ADRs 0004–0006). Omitted `bot` is the default profile on the unprefixed listener.

Inventory is a new list (`GET /v1/bots` or equivalent). Conversation routes are not duplicated under `/v1/bots/{name}/…`.

The backend picker stays on **configurable chat**, not on Bot rows. The Chat tab opens the roster (ADR 0010). A future non-Hermes roster row (ADR 0004 option B) must not be smuggled in as a virtual backend.

## Considered

- **A (accepted):** `backendId` + `bot` selector.
- **B:** Each Bot is a virtual backend. Rejected — backends would stop meaning CLI environments; capability OR and the picker would lie.
- **C:** Nested `/v1/bots/{name}/sessions|chat|…`. Rejected — duplicates the surface just fronted for skills/cron/sessions.

See ADR 0003 (what a backend is) and ADR 0004 (what a Bot is).
