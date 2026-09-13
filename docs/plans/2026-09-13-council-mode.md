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

---

# Slice 2 — the view and the send (2026-09-13)

The fan-out is shipped (`8201217`). This slice draws the columns and wires a send over the
existing surface. The app has no per-Bot "ask and await text" call, so the send reuses the
one that does return text: the Gate group round (`botGroups.send`), which fans out per Bot
server-side. `runCouncil` stays the ordering and failure-isolation layer, fed from that
round's replies.

## Task D7v.1 — the transient-room send (pure copy + wiring)

Files: `src/lib/gateway/council.ts` (additive), `src/app/council.tsx`,
`src/components/chat/council-compare-view.tsx`, `__tests__/council-view-test.ts`.

1. Failing source-pin test: the route selects up to three roster Bots with `councilTargets`,
   creates one transient room for the selected members (`councilRoomName`), sends the prompt
   once, feeds the round's replies through `runCouncil` (a missing Bot is a failed column),
   deletes the room in a `finally`, and renders `CouncilCompareView`; the view draws one
   column per target with `councilSummaryCopy`, names a failed column's error, and adds no
   fetch of its own.
2. Run; fails (files/module additions missing).
3. Implement `councilRoomName` and `councilDisabledCopy` in `council.ts`, the compare view,
   and the route.
4. Run; green. `npm run verify` EXIT=0, commit.

## Task D7v.2 — the entry and the Stack registration

Files: `src/app/_layout.tsx`, `src/components/gateway/gateway-home-dashboard.tsx`,
`__tests__/council-view-test.ts`.

1. Failing source-pin test: the Stack registers `council` as a full-screen destination and
   Home's hero opens `/council`.
2. Run; fails.
3. Register the screen and add the button.
4. Run; green. `npm run verify` EXIT=0, commit.

## Slice 2 acceptance

- **PENDING-DEVICE:** one prompt sent to three Bots renders three answers side by side, with
  a failed Bot named in its own column.
