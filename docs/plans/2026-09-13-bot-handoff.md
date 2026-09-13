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

---

# Slice 2 — receiving-host import (2026-09-13)

Export is shipped (`c0d2ed3`, `ca4ecf51`). This slice is the other half: a packet is read on
the receiving host, validated against that gateway's capability, and only then creates a Bot.

The device cannot pick a file (no document picker is installed, and the Android share filter
is `text/*`, so a shared `.json` never reaches this app). The clipboard is the picker-free
intake this build already ships (`expo-clipboard`), so import reads a pasted packet text — the
same JSON the export writes.

## Task D6i.1 — the receiving-host validation (pure)

Files: `src/lib/gateway/handoff-import.ts`, `__tests__/handoff-import-test.ts`.

1. Failing test: `parseBotHandoffText` accepts a JSON string or an already-parsed value and
   returns the packet, and rejects junk, a wrong format, a wrong version and a missing Bot
   id. `botHandoffImportPlan(packet, { canCreateBots })` refuses a non-packet and a gateway
   that cannot create Bots, each with its own reason, and otherwise returns the Bot core it
   would create plus the packet's own exclusion list. The copy names what is restored and
   what is not.
2. Run; fails (module missing).
3. Implement `handoff-import.ts`.
4. Run; green. `npm run verify` EXIT=0, commit.

## Task D6i.2 — the import screen and its entry

Files: `src/app/gateway/import.tsx`, `src/app/_layout.tsx`,
`src/components/chat/chat-roster.tsx`, `src/components/chat/chat-screen.tsx`,
`__tests__/handoff-import-test.ts`.

1. Failing source-pin test: the screen reads the clipboard (`expo-clipboard`) and a pasted
   field, folds the text through `parseBotHandoffText` + `botHandoffImportPlan`, renders the
   plan's copy, and on Import calls `createBot` with the packet's core and then opens the
   roster; the roster footer gains an Import row wired to the route; the Stack registers the
   route. The screen never imports memory or credentials (they are not on the plan).
2. Run; fails.
3. Implement the screen, register the route, wire the roster row.
4. Run; green. `npm run verify` EXIT=0, commit.

## Slice 2 acceptance

- **PENDING-DEVICE:** a packet pasted on a second host creates a Bot there, and the file it
  came from carried no memory or credentials.
