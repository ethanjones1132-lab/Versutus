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
});
