import { botSheetView } from '@/lib/fleet/bot-sheet';
import {
  CONSTELLATION_HEIGHT,
  CONSTELLATION_WIDTH,
  constellationModel,
  constellationNodeBoxWidth,
  constellationNodeAccessibilityLabel,
  constellationSummaryCopy,
} from '@/lib/fleet/constellation-model';
import type { GatewayCapabilitySnapshot } from '@/lib/gateway/types';
import type { CronJob } from '@/lib/gateway/cron';

function job(overrides: Partial<CronJob> & { id: string }): CronJob {
  return {
    title: overrides.title ?? overrides.id,
    name: overrides.name ?? null,
    botId: overrides.botId ?? null,
    ...overrides,
  };
}

describe('connected gateway capability readiness', () => {
  const base = {
    profiles: [{ id: 'home' }, { id: 'saved' }],
    connectedGatewayId: 'home',
    roster: [{ id: 'scout' }],
  };
  const snapshot: GatewayCapabilitySnapshot = {
    checkedAt: 100, status: 'fresh', methods: {}, scopes: [],
    groups: [
      { id: 'chat', label: 'Chat', status: 'ready' },
      { id: 'memory', label: 'Memory', status: 'available' },
      { id: 'cron', label: 'Routines', status: 'missing-scope' },
      { id: 'imaginary', label: 'Imaginary', status: 'undeclared' },
    ],
  };

  test('counts only declared groups and shares no capability facts with saved gateways or Bots', () => {
    const model = constellationModel({ ...base, capabilitySnapshot: snapshot });
    const live = model.nodes[0];
    expect(live.capabilityDetail).toBe('Capabilities 2/3 ready');
    expect(live.badges).toContainEqual({ label: 'Live', tone: 'success' });
    expect(constellationNodeAccessibilityLabel(live)).toContain('Capabilities 2/3 ready');
    for (const node of model.nodes.slice(1)) expect(node.capabilityDetail).toBeUndefined();
    const disconnected = constellationModel({ ...base, connectedGatewayId: undefined, capabilitySnapshot: snapshot });
    expect(disconnected.nodes.every((node) => node.capabilityDetail === undefined)).toBe(true);
  });

  test.each([
    ['fresh', 'Capabilities 2/3 ready'],
    ['partial', 'Capabilities partial · 2/3 ready'],
    ['stale', 'Capabilities stale · 2/3 last known ready'],
    ['warming', 'Capabilities warming'],
    ['offline', 'Capabilities unreported'],
  ] as const)('%s preserves the snapshot verdict rather than equating live with ready', (status, detail) => {
    expect(constellationModel({ ...base, capabilitySnapshot: { ...snapshot, status } }).nodes[0].capabilityDetail)
      .toBe(detail);
  });

  test.each([{ groups: [] }, { groups: [{ id: 'imaginary', label: 'Imaginary', status: 'undeclared' as const }] }])(
    'no declared groups never claims readiness', ({ groups }) => {
      expect(constellationModel({ ...base, capabilitySnapshot: { ...snapshot, groups } }).nodes[0].capabilityDetail)
        .toBe('Capabilities unreported');
    },
  );

  test('a missing snapshot is unreported, not ready', () => {
    expect(constellationModel(base).nodes[0].capabilityDetail).toBe('Capabilities unreported');
  });

  test('non-ready group verdicts are counted but never promoted to ready', () => {
    const groups = (['unavailable', 'unknown', 'unsupported', 'warming', 'stale', 'partial', 'unhealthy', 'experimental'] as const)
      .map((status) => ({ id: status, label: status, status }));
    expect(constellationModel({ ...base, capabilitySnapshot: { ...snapshot, groups } }).nodes[0].capabilityDetail)
      .toBe('Capabilities 0/8 ready');
  });
});

