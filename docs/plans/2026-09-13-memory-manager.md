# P2 — Memory manager per Bot

Operator continuation 2026-09-13 08:01 item 2: a **real** memory read, then the
app pane, one slice at a time.

Recon (this host, `HERMES_HOME=C:\Users\ethan\AppData\Local\hermes`): a Hermes
profile keeps its memory as `memories/MEMORY.md` and `memories/USER.md` — the
default profile at the home root, a named Bot at
`profiles/<name>/memories/…`. The Gate already reads a Bot's `SOUL.md` on
demand (`readHermesSoul`, `hermes-profiles.mjs:221`); memory is the same shape
of read, and the `/memory` registry entry currently resolves only to
`doctor.memory.status` guidance.

## Slices

### Slice 1 — Gate: a real memory read (node tests)

Files in play:
- `gate/core/cli-environments/hermes-profiles.mjs` — `readHermesMemory(home, id)`
  reads **only** the whitelisted `HERMES_MEMORY_FILES` (`MEMORY.md`, `USER.md`)
  from `<profile>/memories/`. A blank or missing pair is `null` (the same
  distinction the soul read makes); a non-whitelisted file is never read.
- `gate/core/cli-environments/backends/hermes.mjs` — `getBotMemory({ id })`
  resolves the profile home and returns `{ id, files: [{ name, text }] }`.
- `gate/core/server.mjs` — `GET /v1/bots/{id}/memory`, mirroring the
  `/v1/bots/{id}` read (unknown Bot → 404, backend error → 502).
- `gate/__tests__/hermes-memory.test.mjs` (new) — red first:
  1. reads both files from a profile's `memories/`.
  2. a missing/blank pair is null.
  3. a non-whitelisted file is never returned.

### Slice 2 — App: the read-first Memory pane (pure + surface)

Files in play:
- `src/lib/gateway/bot-memory.ts` (new) — `botMemoryFromUnknown` parses the
  files, `memoryFileSearch` matches a query across files (empty query returns
  everything), and `botMemoryCopy` names the state honestly.
- `src/lib/gateway/rpc-routes.ts` — `memory.read` → `GET
  /v1/bots/{botId}/memory`; `dashboard.ts`'s Memory entry points at it so
  `/memory` reads real data (guidance kept as the fallback).
- `src/components/chat/bot-memory-pane.tsx` (new) — read-first: a search field
  and each whitelisted file's raw text, with a "Memory lives on this PC" note.
  Edits are out of this slice (behind confirmation is the next slice).
- `src/components/chat/bot-detail-sheet.tsx` — mount the pane beside Routines.
- `__tests__/bot-memory-test.ts` (new) — parse, search, and a source pin.

## Verification

`npm run verify` (`FINISHED verify EXIT=0`) before every commit; single gate
test with `cd gate; node --test "__tests__/hermes-memory.test.mjs"`.

## Honest limits

The read is file-based on the Gate host (the only memory substrate Hermes
exposes); the pane is read-only in this slice. Writes behind a confirmation
are a follow-up, and the app never edits `state.db`.
