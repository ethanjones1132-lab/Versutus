# 0011 — Default Hermes profile is not a Bot row

Status: superseded by ADR 0013. The duplicate door is accepted; `default` is listed with the other Bots.

The roster lists **named** Hermes profiles as Bots. The default profile (`~/.hermes`, id `default`) is not a Bot row. **Configurable chat** is that door: `backendId=hermes-local` with `bot` omitted, unprefixed listener (ADR 0009). The Chat row may show the default display name or avatar as a caption when the backend is Hermes; it is still configurable chat (model picker, session list, backend switch).

Two rows into the same `HERMES_HOME` would make the roster lie. Hiding configurable chat when Hermes is selected would remove the “I’m not inside a Bot” path.

Tapping a named Bot sets `bot=<name>` on that Hermes backend. It does not depend on which backend configurable chat last used.

## Considered

- **A (accepted):** Named Bots only; default is configurable chat.
- **B:** List `default` as a Bot. Rejected — duplicate door into the same home.
- **C:** Hide configurable chat on Hermes. Rejected — loses the configurable path on the runtime you use most.
