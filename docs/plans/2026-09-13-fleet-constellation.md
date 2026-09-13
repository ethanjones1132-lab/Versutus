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

---

# Slice 2 — the render (2026-09-13)

The model is shipped (`cb638a9`). This slice draws it and makes it tappable, without
adding protocol or a poll: the screen is a projection of provider state plus the existing
`listBots` roster read, and the reachability wave it already mounts.

## Task D2r.1 — geometry and honesty copy (pure)

Files: `src/lib/fleet/constellation-model.ts` (additive), `__tests__/constellation-layout-test.ts`.

1. Failing test: `constellationLayout(model, size)` scales every node into `[0, size]`,
   resolves each `hosts` edge to finite coordinates between its two nodes, is deterministic
   for one input, and returns an empty layout for the empty model. `relativeLastSeenCopy(at,
   now)` is `just now` under a minute, then `5m ago`, `3h ago`, `2d ago`, `30d ago`, and
   never negative. `constellationNodeAccessibilityLabel(node)` names a live gateway `live`
   and a saved one `offline` or `last seen`, and appends badges — a down gateway is never
   labelled `live`.
2. Run `npx jest __tests__/constellation-layout-test.ts`; fails (helpers missing).
3. Implement the three helpers in `constellation-model.ts`.
4. Run; green. `npm run verify` EXIT=0, commit.

## Task D2r.2 — the fleet projection (pure)

Files: `src/lib/fleet/constellation-input.ts`, `__tests__/constellation-input-test.ts`.

1. Failing test: `fleetConstellationInput({ gateways, connectedGatewayId, reachability,
   roster, activityRuns, pendingRunApproval })` maps profiles through, turns a reachability
   sample's `checkedAt` into `lastProbeAt`, keeps only finite stamps, attributes a pending
   run approval to the Bot the matching `activityRuns` row names (unattributed when the row
   is gone), and feeds `constellationModel` so one connected gateway is `live` while a saved
   one is dimmed and dated.
2. Run; fails (module missing).
3. Implement the adapter.
4. Run; green. `npm run verify` EXIT=0, commit.

## Task D2r.3 — the painters and the view

Files: `src/components/fleet/constellation-canvas-fallback.tsx`,
`constellation-canvas.native.tsx`, `constellation-canvas.web.tsx`,
`constellation-canvas.tsx`, `constellation-view.tsx`,
`__tests__/constellation-render-test.ts`.

1. Failing source-pin test, in the `spend-chart-bars-test.ts` style: the native canvas paints
   the layout in a Skia `Canvas` behind a mount boundary that falls back to the plain canvas;
   the web and default resolutions re-export the plain canvas and no path that runs on web
   imports Skia; both painters consume `constellationLayout(` and neither re-derives the
   graph; the view renders the model's badges, exposes `constellationNodeAccessibilityLabel`
   to each node, calls `onPressNode`, and shows the dignified empty copy for an empty model.
2. Run; fails (files missing).
3. Implement the painters and `constellation-view.tsx`.
4. Run; green. `npm run verify` EXIT=0, commit.

## Task D2r.4 — the route and the entry

Files: `src/app/fleet.tsx`, `src/app/_layout.tsx`, `src/components/gateway/gateway-home-dashboard.tsx`,
`__tests__/fleet-route-test.ts`.

1. Failing source-pin test: `/fleet` reads `gateways`, `activeGateway`, `status`,
   `activityRuns`, `pendingRunApproval`, the reachability wave and the existing `listBots`
   read, folds them through `fleetConstellationInput` + `constellationModel`, and renders
   `ConstellationView`; a Bot tap opens the Bot Chat (`openBot` + `requestSurface` + `/chat`),
   a gateway tap connects it, an approval badge opens `/activity`; the Stack registers
   `fleet` as a full-screen destination; Home's hero carries the entry button; and the route
   adds no `gatewayRequest(` call of its own.
2. Run; fails (files missing).
3. Implement the route, register the Stack screen, add the Home button.
4. Run; green. `npm run verify` EXIT=0, commit.

## Slice 2 acceptance

- **PENDING-DEVICE:** two saved profiles, one connected and one down — the down gateway is
  dimmed and dated, never green; tapping its dot starts a connect; tapping a Bot opens its
  Bot Chat; tapping an approval badge opens Activity.
