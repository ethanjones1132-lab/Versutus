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
import type { PublicBot } from '@/lib/gateway/bots';
import type { GatewayProfile } from '@/lib/gateway/types';
import type { ActivityRun } from '@/lib/gateway/runs';
import type { CronJob } from '@/lib/gateway/cron';

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

describe('foldConstellation — Bots clustered beneath their gateway', () => {
  const size = { width: 800, height: 600 };

  function bot(id: string, displayName = `Bot ${id}`, routable = true): PublicBot {
    return { id, displayName, routable };
  }

  function fold(roster: PublicBot[], overrides: Partial<Parameters<typeof foldConstellation>[0]> = {}) {
    return foldConstellation({
      profiles: [gateway('a'), gateway('b')],
      reachability: {},
      activeGatewayId: 'a',
      status: 'connected',
      width: size.width,
      height: size.height,
      now: 200_000,
      roster,
      ...overrides,
    });
  }

  test('the live gateway gains Bot nodes clustered beneath it, one edge each', () => {
    const model = fold([bot('b1'), bot('b2'), bot('b3')]);

    expect(model.bots.map((node) => node.botId)).toEqual(['b1', 'b2', 'b3']);
    expect(model.bots.map((node) => node.botName)).toEqual(['Bot b1', 'Bot b2', 'Bot b3']);
    // Every Bot belongs to the live gateway and carries its own edge back to
    // it — the renderer draws the cluster from the model, not re-derived.
    for (const node of model.bots) {
      expect(node.gatewayId).toBe('a');
      expect(node.routable).toBe(true);
    }
    expect(model.edges).toEqual(
      model.bots.map((node) => ({ kind: 'gateway-bot', gatewayId: 'a', botId: node.botId })),
    );
    // The live node's own position is untouched by the cluster folding.
    const live = model.gateways.find((node) => node.gatewayId === 'a');
    expect(model.bots).not.toContainEqual(live);
  });

  test('the cluster sits BENEATH the gateway node, deterministically, and never collides', () => {
    const once = fold([bot('b1'), bot('b2'), bot('b3'), bot('b4')]);
    const again = fold([bot('b1'), bot('b2'), bot('b3'), bot('b4')]);
    expect(again.bots).toEqual(once.bots);

    const live = once.gateways.find((node) => node.gatewayId === 'a')!;
    // All of them below the gateway node's own seat, spread on a small arc
    // around straight-down — a cluster, not a scatter.
    for (const node of once.bots) {
      expect(node.y).toBeGreaterThan(live.y);
      expect(Math.abs((node.x - live.x) * size.width)).toBeLessThanOrEqual(
        (0.3 / 2) * size.width,
      );
    }
    // No two Bots share a seat.
    for (let i = 1; i < once.bots.length; i += 1) {
      expect([once.bots[i - 1].x, once.bots[i - 1].y]).not.toEqual([once.bots[i].x, once.bots[i].y]);
    }
  });

  test('a Bot with routable: false is still drawn, but flagged', () => {
    const model = fold([bot('b1', 'Bot b1', false), bot('b2')]);
    const flagged = model.bots.find((node) => node.botId === 'b1');
    expect(flagged?.routable).toBe(false);
    expect(model.bots.find((node) => node.botId === 'b2')?.routable).toBe(true);
  });

  test('the one gateway the roster belongs to is the one whose node gains the Bots', () => {
    // The roster arg IS the connected gateway's own `listBots` answer, so the
    // cluster hangs under whichever gateway is live — 'b' here — and never
    // under a saved node. A saved node's (unknown) roster is never guessed.
    const model = fold([bot('b1')], { activeGatewayId: 'b', status: 'connected' });
    expect(model.bots.map((node) => node.botId)).toEqual(['b1']);
    expect(model.bots[0].gatewayId).toBe('b');
    expect(model.edges).toEqual([{ kind: 'gateway-bot', gatewayId: 'b', botId: 'b1' }]);
    // A saved node (gateway 'a') gains no Bot nodes.
    expect(model.bots.some((node) => node.gatewayId === 'a')).toBe(false);

    // No live gateway at all — nowhere to hang the cluster, nothing drawn.
    const noLive = fold([bot('b1')], { activeGatewayId: null, status: 'disconnected' });
    expect(noLive.bots).toEqual([]);
    expect(noLive.edges).toEqual([]);
  });

  test('an empty roster leaves the gateway node alone and dignified', () => {
    const model = fold([]);
    expect(model.bots).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.gateways).toHaveLength(2);
  });

  test('a roster handed in with no live gateway to hang it on draws nothing', () => {
    const model = fold([bot('b1')], { activeGatewayId: null, status: 'disconnected' });
    expect(model.bots).toEqual([]);
    expect(model.edges).toEqual([]);
  });
});