describe('the fleet constellation model', () => {
  test('an empty fleet is a dignified empty model', () => {
    const model = constellationModel({ profiles: [] });
    expect(model.empty).toBe(true);
    expect(model.nodes).toEqual([]);
    expect(model.edges).toEqual([]);
    expect(model.width).toBe(CONSTELLATION_WIDTH);
    expect(model.height).toBe(CONSTELLATION_HEIGHT);
  });

  test('only the connected gateway is live; a down one is dated, never green', () => {
    const model = constellationModel({
      profiles: [
        { id: 'gw-home', name: 'Home' },
        { id: 'gw-travel', name: 'Travel' },
      ],
      connectedGatewayId: 'gw-home',
      reachability: { 'gw-travel': { lastProbeAt: 1_700_000_000_000 } },
    });

    const home = model.nodes.find((node) => node.id === 'gateway:gw-home');
    const travel = model.nodes.find((node) => node.id === 'gateway:gw-travel');
    expect(home?.live).toBe(true);
    expect(home?.badges).toContainEqual({ label: 'Live', tone: 'success' });
    expect(travel?.live).toBe(false);
    expect(travel?.lastSeenAt).toBe(1_700_000_000_000);
    expect(travel?.badges).toContainEqual({ label: 'Unknown', tone: 'neutral' });
    expect(travel?.badges).not.toContainEqual({ label: 'Live', tone: 'success' });
  });

  test("the connected gateway's Bots cluster beneath it with host edges", () => {
    const model = constellationModel({
      profiles: [{ id: 'gw-home', name: 'Home' }],
      connectedGatewayId: 'gw-home',
      roster: [
        { id: 'scout', displayName: 'Scout' },
        { id: 'night', displayName: 'Night' },
      ],
    });

    const gateway = model.nodes.find((node) => node.kind === 'gateway');
    const bots = model.nodes.filter((node) => node.kind === 'bot');
    expect(gateway).toBeDefined();
    expect(bots).toHaveLength(2);
    expect(bots.every((bot) => bot.y > (gateway?.y ?? 0))).toBe(true);
    expect(model.edges).toEqual([
      { from: 'gateway:gw-home', to: 'bot:gw-home:scout', kind: 'hosts' },
      { from: 'gateway:gw-home', to: 'bot:gw-home:night', kind: 'hosts' },
    ]);
  });

  test('a live run and pending approvals badge the Bot', () => {
    const model = constellationModel({
      profiles: [{ id: 'gw-home', name: 'Home' }],
      connectedGatewayId: 'gw-home',
      roster: [{ id: 'scout', displayName: 'Scout' }],
      activityRuns: [{ id: 'r1', botId: 'scout', status: 'running' }],
      pendingApprovals: [{ botId: 'scout' }, { botId: 'scout' }],
    });

    const bot = model.nodes.find((node) => node.kind === 'bot');
    expect(bot?.badges).toContainEqual({ label: 'Running', tone: 'accent' });
    expect(bot?.badges).toContainEqual({ label: '2 approvals', tone: 'danger', action: 'approval' });
  });

  test('failed runs count as a failure badge, in the scorecard\'s own fold', () => {
    const model = constellationModel({
      profiles: [{ id: 'gw-home', name: 'Home' }],
      connectedGatewayId: 'gw-home',
      roster: [
        { id: 'scout', displayName: 'Scout' },
        { id: 'night', displayName: 'Night' },
      ],
      activityRuns: [
        { id: 'r1', botId: 'scout', status: 'failed' },
        { id: 'r2', botId: 'scout', status: 'failed' },
        { id: 'r3', botId: 'scout', status: 'running' },
      ],
    });

    const scout = model.nodes.find((node) => node.kind === 'bot' && node.botId === 'scout');
    const night = model.nodes.find((node) => node.kind === 'bot' && node.botId === 'night');
    expect(scout?.badges).toContainEqual({ label: '2 failed', tone: 'danger' });
    expect(scout?.badges).toContainEqual({ label: 'Running', tone: 'accent' });
    // No failure is invented; the missing Routine read stays unreported.
    expect(night?.badges).toEqual([{ label: 'routines unreported', tone: 'neutral' }]);
  });

  test('a cancelled or unresolved run is not a failure; a Bot it belongs to shows no failure badge', () => {
    const model = constellationModel({
      profiles: [{ id: 'gw-home', name: 'Home' }],
      connectedGatewayId: 'gw-home',
      roster: [{ id: 'scout', displayName: 'Scout' }],
      activityRuns: [
        { id: 'r1', botId: 'scout', status: 'cancelled' },
        { id: 'r2', botId: 'scout', status: 'unresolved' },
      ],
    });

    const bot = model.nodes.find((node) => node.kind === 'bot');
    expect(bot?.badges.some((badge) => badge.label.includes('failed'))).toBe(false);
  });

  test('a run naming no Bot, or a Bot off the roster, is attributed to nobody', () => {
    const model = constellationModel({
      profiles: [{ id: 'gw-home', name: 'Home' }],
      connectedGatewayId: 'gw-home',
      roster: [{ id: 'scout', displayName: 'Scout' }],
      activityRuns: [
        { id: 'r1', status: 'failed' },
        { id: 'r2', botId: 'ghost', status: 'failed' },
      ],
    });

    const bot = model.nodes.find((node) => node.kind === 'bot');
    expect(bot?.badges.some((badge) => badge.label.includes('failed'))).toBe(false);
  });

  test('positions are finite and deterministic for one input', () => {
    const input = {
      profiles: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' },
      ],
      connectedGatewayId: 'b',
      reachability: { c: { lastProbeAt: 5 } },
      roster: [{ id: 'scout', displayName: 'Scout' }],
    };
    const first = constellationModel(input);
    const second = constellationModel(input);
    expect(first).toEqual(second);
    for (const node of first.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });
});

