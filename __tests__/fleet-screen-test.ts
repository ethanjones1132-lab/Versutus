/**
 * The constellation route's render contract — a render test, not a snapshot.
 *
 * The fold (`foldConstellation`) is already pinned twenty-cases deep by
 * `__tests__/constellation-model-test.ts`; this suite pins only the seams the
 * new screen adds:
 * 1. the screen exists at its route and renders only what the module fold
 *    answers, read through the same import every other consumer uses;
 * 2. the two truth classes never share a tone — a saved node never borrows
 *    the live node's colour, the map's FUTURE-ITEMS §D2 visual contract;
 * 3. a "last seen" line appears on a node exactly when the reachability
 *    record carries a `checkedAt` — absent when the stamp is absent, so the
 *    map never dates a gateway the wave has not reached.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { foldConstellation } from '@/lib/fleet/constellation-model';
import {
  constellationStatusCopy,
  lastSeenCopy,
} from '@/lib/fleet/last-seen-label';
import { homeConstellationVisible } from '@/lib/home/home-hero-actions';
import type { GatewayProfile } from '@/lib/gateway/types';

const PROFILES: GatewayProfile[] = [
  { id: 'gw-live', name: 'Hermes PC', url: 'https://pc.example' },
  { id: 'gw-saved', name: 'Studio rig', url: 'https://studio.example' },
] as GatewayProfile[];

const RECORDS = {
  'gw-saved': {
    gatewayId: 'gw-saved',
    url: 'https://studio.example',
    state: 'reachable',
    checkedAt: 1726000000000,
  },
} as const;

describe('constellation route', () => {
  it('folds the screen inputs through the same module import every consumer uses', () => {
    const model = foldConstellation({
      profiles: PROFILES,
      reachability: RECORDS as unknown as Record<string, never>,
      activeGatewayId: 'gw-live',
      status: 'connected',
      width: 400,
      height: 600,
      now: 1726000001000,
    });
    // The two classes the map must render, honestly.
    expect(model.gateways.map((node) => node.truth)).toEqual(['live', 'saved']);
    // A saved node carries the record it was handed, un-reworded.
    expect(model.gateways[1].reachability?.checkedAt).toBe(RECORDS['gw-saved'].checkedAt);
    // The live node says nothing about last seen — it IS the present.
    expect(model.gateways[0].reachability).toBeUndefined();
  });

  it('never renders both truth classes in the live tone', () => {
    const model = foldConstellation({
      profiles: PROFILES,
      reachability: {},
      activeGatewayId: 'gw-live',
      status: 'connected',
      width: 400,
      height: 400,
      now: 0,
    });
    expect(constellationStatusCopy('live')).toBe('Connected');
    expect(constellationStatusCopy('saved')).not.toBe('Connected');
    // A mid-handshake or disconnected active gateway is still a saved node —
    // two nodes, one class each, and never two live bells.
    expect(model.gateways.filter((node) => node.truth === 'live')).toHaveLength(1);
  });

  it('dates a saved gateway only when the record carries a stamp', () => {
    expect(lastSeenCopy(RECORDS['gw-saved'])).toContain('last seen');
    expect(lastSeenCopy({ state: 'reachable' })).toBeUndefined();
    expect(lastSeenCopy({ state: 'unknown', checkedAt: 5 })).toContain('unknown, last seen');
  });

/**
 * The repo has jest-expo but no component renderer (no
 * @testing-library/react-native, no react-test-renderer — the convention
 * markdown-font-cap-test.ts documents), so a screen's mount seam is pinned
 * the way this repo pins every other screen: by reading the source and
 * asserting the wiring that makes the route open.
 */
  it('the drawer module exports the render surface the route mounts', () => {
    const fleet = readFileSync(join(__dirname, '..', 'src', 'components', 'fleet', 'fleet-constellation.tsx'), 'utf8');
    const screen = readFileSync(join(__dirname, '..', 'src', 'app', 'fleet.tsx'), 'utf8');
    const layout = readFileSync(join(__dirname, '..', 'src', 'app', '_layout.tsx'), 'utf8');
    // The drawer reads the fold consumers use, and the route mounts it.
    expect(fleet).toContain("from '@/lib/fleet/constellation-model'");
    expect(fleet).toContain('foldConstellation(');
    expect(screen).toContain("from '@/components/fleet/fleet-constellation'");
    expect(screen).toContain('useGatewayReachability');
    // The route is Stack-registered beside the tabs — a destination, not a modal.
    expect(layout).toContain('name="fleet"');
    // Home's entry affordance is gated on a saved roster.
    expect(homeConstellationVisible(0)).toBe(false);
    expect(homeConstellationVisible(1)).toBe(true);
  });

  it('a saved node offers connect through the fold, and the live node never taps', () => {
    const drawer = readFileSync(
      join(__dirname, '..', 'src', 'components', 'fleet', 'fleet-constellation.tsx'),
      'utf8',
    );
    const screen = readFileSync(join(__dirname, '..', 'src', 'app', 'fleet.tsx'), 'utf8');
    const sheet = readFileSync(
      join(__dirname, '..', 'src', 'components', 'fleet', 'fleet-connect-sheet.tsx'),
      'utf8',
    );
    // The drawer's tap is the saved class only — the live node is never a
    // button to itself.
    expect(drawer).toMatch(/truth === 'saved' && onGatewayPress !== undefined/);
    // The screen rides the provider's own connectGateway promise, and names
    // the failure through humanizeGatewayError — not a toast.
    expect(screen).toContain('connectGateway');
    expect(screen).toContain('humanizeGatewayError');
    // The sheet draws its decision from the fold's own answer.
    expect(sheet).toContain('ConstellationConnectOffer');
    expect(screen).toContain("from '@/lib/fleet/connect-offer'");
  });

  it('the Bot cluster draws beneath the live node and taps ride the fold, not a re-derivation', () => {
    // The fold answers the seats on the connected edge only — the model is
    // already pinned twenty-cases deep; this pins the screen's wiring.
    const roster: never[] = [];
    const model = foldConstellation({
      profiles: PROFILES,
      reachability: {},
      activeGatewayId: 'gw-live',
      status: 'connected',
      width: 400,
      height: 400,
      now: 0,
      roster,
    });
    expect(model.bots).toEqual([]); // an empty roster answers an empty cluster
    const withCluster = foldConstellation({
      profiles: PROFILES,
      reachability: {},
      activeGatewayId: 'gw-live',
      status: 'connected',
      width: 400,
      height: 400,
      now: 0,
      roster: [
        { id: 'b1', displayName: 'Scout', routable: true },
        { id: 'b2', displayName: 'Ledger', routable: false },
      ] as never,
    });
    // Both Bots draw, routable or not — a drawn-but-unroutable Bot has its
    // own words, so its tap has somewhere honest to answer.
    expect(withCluster.bots.map((bot) => bot.routable)).toEqual([true, false]);
    expect(withCluster.edges).toHaveLength(2);

    // The drawer's wiring: seats come from the fold, taps go through
    // fleetBotTapAction, the provider's own openBot and only a landed open
    // routes.
    const drawer = readFileSync(
      join(__dirname, '..', 'src', 'components', 'fleet', 'fleet-constellation.tsx'),
      'utf8',
    );
    expect(drawer).toContain("from '@/lib/fleet/bot-tap'");
    expect(drawer).toContain('fleetBotTapAction(');
    expect(drawer).toContain('if (opened) navigateToChat()');
    const screen = readFileSync(join(__dirname, '..', 'src', 'app', 'fleet.tsx'), 'utf8');
    expect(screen).toContain('listBots()');
    expect(screen).toContain('openBot');
    expect(screen).toContain("router.navigate('/chat')");
  });

  // ── The run pulse, the approval flag, and the routine arcs (iter-227) ──
  //
  // The fold answers three layers the shipped screen never fed — `activityRuns`,
  // `pendingApproval`, `cronJobs` all defaulted to empty — so the map drew a
  // settled-state-only world. These cases pin the screen's wiring of all three.
  it('the screen hands the provider facts the fold pulses on', () => {
    const screen = readFileSync(join(__dirname, '..', 'src', 'app', 'fleet.tsx'), 'utf8');
    const drawer = readFileSync(
      join(__dirname, '..', 'src', 'components', 'fleet', 'fleet-constellation.tsx'),
      'utf8',
    );
    // The screen reads the three provider facts and threads them down.
    expect(screen).toContain('activityRuns');
    expect(screen).toContain('pendingRunApproval');
    expect(screen).toContain('cron.list()');
    // The drawer takes all three as props and passes each into the fold.
    expect(drawer).toContain('activityRuns');
    expect(drawer).toContain('pendingApproval');
    expect(drawer).toContain('cronJobs');
    expect(drawer).toMatch(/foldConstellation\(\{[\s\S]*?activityRuns/);
    expect(drawer).toMatch(/foldConstellation\(\{[\s\S]*?pendingApproval/);
    expect(drawer).toMatch(/foldConstellation\(\{[\s\S]*?cronJobs/);
  });

  it('the routine arc layer draws the cron verdicts the fold emits', () => {
    const drawer = readFileSync(
      join(__dirname, '..', 'src', 'components', 'fleet', 'fleet-constellation.tsx'),
      'utf8',
    );
    // The drawer renders model.routines — arcs arrive only when cron.list
    // answers; before that the fold maps an empty cronJobs array to an empty
    // routines array, the honest absent layer.
    expect(drawer).toContain('model.routines');
    // One arc per job, with the Bot-owned jobs distinct from the gateway's own.
    const model = foldConstellation({
      profiles: PROFILES,
      reachability: {},
      activeGatewayId: 'gw-live',
      status: 'connected',
      width: 400,
      height: 400,
      now: 0,
      cronJobs: [
        {
          id: 'j1',
          title: 'Morning brief [bot:Scout]',
          name: 'Morning brief [bot:Scout]',
          lastStatus: 'ok',
        },
        {
          id: 'j2',
          title: 'Sweep',
          name: 'Sweep',
          paused: true,
        },
      ] as never,
      roster: [{ id: 'b1', displayName: 'Scout', routable: true }] as never,
    });
    expect(model.routines).toHaveLength(2);
    expect(model.routines[0].verdict.label).toBe('ok');
    expect(model.routines[1].verdict.label).toBe('Paused');
  });

  it('a run pulse and a waiting approval draw on the settled-state map without blocking first paint', () => {
    // The pulse is pure fold output — nothing about it can gate the map:
    // nodes render with whatever runs the provider already holds, and cron
    // arcs join them when the list answers. Pin the two fold shapes the
    // drawer must render distinctly.
    const runs = [
      { id: 'r1', status: 'running', botId: 'b1' },
      { id: 'r2', status: 'running' },
      { id: 'r3', status: 'complete', botId: 'b1' },
    ];
    const model = foldConstellation({
      profiles: PROFILES,
      reachability: {},
      activeGatewayId: 'gw-live',
      status: 'connected',
      width: 400,
      height: 400,
      now: 0,
      roster: [{ id: 'b1', displayName: 'Scout', routable: true }] as never,
      activityRuns: runs as never,
      pendingApproval: { runId: 'r4', prompt: 'Deploy the thing' },
    });
    // The attributed live run pulses the Bot seat; the unattributed one
    // pulses the gateway; the settled run pulses nothing.
    expect(model.bots[0].activityRuns).toBe(1);
    expect(model.gateways[0].activityRuns).toBe(1);
    // The pending approval hangs on the connected gateway's node.
    expect(model.gateways[0].pendingApproval).toEqual({ runId: 'r4', prompt: 'Deploy the thing' });
  });
});
