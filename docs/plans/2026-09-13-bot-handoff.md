# Bot handoff packets (2026-09-13)

Phase B item 9, `FUTURE-ITEMS.md` D6. Export a Bot as a portable file — soul, routines,
skills, chrome — importable on another host. **Memory and credentials are excluded by
default**; that is the trust line, and the packet says so.

## Slice

The trust line is the deliverable, so it lands first as pure, tested logic:

- `src/lib/gateway/handoff.ts` builds a packet by reading an explicit allow-list of Bot
  fields (never a spread), so a `memory`/`credentials` field on the source cannot ride
  along. `botHandoffFromUnknown` validates format/version/id. `botHandoffSummaryCopy`
  names the Bot and what is excluded.
- The file write/share and the receiving-gateway import check are the next slice; this one
  makes the packet shape and its exclusion rule real.

## Steps

1. Failing Jest `__tests__/handoff-test.ts`: a built packet carries format/version/bot/
   routines/skills/chrome and lists `memory`/`credentials` as excluded; a source Bot
   carrying `memory` and `credentials` does not leak them; a junk packet is rejected;
   the summary names the Bot and the exclusion.
2. Run it; it fails (module missing).
3. Implement `handoff.ts`; run green.
4. `npm run verify` EXIT=0; commit the plan, then the code.

## Acceptance

- **PENDING-DEVICE:** exporting a Bot to a file and importing it on a second host, with
  memory and credentials absent from the file.