describe('routine arcs', () => {
  const base = {
    profiles: [{ id: 'gw-home', name: 'Home' }],
    connectedGatewayId: 'gw-home',
    roster: [
      { id: 'scout', displayName: 'Scout' },
      { id: 'night', displayName: 'Night' },
    ],
  };

  test('each named routine is an arc from its gateway to the Bot that owns it', () => {
    const model = constellationModel({
      ...base,
      cronJobs: [
        job({ id: 'j1', name: '[bot:scout] every morning' }),
        job({ id: 'j2', name: '[bot:night] night sweep' }),
      ],
    });

    expect(model.edges).toContainEqual({ from: 'gateway:gw-home', to: 'bot:gw-home:scout', kind: 'routine' });
    expect(model.edges).toContainEqual({ from: 'gateway:gw-home', to: 'bot:gw-home:night', kind: 'routine' });
  });

  test('the twin arcs the same Bot owns share one deduped arc per pairing', () => {
    const model = constellationModel({
      ...base,
      cronJobs: [
        job({ id: 'j1', name: '[bot:scout] first' }),
        job({ id: 'j2', name: '[bot:scout] second' }),
        job({ id: 'j3', name: '[bot:scout] third' }),
      ],
    });

    const routineEdges = model.edges.filter((edge) => edge.kind === 'routine');
    expect(routineEdges).toEqual([
      { from: 'gateway:gw-home', to: 'bot:gw-home:scout', kind: 'routine' },
    ]);
  });

  test('a job whose name attributes no Bot surfaces its verdict on the Gateway node instead of a self-edge', () => {
    const owned = constellationModel({
      ...base,
      routineReadStatus: 'ready',
      cronJobs: [
        job({ id: 'j1', name: 'gateway sweep', botId: 'gateway' }),
        job({ id: 'j2', name: '[bot:]' }),
      ],
    });

    const gateway = owned.nodes.find((node) => node.kind === 'gateway')!;
    expect(gateway.badges).toContainEqual({ label: 'routine unreported', tone: 'neutral' });
    const routineEdges = owned.edges.filter((edge) => edge.kind === 'routine');
    expect(routineEdges).toEqual([]);
  });

  test('a Bot off the roster gets no arc that pretends the roster held it', () => {
    const model = constellationModel({
      ...base,
      cronJobs: [job({ id: 'j1', name: '[bot:ghost] unseen' })],
    });

    expect(model.edges.filter((edge) => edge.kind === 'routine')).toEqual([]);
  });

  test('the arc endpoints are the nodes the layout already drew', () => {
    const model = constellationModel({
      ...base,
      cronJobs: [job({ id: 'j1', name: '[bot:scout] every morning' })],
    });
    const ids = new Set(model.nodes.map((node) => node.id));
    expect(ids.has('gateway:gw-home')).toBe(true);
    expect(ids.has('bot:gw-home:scout')).toBe(true);
  });

  test('the existing gateway and Bot layout is unchanged when no jobs arrive', () => {
    const model = constellationModel({ ...base });
    expect(model.edges).toEqual([
      { from: 'gateway:gw-home', to: 'bot:gw-home:scout', kind: 'hosts' },
      { from: 'gateway:gw-home', to: 'bot:gw-home:night', kind: 'hosts' },
    ]);
  });

  test('an unowned routine surfaces its worst verdict on the Gateway node, not as a self-edge', () => {
    const model = constellationModel({
      ...base,
      routineReadStatus: 'ready',
      cronJobs: [
        job({ id: 'j1', name: 'gateway sweep', lastStatus: 'error', failureStreak: 2 }),
        job({ id: 'j2', name: '[bot:]' }),
      ],
    });

    const gateway = model.nodes.find((node) => node.kind === 'gateway')!;
    expect(gateway.badges).toContainEqual({ label: 'routine failing', tone: 'danger' });
    const routineEdges = model.edges.filter((edge) => edge.kind === 'routine');
    expect(routineEdges).toEqual([]);
  });

  test('multiple unowned routines show the worst verdict on the Gateway node', () => {
    const model = constellationModel({
      ...base,
      routineReadStatus: 'ready',
      cronJobs: [
        job({ id: 'j1', name: 'gateway sweep', lastStatus: 'error', failureStreak: 2 }),
        job({ id: 'j2', name: 'another task', lastStatus: 'warn', failureStreak: 1 }),
        job({ id: 'j3', name: 'paused job', paused: true }),
      ],
    });

    const gateway = model.nodes.find((node) => node.kind === 'gateway')!;
    expect(gateway.badges).toContainEqual({ label: 'routine failing', tone: 'danger' });
    const routineEdges = model.edges.filter((edge) => edge.kind === 'routine');
    expect(routineEdges).toEqual([]);
  });

  test('owned routines still badge their Bot and create arcs', () => {
    const model = constellationModel({
      ...base,
      routineReadStatus: 'ready',
      cronJobs: [
        job({ id: 'j1', name: '[bot:scout] owned task', lastStatus: 'error', failureStreak: 1 }),
        job({ id: 'j2', name: 'unowned task', lastStatus: 'error', failureStreak: 3 }),
      ],
    });

    const scout = model.nodes.find((node) => node.botId === 'scout')!;
    const gateway = model.nodes.find((node) => node.kind === 'gateway')!;
    expect(scout.badges).toContainEqual({ label: 'routine failing', tone: 'danger' });
    expect(gateway.badges).toContainEqual({ label: 'routine failing', tone: 'danger' });
    const routineEdges = model.edges.filter((edge) => edge.kind === 'routine');
    expect(routineEdges).toEqual([
      { from: 'gateway:gw-home', to: 'bot:gw-home:scout', kind: 'routine' },
    ]);
  });

  test('malformed unowned rows are ignored', () => {
    const model = constellationModel({
      ...base,
      routineReadStatus: 'ready',
      cronJobs: [
        { id: '', name: 'no id' },
        { id: 'valid', name: 'gateway task', lastStatus: 'error', failureStreak: 1 },
      ],
    });

    const gateway = model.nodes.find((node) => node.kind === 'gateway')!;
    expect(gateway.badges).toContainEqual({ label: 'routine failing', tone: 'danger' });
  });

  test('an unowned routine is never guessed onto a Bot', () => {
    const model = constellationModel({
      ...base,
      routineReadStatus: 'ready',
      cronJobs: [
        job({ id: 'j1', name: 'gateway task', botId: 'ghost', lastStatus: 'error', failureStreak: 1 }),
        job({ id: 'j2', name: '[bot:] empty attribution' }),
      ],
    });

    const scout = model.nodes.find((node) => node.botId === 'scout')!;
    const night = model.nodes.find((node) => node.botId === 'night')!;
    const gateway = model.nodes.find((node) => node.kind === 'gateway')!;
    expect(scout.badges.some((b) => b.label.includes('routine'))).toBe(false);
    expect(night.badges.some((b) => b.label.includes('routine'))).toBe(false);
    expect(gateway.badges).toContainEqual({ label: 'routine failing', tone: 'danger' });
    const routineEdges = model.edges.filter((edge) => edge.kind === 'routine');
    expect(routineEdges).toEqual([]);
  });
});

