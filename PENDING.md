# Pending work - the one place for everything not on master

`master` is the source of truth (aea7f67, 2026-10-18: the first batch of MED findings from the
2026-10-11 quality scan). The pending branch this file used to describe was merged into master as
6d9cda5 (2026-09-29: format, encoding and constellation fixes, and the pending-work docs) and was
then deleted; it held nothing that is not on master. Everything still pending is below. Agents: do
not treat archive tags as a to-do list; this file is the list.

## Merged since the last revision

| Commit | What | Status |
|---|---|---|
| 5088d5d | fix(format): a timestamp from another year shows its year | merged on master via 6d9cda5 (2026-09-29) |
| 33a06b2 | fix(format): a count in the billions reads as B rather than thousands of M | merged on master via 6d9cda5 |
| 3010a62 | fix(encoding): an unpaired surrogate encodes as U+FFFD rather than invalid UTF-8 | merged on master via 6d9cda5 (its stale coverage-baseline hunk was dropped) |
| e9d535d | fix(fleet): host and routine edges render with unique keys and native filters host layer | merged on master (09-18 18:44; rebased twin of 71158ef, same patch) |

`docs/plans/archive-2026-09-12/` - realtime-voice and Android-widget plans, briefs and drafts from
the 09-12/09-13 agent runs. On master via 3e460fc/6d9cda5; kept for history.

## Open work (not on master)

- **Hands-free calls never open** - "This phone would not open a call session" on the local
  engine. Handed to Grok 4.6: `docs/plans/HANDOFF-2026-09-18-handsfree-call-grok.md` (on master).

- **Approve/Deny on the notification** - tag `archive/approve-deny-notification-buttons` (8a6d0aa,
  still not on master). Held on purpose until approving from the lock screen requires unlocking.
  Operator's call.
- **Launcher shortcuts for recent Bots** (salvage item 15) - not on master; 603cc1b in tag
  `archive/sprint-features-functions-ui` (rebuild on master's code).
- **Council: a failed Bot slot is shown, not silently dropped** in the UI (the Gate side already
  times out and reports errors). (unverified)
- **Codex voice engine on the ChatGPT login** - blocked: Codex CLI 0.147.0 answers
  `thread/realtime/start` with "realtime conversation requires API key auth". The exact call
  sequence and what to build when that changes are in `.sprint-jev/HANDBACK.md` (A2) in the main
  checkout. (unverified - that checkout is not reachable from here)
- **Gate's own provider path** (Gate setup cards, not the Hermes chat path): OpenCode Go needs the
  `x-opencode-session` header; OpenCode Zen's key is rejected (401, needs sign-in); NVIDIA's card
  shows an old 404 from a chat that named a model it does not carry. (unverified)
- **Hermes host patches** live as uncommitted edits in `%LOCALAPPDATA%\hermes\hermes-agent` (a Hermes
  update overwrites them): union-alpha routed to `/messages`, a text-only stream drop treated as a
  retryable drop, and the boot integrity-check loop fix (also committed as 8c3933c3e on branch
  `fix/boot-integrity-check-loop` in `hermes-agent-fix-boot-integrity`). (unverified - that branch
  is in another checkout)

## Archives (reachable, not pending)

| Tag | What it holds |
|---|---|
| `archive/sprint-features-functions-ui` (+ `-origin`, `-build`) | The stale 2026-09-14 sprint. Hand-ported on 09-15; of its 64 unmatched commits 9 are in master verbatim, 5 would apply, 50 have diverged into master's rebuilt versions. Use it only as a reference for the open items above. |
| `archive/gemma-sprint-optimization` | The pre-merge twins of the three fixes above (c295d05, 12fdea7, 95cdd4d); the merged versions are 5088d5d, 33a06b2, 3010a62. |
| `archive/approve-deny-notification-buttons` | See open work. |
