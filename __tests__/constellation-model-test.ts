import {
  CONSTELLATION_HEIGHT,
  CONSTELLATION_WIDTH,
  constellationModel,
} from '@/lib/fleet/constellation-model';

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
    expect(travel?.badges).toContainEqual({ label: 'Last seen', tone: 'neutral' });
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
    expect(bot?.badges).toContainEqual({ label: '2 approvals', tone: 'danger' });
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
