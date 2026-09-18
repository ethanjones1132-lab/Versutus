# Pending work - the one place for everything not on master

`master` is the source of truth (b12271c, 2026-09-18: push identity, PC voice path, MagicDNS
fallback, token cleaning, voice for bootstrap-token phones). This worktree
(`C:\Projects\Versutus-pending`, branch `pending/unmerged`) holds everything that is **not** on
master yet. Nothing else in the repo is pending: every other branch was merged and deleted on
2026-09-18. Agents: do not treat archive tags as a to-do list; this file is the list.

## On this branch, ready to verify and merge

| Commit | What | Status |
|---|---|---|
| 5088d5d | fix(format): a timestamp from another year shows its year | from `archive/gemma-sprint-optimization`; needs `npm run verify` |
| 33a06b2 | fix(format): a count in the billions reads as B rather than thousands of M | same |
| 3010a62 | fix(encoding): an unpaired surrogate encodes as U+FFFD rather than invalid UTF-8 | same (its stale coverage-baseline hunk was dropped) |
| (latest) | fix(fleet): host and routine edges render with unique keys and native filters host layer | last commit of the Jev sprint (71158ef, 09-18 18:44), not yet audited |

`docs/plans/archive-2026-09-12/` - realtime-voice and Android-widget plans, briefs and drafts from
the 09-12/09-13 agent runs. They were untracked files in the deleted Codex worktrees; kept for history.

## Open work (not started on master)

- **Approve/Deny on the notification** - `archive/approve-deny-notification-buttons` (8a6d0aa). Held
  on purpose until approving from the lock screen requires unlocking. Operator's call.
- **Launcher shortcuts for recent Bots** (salvage item 15) - not on master. The stale sprint's
  approach: 603cc1b in `archive/sprint-features-functions-ui` (rebuild on master's code).
- **Council: a failed Bot slot is shown, not silently dropped** in the UI (the Gate side already
  times out and reports errors).
- **Codex voice engine on the ChatGPT login** - blocked: Codex CLI 0.147.0 answers
  `thread/realtime/start` with "realtime conversation requires API key auth". The exact call
  sequence and what to build when that changes are in `.sprint-jev/HANDBACK.md` (A2) in the main
  checkout.
- **Gate's own provider path** (Gate setup cards, not the Hermes chat path): OpenCode Go needs the
  `x-opencode-session` header; OpenCode Zen's key is rejected (401, needs sign-in); NVIDIA's card
  shows an old 404 from a chat that named a model it does not carry.
- **Hermes host patches** live as uncommitted edits in `%LOCALAPPDATA%\hermes\hermes-agent` (a Hermes
  update overwrites them): union-alpha routed to `/messages`, a text-only stream drop treated as a
  retryable drop, and the boot integrity-check loop fix (also committed as 8c3933c3e on branch
  `fix/boot-integrity-check-loop` in `hermes-agent-fix-boot-integrity`).

## Archives (reachable, not pending)

| Tag | What it holds |
|---|---|
| `archive/sprint-features-functions-ui` (+ `-origin`, `-build`) | The stale 2026-09-14 sprint. Hand-ported on 09-15; of its 64 unmatched commits 9 are in master verbatim, 5 would apply, 50 have diverged into master's rebuilt versions. Use it only as a reference for the open items above. |
| `archive/gemma-sprint-optimization` | Source of the three fixes on this branch. |
| `archive/approve-deny-notification-buttons` | See open work. |
