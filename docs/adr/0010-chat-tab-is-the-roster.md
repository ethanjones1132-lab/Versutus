# 0010 — The Chat tab is the roster

The Chat tab opens a **roster**, not the last session. First row is **configurable chat**: today's conversation — model picker, sessions, CLI backend — with `bot` omitted (ADR 0009). Named **Bots** list underneath as conversations you jump into (`bot=<name>`). You pick, then you talk.

This is desktop Bot Mode's roster, plus an explicit Chat row so Codex/Claude/OpenCode and ad-hoc model/session choice stay one tap away. It is not "throw the user into the most recent convo."

## Considered

- **A:** Roster only picks a Bot; Chat still auto-resumes. Rejected — that is the throw-in-to-last-convo path.
- **B (accepted, with a Chat row):** Tab is the roster. Configurable chat first, Bots below.
- **C:** Chat tab unchanged; Bots as a text tile. Rejected — not the UI this work is for.

`default` is listed as a Bot with the others (ADR 0013). Configurable chat remains the first row; the overlap is accepted.

See `CONTEXT.md` (Roster, Configurable chat) and ADR 0007 (slice 1 is still talk-to-existing; New Agent on this roster is next work).
