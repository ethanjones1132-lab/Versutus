# 0012 — Tapping a Bot opens Bot Chat

A Bot row is the conversation, not another list. Tap opens that Bot's canonical **Bot Chat** (the forever-chat Bot Mode creates and pins). If the session is missing, create and pin it.

This is not tab-level auto-resume (ADR 0010). The tab is the roster so you are not dumped into last night's thread. A Bot tap *is* the pick.

Once inside, the user can still run **parallel sessions on that Bot's profile** — same soul, keys, and model pin, different threads. That is desktop Bot Mode: the Bot's session menu lists that profile's conversations; regular sessions keep `/new`; **Bot Chat itself is never forked**. Derive the rules from Hermes Desktop rather than inventing a second session model.

In Versutus: the session switcher inside a Bot is that Bot's sessions only (`bot=<name>`). Bot Chat stays a distinct, pinned row. **New session** creates a non-canonical session on that profile. `/new` in Bot Chat must not replace Bot Chat (desktop compact-in-place; slice 1 may use the New session control and leave compact for later). `/new` in a dedicated session on that Bot is normal.

## Considered

- **A (accepted):** Land on Bot Chat.
- **B:** Land on that Bot's session list. Rejected — a Bot tap already was the pick.
- **C:** Land on that Bot's last session. Rejected — same smell as auto-resume, namespaced.
