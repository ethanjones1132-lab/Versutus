// The constellation's pure fold (FUTURE-ITEMS.md §D2 Build 2): saved gateways
// positioned on a deterministic outer ring, each classified into one of the
// map's two truth classes — `live` ONLY for the connected gateway, everything
// else `saved`. A saved gateway keeps the reachability record it was handed,
// so the surface can draw it dimmed and dated; it is never made live off a
// mere `reachable` probe. Pure: no fetch, no storage, no renderer.

import {
  constellationNodeClass,
  foldConstellation,
  CONSTELLATION_RING_RADIUS,
} from '@/lib/fleet/constellation-model';
import type { GatewayReachability } from '@/lib/gateway/dashboard';
import type { GatewayProfile } from '@/lib/gateway/types';

function gateway(id: string): GatewayProfile {
  return { id, name: `Gateway ${id}`, url: `http://${id}:8642`, createdAt: 0 };
}

function reachability(gatewayId: string, state: GatewayReachability['state']): GatewayReachability {
  return {
    gatewayId,
    url: `http://${gatewayId}:8642`,
    state,
    checkedAt: 123_000,
  };
}

describe('constellationNodeClass', () => {
  test('the connected active gateway is classed live', () => {
    expect(
      constellationNodeClass({
        gatewayId: 'a',
        activeGatewayId: 'a',
        status: 'connected',
      }),
    ).toBe('live');
  });

  test.each(['connecting', 'reconnecting', 'pairing', 'disconnected'] as const)(
    'the active gateway is NOT live while the connection is %s',
    (status) => {
      // A pair-in-progress name is not a live gateway yet; one truth class at
      // a time keeps the map honest.
      expect(
        constellationNodeClass({ gatewayId: 'a', activeGatewayId: 'a', status }),
      ).toBe('saved');
    },
  );

  test('a reachable probe never makes a gateway live', () => {
    expect(
      constellationNodeClass({
        gatewayId: 'b',
        activeGatewayId: 'a',
        status: 'connected',
      }),
    ).toBe('saved');
  });

  test('ids must match AND the connection must be live', () => {
    // Neither fact alone earns the live class.
    expect(
      constellationNodeClass({
        gatewayId: 'b',
        activeGatewayId: 'b',
        status: 'disconnected',
      }),
    ).toBe('saved');
  });
});

describe('foldConstellation', () => {
  const size = { width: 800, height: 600 };

  test('saved gateways keep the record they were handed, with the dimmed label of it', () => {
    const profiles = [gateway('a'), gateway('b')];
    const model = foldConstellation({
      profiles,
      reachability: { b: reachability('b', 'reachable') },
      activeGatewayId: 'a',
      status: 'connected',
      width: size.width,
      height: size.height,
      now: 200_000,
    });

    const live = model.gateways.find((node) => node.gatewayId === 'a');
    const saved = model.gateways.find((node) => node.gatewayId === 'b');

    // Exactly one live node, and it is the connected gateway.
    expect(live?.truth).toBe('live');
    expect(saved?.truth).toBe('saved');
    // The saved node carries the probe wave's own verdict and stamp, not a
    // state the model invented.
    expect(saved?.reachability?.state).toBe('reachable');
    expect(saved?.reachability?.checkedAt).toBe(123_000);
    // A record that said nothing yet answers an absent record — unknown is
    // the fold's own answer about a gateway no wave has probed.
    expect(
      foldConstellation({
        profiles,
        reachability: {},
        activeGatewayId: 'a',
        status: 'connected',
        width: size.width,
        height: size.height,
        now: 200_000,
      }).gateways.find((node) => node.gatewayId === 'b')?.reachability,
    ).toBeUndefined();
  });

  test('every node sits on ONE deterministic ring, never at the centre', () => {
    const profiles = [gateway('a'), gateway('b'), gateway('c'), gateway('d'), gateway('e')];
    const fold = (list: GatewayProfile[]) =>
      foldConstellation({
        profiles: list,
        reachability: {},
        activeGatewayId: 'a',
        status: 'connected',
        width: size.width,
        height: size.height,
        now: 200_000,
      });

    const first = fold(profiles).gateways;
    const again = fold(profiles).gateways;
    // Deterministic: the same input folds to the same positions twice.
    expect(again).toEqual(first);

    const radius = CONSTELLATION_RING_RADIUS * Math.min(size.width, size.height) / 2;
    for (const node of first) {
      const distance = Math.hypot(node.x * size.width - size.width / 2, node.y * size.height - size.height / 2);
      expect(Math.abs(distance - radius)).toBeLessThan(1);
      // And no node sits AT the pivot: the ring's shape comes from every
      // node being away from the centre it turns on.
      expect(
        Math.hypot(
          node.x * size.width - size.width / 2,
          node.y * size.height - size.height / 2,
        ),
      ).toBeGreaterThan(0);
    }
  });

  test('ring positions fold in roster order and distinct profiles never collide', () => {
    const profiles = [gateway('a'), gateway('b'), gateway('c')];
    const model = foldConstellation({
      profiles,
      reachability: {},
      activeGatewayId: 'a',
      status: 'connected',
      width: size.width,
      height: size.height,
      now: 200_000,
    });

    // Roster order fixes the angles — a gateway added to the roster moves
    // nothing about the ones before it except through the shared count.
    for (let index = 1; index < model.gateways.length; index += 1) {
      const previous = model.gateways[index - 1];
      const current = model.gateways[index];
      expect(current.gatewayId).toBe(profiles[index].id);
      // No two nodes share a position: the ring has N seats for N gateways.
      expect([previous.x, previous.y]).not.toEqual([current.x, current.y]);
    }
  });

  test('an empty fleet folds to an empty, dignified model — no node, no crash', () => {
    const model = foldConstellation({
      profiles: [],
      reachability: {},
      activeGatewayId: null,
      status: 'disconnected',
      width: size.width,
      height: size.height,
      now: 200_000,
    });
    expect(model.gateways).toEqual([]);
    // The ring's own geometry is still the model's, so a surface can draw
    // the empty map's ring without re-deriving it.
    expect(model.ring).toEqual({
      cx: size.width / 2,
      cy: size.height / 2,
      radius: (CONSTELLATION_RING_RADIUS * Math.min(size.width, size.height)) / 2,
    });
  });

  test('degenerate size folds an empty map to a ring that never goes negative or zero', () => {
    // A banner-sized render is still a render.
    const tiny = foldConstellation({
      profiles: [gateway('a')],
      reachability: {},
      activeGatewayId: 'a',
      status: 'connected',
      width: 2,
      height: 2,
      now: 200_000,
    });
    expect(tiny.ring.radius).toBeGreaterThan(0);
    // Zero and negative sizes answer no nodes at all rather than a scatter
    // that cannot be drawn.
    for (const width of [0, -100]) {
      const broken = foldConstellation({
        profiles: [gateway('a')],
        reachability: {},
        activeGatewayId: 'a',
        status: 'connected',
        width,
        height: size.height,
        now: 200_000,
      });
      expect(broken.gateways).toEqual([]);
      expect(broken.ring.radius).toBe(0);
    }
  });
});
