# 0004 — Bots are Hermes profiles

Versutus Bots are the Hermes desktop Bot Mode primitive: a Bot **is** a Hermes profile (`~/.hermes/profiles/<name>/`), not a new identity store and not a Discord/Telegram channel. The phone talks to Bots that already exist on the attached Hermes, and may create/edit Bots as Hermes profiles. Codex, Claude Code, and OpenCode stay CLI environment backends; they are not Bots.

This keeps `@mention`, canonical Bot Chat, routines (`[bot:<name>]` crons), soul, and scoped sessions — all of which exist only on Hermes profiles. A future roster row that is backed by a non-Hermes CLI (option B) is allowed later, but must not claim to be a Bot and must not ship in the first cut.

## Considered

- **A (accepted):** Bot = Hermes profile. "CLI backend" on a Bot means which Hermes environment it lives on.
- **B (deferred):** A Bot's runtime can be any CLI. Rejected for v1 because it invents a Gate-owned agent identity and drops the Bot Mode features the work is for.
- **C:** Honest split in the same roster. Same as B for v1; do not start here.

## Rejected for this decision

- Treating `runner.adapters` (channels) as Bots — that was the Phase 7 handoff's object, and it is the wrong one.
- One **gateway profile** per Bot on the phone — that is how the app remembers a gateway, not an agent. Routing is ADR 0005.

See `CONTEXT.md` (Bot, Soul, the "profile" disambiguation).
