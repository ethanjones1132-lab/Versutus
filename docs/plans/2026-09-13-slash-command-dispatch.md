# Slash-command dispatch — `/run` is refused before it executes (2026-09-13)

Phase B item 1 of `EXEC-BRIEF-remaining-opencode.md`: "Runs are broken — slash commands
not recognized". Diagnose the dispatcher; do not invest in run execution.

## Diagnosis

Slash commands parse and match the registry correctly. They fail at **match-then-execute**:
the capability-snapshot guard runs before the built-in handlers.

- `src/context/gateway-provider.tsx:2559` splits command from message with
  `isSlashCommandInput`; parsing is fine.
- `src/lib/gateway/slash-commands.ts` tokenizes (`:431`), finds the registry entry
  (`findCommandBySlash:602`) and, before any handler, calls
  `blockUnsupportedCommand` (`:502`, defined `:658`).
- The `/run` handler sits *after* that guard (`:517`). The registry entry
  (`src/lib/gateway/dashboard.ts:593`) declares `method: 'runs.create'`, but no Gate
  advertises `runs.create`; runs go over REST (`POST /v1/runs`). So `blockUnsupportedCommand`
  returns "`/run` is not available on this gateway (not dispatched by this gateway)." and the
  working handler never runs.
- The same class was already bypassed for `/env`, `/session current`, `/device` and
  `/model auth` (`slash-commands.ts:489-500`); `/run` was missed.
- Regression origin: `37ff32b` added the guard before the handlers; the runs-over-REST
  moves (`7b3922b` and later) made the declared `runs.create` fiction load-bearing.
- No existing Jest test pinned `/run` against a live capability snapshot.

## Fix (smallest change, the established pattern)

Add `/run` to the pre-snapshot bypass block, and delete the now-unreachable duplicate
handler after the block. This leaves the guidance behavior for genuinely undispatched
registry commands (`/bots`, …) untouched. It does not change run execution.

## Steps

1. Failing test: `__tests__/slash-commands-test.ts` — `/run hello there` with
   `methods: { 'run-task': { available: false, … } }` must reach `runTask` and say
   "Run complete".
2. Run it; it fails with the snapshot block.
3. Implement the bypass in `src/lib/gateway/slash-commands.ts`.
4. Run the slash suites; `npm run verify` EXIT=0.
5. Commit.

## Out of scope (recorded, not fixed here)

Other `transport: 'rpc'` registry entries whose real path is not the advertised RPC may be
pre-empted the same way. That is a broader audit and would change pinned behavior; the
brief asks only for the dispatcher diagnosis and the runs path.