describe('foldConstellation — runs, approvals, and routine arcs', () => {
  const size = { width: 800, height: 600 };

  function botNodeBot(id: string): PublicBot {
    return { id, displayName: `Bot ${id}`, routable: true };
  }

  function run(id: string, botId: string | undefined, status: ActivityRun['status']): ActivityRun {
    return { id, prompt: `run ${id}`, status, startedAt: 0, events: [], botId };
  }

  function job(name: string, over: Partial<CronJob> = {}): CronJob {
    return { id: name, name, ...over } as CronJob;
  }

  function fold(overrides: Partial<Parameters<typeof foldConstellation>[0]> = {}) {
    return foldConstellation({
      profiles: [gateway('a'), gateway('b')],
      reachability: {},
      activeGatewayId: 'a',
      status: 'connected',
      width: size.width,
      height: size.height,
      now: 200_000,
      ...overrides,
    });
  }

  test('a running run pulses the Bot its botId names; unattributed runs pulse the gateway', () => {
    const model = fold({
      activityRuns: [run('r1', 'b1', 'running'), run('r2', undefined, 'running')],
      roster: [botNodeBot('b1')],
    });

    const b1 = model.bots.find((node) => node.botId === 'b1')!;
    const gatewayA = model.gateways.find((node) => node.gatewayId === 'a')!;
    expect(b1.activityRuns).toBe(1);
    // Unattributed runs are never guessed into a Bot: the gateway node takes
    // the pulse (the scorecardBotId rule — botId runs through huntBotId back
    // to null).
    expect(gatewayA.activityRuns).toBe(1);
    // A saved gateway is nobody's run target.
    expect(model.gateways.find((node) => node.gatewayId === 'b')?.activityRuns).toBeUndefined();
  });

  test('only unsettled runs pulse: complete, failed, cancelled, unresolved stay quiet', () => {
    const model = fold({
      activityRuns: [
        run('r1', 'b1', 'complete'),
        run('r2', 'b1', 'failed'),
        run('r3', 'b1', 'cancelled'),
        run('r4', 'b1', 'unresolved'),
        run('r5', 'b1', 'running'),
        run('r6', 'b1', 'waiting-approval'),
      ],
      roster: [botNodeBot('b1')],
    });
    const b1 = model.bots.find((node) => node.botId === 'b1')!;
    // Exactly the two live statuses count, one each.
    expect(b1.activityRuns).toBe(2);
    expect(b1.awaitingApproval).toBe(1);
  });

  test('a waiting-approval run hangs the badge on the gateway, not a bot', () => {
    const model = fold({
      activityRuns: [run('r1', 'b1', 'waiting-approval')],
      roster: [botNodeBot('b1')],
      pendingApproval: { runId: 'r1', prompt: 'ok?' },
    });
    const gatewayA = model.gateways.find((node) => node.gatewayId === 'a')!;
    // One badge, on the connected gateway — the one the approval prompt
    // belongs to — and never on a Bot node.
    expect(gatewayA.pendingApproval).toEqual({ runId: 'r1', prompt: 'ok?' });
    expect(model.bots.some((node) => 'pendingApproval' in node)).toBe(false);
  });

  test('no pending approval leaves every node badge-free', () => {
    const model = fold({ roster: [botNodeBot('b1')] });
    for (const node of model.gateways) expect(node.pendingApproval).toBeUndefined();
  });

  test('each cron job emits an arc to the Bot its name attributes, verdict un-reworded', () => {
    const model = fold({
      roster: [botNodeBot('b1'), botNodeBot('b2')],
      cronJobs: [
        job('[bot:b1] Morning sweep'),
        job('[bot:b1] Evening sweep', { failureStreak: 2, lastError: 'boom' }),
        job('Unattributed chore'),
      ],
    });

    const arcs = model.routines;
    expect(arcs).toHaveLength(3);
    // Attribution comes from parseRoutineName, the same fold the scorecard runs.
    expect(arcs.filter((arc) => arc.botId === 'b1')).toHaveLength(2);
    // The verdict is describeCronHealth's own answer, never reworded.
    expect(arcs.map((arc) => arc.verdict)).toEqual([
      { tone: 'unknown', label: 'Not run yet' },
      { tone: 'error', label: 'Failing — 2 in a row', detail: 'boom' },
      { tone: 'unknown', label: 'Not run yet' },
    ]);
    // The arc targets the clustered Bot node, at the live gateway.
    for (const arc of arcs.filter((a) => a.botId === 'b1')) {
      expect(arc.gatewayId).toBe('a');
      expect(model.bots.some((b) => b.botId === 'b1')).toBe(true);
    }
  });

  test('unattributed arcs target nobody, and no live gateway draws no arcs at all', () => {
    const unattributed = fold({
      cronJobs: [job('Oddly named')],
      roster: [botNodeBot('b1')],
    });
    // The job still emits — the routine exists — but names no Bot.
    expect(unattributed.routines).toHaveLength(1);
    expect(unattributed.routines[0].botId).toBeUndefined();
    expect(unattributed.routines[0].gatewayId).toBe('a');

    const noLive = fold({
      cronJobs: [job('[bot:b1] Morning sweep')],
      activeGatewayId: null,
      status: 'disconnected',
    });
    expect(noLive.routines).toEqual([]);
  });

  test('a settled run that pulses nothing, and a fold with no overlays at all', () => {
    // Settled runs answer no pulses and no badges anywhere.
    const settled = fold({
      activityRuns: [run('r1', 'b1', 'complete'), run('r2', undefined, 'failed')],
      roster: [botNodeBot('b1')],
      cronJobs: [],
    });
    for (const node of settled.bots) {
      expect(node.activityRuns).toBeUndefined();
      expect(node.awaitingApproval).toBeUndefined();
    }
    for (const node of settled.gateways) {
      expect(node.activityRuns).toBeUndefined();
    }
    // Nothing handed in — the prior 18 cases' shape is byte-identical.
    const bare = fold({ roster: [botNodeBot('b1')] });
    expect(bare.routines).toEqual([]);
  });
});
