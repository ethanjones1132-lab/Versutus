# Fleet constellation — the pure model (2026-09-13)

Phase B item 11, `FUTURE-ITEMS.md` D2. A live map of the fleet: gateways, their Bots, live
runs, pending approvals. The honesty constraint shapes it — Versutus holds ONE live gateway
connection, so only that gateway is rendered live; saved-but-down gateways are dimmed and
dated, never green.

## Slice

The model that the Skia layer draws is the part that must be right and can be exhaustive, so
it lands first and pure:

- `src/lib/fleet/constellation-model.ts`: a pure function from
  `{ profiles, connectedGatewayId, reachability, roster, cronJobs, activityRuns,
  pendingApprovals }` to positioned nodes/edges plus badges. Gateway nodes on an outer ring,
  the connected gateway's Bots clustered beneath it with host edges, a running badge for a
  Bot with a live run, an approvals badge, and a "last seen" badge for a down gateway. An
  empty fleet still returns a dignified empty model.
- The Skia render, the web fallback and the tap interactions are the next slice; this one
  makes the graph and its truth classes real.

## Steps

1. Failing Jest `__tests__/constellation-model-test.ts`: an empty fleet is `empty` with no
   nodes; one connected + one down gateway renders one live and one dimmed-with-last-seen;
   the connected gateway's Bots cluster beneath it with host edges; a Bot with a running run
   and a pending approval carries the badges; positions are finite and deterministic.
2. Run it; it fails (module missing).
3. Implement `constellation-model.ts`; run green.
4. `npm run verify` EXIT=0; commit the plan, then the code.

## Acceptance

- **PENDING-DEVICE:** two saved profiles, one connected and one down, render the down one
  dimmed and dated, never green.
