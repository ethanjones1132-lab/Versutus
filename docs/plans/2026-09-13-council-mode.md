# Council mode — one prompt, several Bots (2026-09-13)

Phase B item 10, `FUTURE-ITEMS.md` D7. Send one prompt to several Bots and compare answers
side by side. Fan-out over the existing per-Bot send path; no full group chats first.

## Slice

The fan-out and its failure isolation are the part that must be right, so they land as
pure, tested logic:

- `src/lib/gateway/council.ts`: `councilTargets` (deduped, trimmed, capped),
  `runCouncil(prompt, targets, send)` fanning out with per-column failure isolation (one Bot
  failing never fails another), and `councilSummaryCopy`.
- The side-by-side view is the next slice; this one makes the comparison data real.

## Steps

1. Failing Jest `__tests__/council-test.ts`: targets dedupe/trim/cap; `runCouncil` keeps
   target order, one rejection is a failed column while the others answer, an empty answer
   is a failure rather than a blank column, and the summary counts the answers.
2. Run it; it fails (module missing).
3. Implement `council.ts`; run green.
4. `npm run verify` EXIT=0; commit the plan, then the code.

## Acceptance

- **PENDING-DEVICE:** one prompt sent to three Bots renders three answers side by side, with
  a failed Bot named in its own column.
