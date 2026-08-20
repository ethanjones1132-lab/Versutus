# 0005 — Bot routing via Hermes multiplex

Chat, sessions, and jobs for a Bot go through the single attached Hermes on `/p/<name>/…`, authenticated with that Bot's own `API_SERVER_KEY`. The default profile stays on the unprefixed listener. The phone keeps one **gateway profile** (the Gate); the roster is an in-app view, not N connections.

Hermes already owns this address (`gateway.multiplex_profiles`). Named prefixes reject the default listen key (July 2026). If multiplex is off, the Gate fails honestly rather than guessing a header or spawning `hermes -p` (ADR 0008).

## Considered

- **A (accepted):** Gate fronts the multiplex prefix + per-Bot listen key.
- **B:** One gateway profile per Bot. Rejected — turns the roster into gateway-switching and fights single-active-gateway.
- **C:** Gate shells `hermes -p <name>`. Rejected — fights attach-before-spawn and throws away the Hermes backend we already front.

See ADR 0004 (what a Bot is), ADR 0006 (where listen keys come from), and `CONTEXT.md`.