describe('a large roster stays readable', () => {
  // On 2026-09-16 a 15-Bot fleet rendered as one unreadable smear: every Bot
  // sat in a single row 41 design units apart while each label drew in a
  // 148-unit box, so all fifteen names overlapped. The map was useless at
  // exactly the size a real fleet has.
  const roster = [
    'default', 'alchemist', 'column', 'orator', 'exile', 'forge', 'herald', 'ledger',
    'memory', 'newbacte', 'oracle', 'pact', 'relay', 'scout', 'versutus-dev',
  ].map((id) => ({ id, displayName: id }));

  const model = constellationModel({
    profiles: [{ id: 'gw-home', name: 'Home' }],
    connectedGatewayId: 'gw-home',
    roster,
  });
  const gateway = model.nodes.find((node) => node.kind === 'gateway')!;
  const bots = model.nodes.filter((node) => node.kind === 'bot');

  test('no two Bot labels on the same row overlap', () => {
    expect(bots).toHaveLength(15);
    for (const bot of bots) {
      expect(bot.labelWidth).toBeGreaterThan(0);
      for (const other of bots) {
        if (other === bot || other.y !== bot.y) continue;
        const gap = Math.abs(other.x - bot.x);
        expect(gap).toBeGreaterThanOrEqual((bot.labelWidth! + other.labelWidth!) / 2);
      }
    }
  });

  test('the roster wraps into rows beneath its gateway instead of compressing one row', () => {
    const rows = new Set(bots.map((bot) => bot.y));
    expect(rows.size).toBeGreaterThan(1);
    expect(bots.every((bot) => bot.y > gateway.y)).toBe(true);
  });

  test('every Bot stays on the sky', () => {
    for (const bot of bots) {
      expect(bot.x - bot.labelWidth! / 2).toBeGreaterThanOrEqual(0);
      expect(bot.x + bot.labelWidth! / 2).toBeLessThanOrEqual(CONSTELLATION_WIDTH);
      expect(bot.y).toBeLessThanOrEqual(CONSTELLATION_HEIGHT);
    }
  });

  test('a small roster keeps its single row', () => {
    const small = constellationModel({
      profiles: [{ id: 'gw-home', name: 'Home' }],
      connectedGatewayId: 'gw-home',
      roster: roster.slice(0, 3),
    });
    const smallBots = small.nodes.filter((node) => node.kind === 'bot');
    expect(new Set(smallBots.map((bot) => bot.y)).size).toBe(1);
  });
});

describe('a node label box on screen', () => {
  test("a Bot's label budget scales with the map it is drawn in", () => {
    // Design space is 640 wide; a 320-wide map halves every budget.
    expect(constellationNodeBoxWidth({ labelWidth: 96 }, 320, 148)).toBe(48);
    expect(constellationNodeBoxWidth({ labelWidth: 96 }, 640, 148)).toBe(96);
  });

  test('a node with no budget keeps the view default', () => {
    expect(constellationNodeBoxWidth({}, 320, 148)).toBe(148);
  });

  test('an unmeasured map never produces a zero or NaN box', () => {
    expect(constellationNodeBoxWidth({ labelWidth: 96 }, 0, 148)).toBe(148);
    expect(constellationNodeBoxWidth({ labelWidth: 96 }, Number.NaN, 148)).toBe(148);
  });
});


describe('Routine read freshness on the Fleet', () => {
  const base = {
    profiles: [{ id: 'home' }, { id: 'travel' }],
    connectedGatewayId: 'home',
    roster: [{ id: 'scout' }, { id: 'night' }],
    cronJobs: [job({ id: 'morning', name: '[bot:scout] morning', lastStatus: 'error', failureStreak: 3 })],
  };

  test('stale facts retain their arcs and verdict but admit staleness in the map, sheet and spoken label', () => {
    const model = constellationModel({ ...base, routineReadStatus: 'stale' });
    const scout = model.nodes.find((node) => node.botId === 'scout')!;
    expect(scout.badges).toContainEqual({ label: 'routine failing · stale', tone: 'danger' });
    expect(botSheetView({ node: scout }).routine).toBe('routine failing · stale');
    expect(constellationNodeAccessibilityLabel(scout)).toContain('routine failing · stale');
    expect(model.edges.filter((edge) => edge.kind === 'routine')).toHaveLength(1);
    expect(model.nodes.find((node) => node.botId === 'night')?.badges)
      .toContainEqual({ label: 'routines stale', tone: 'neutral' });
    expect(constellationSummaryCopy(model.summary)).toContain('routines stale');
    expect(constellationSummaryCopy(model.summary)).not.toContain('all quiet');
    expect(model.nodes.find((node) => node.gatewayId === 'travel')?.badges)
      .toEqual([{ label: 'Unknown', tone: 'neutral' }]);
  });

  test('no freshness fact means unreported, not a successful empty read', () => {
    const model = constellationModel({ ...base, cronJobs: [] });
    const scout = model.nodes.find((node) => node.botId === 'scout')!;
    expect(botSheetView({ node: scout }).routine).toBe('routines unreported');
    expect(constellationNodeAccessibilityLabel(scout)).toContain('routines unreported');
    expect(constellationSummaryCopy(model.summary)).toContain('routines unreported');
  });

  test('a successful empty read removes stale warnings and routine arcs', () => {
    const model = constellationModel({ ...base, cronJobs: [], routineReadStatus: 'ready' });
    expect(model.nodes.find((node) => node.botId === 'scout')?.badges).toEqual([]);
    expect(model.edges.filter((edge) => edge.kind === 'routine')).toEqual([]);
    expect(constellationSummaryCopy(model.summary)).toBe('2 Bots · all quiet');
  });

  test('a disconnected gateway carries neither retained arcs nor freshness claims', () => {
    const model = constellationModel({ ...base, connectedGatewayId: undefined, routineReadStatus: 'stale' });
    expect(model.edges).toEqual([]);
    expect(model.nodes.every((node) => !node.live)).toBe(true);
    expect(constellationSummaryCopy(model.summary)).toBe('2 gateways saved — none connected');
  });
});
