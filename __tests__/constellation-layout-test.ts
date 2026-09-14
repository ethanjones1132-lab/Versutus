import {
  CONSTELLATION_WIDTH,
  constellationLayout,
  constellationModel,
  constellationNodeAccessibilityLabel,
  relativeLastSeenCopy,
} from '@/lib/fleet/constellation-model';

const FLEET = {
  profiles: [
    { id: 'gw-home', name: 'Home' },
    { id: 'gw-travel', name: 'Travel' },
  ],
  connectedGatewayId: 'gw-home',
  reachability: { 'gw-travel': { lastProbeAt: 1_700_000_000_000 } },
  roster: [
    { id: 'scout', displayName: 'Scout' },
    { id: 'night', displayName: 'Night' },
  ],
  activityRuns: [{ id: 'r1', botId: 'scout', status: 'running' }],
  pendingApprovals: [{ botId: 'scout' }, { botId: 'scout' }],
};

describe('constellationLayout places the graph the model emitted', () => {
  test('every node lands inside the square it was scaled to', () => {
    const layout = constellationLayout(constellationModel(FLEET), 320);
    expect(layout.size).toBe(320);
    expect(layout.empty).toBe(false);
    expect(layout.nodes).toHaveLength(4);
    for (const node of layout.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(320);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(320);
    }
  });

  test('scaling preserves the model shape: a larger square moves nodes proportionally', () => {
    const model = constellationModel(FLEET);
    const small = constellationLayout(model, 160);
    const large = constellationLayout(model, 320);
    for (const [index, node] of small.nodes.entries()) {
      expect(large.nodes[index].x).toBeCloseTo(node.x * 2, 6);
      expect(large.nodes[index].y).toBeCloseTo(node.y * 2, 6);
    }
    // The model is square, so one scale factor covers both axes.
    expect(constellationLayout(model, CONSTELLATION_WIDTH / 2).nodes[0].x).toBeCloseTo(
      model.nodes[0].x / 2,
      6,
    );
  });

  test('each hosts edge resolves to finite coordinates between its two nodes', () => {
    const layout = constellationLayout(constellationModel(FLEET), 300);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    expect(layout.edges).toHaveLength(2);
    for (const edge of layout.edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      expect(edge.x1).toBe(from?.x);
      expect(edge.y1).toBe(from?.y);
      expect(edge.x2).toBe(to?.x);
      expect(edge.y2).toBe(to?.y);
      expect(Number.isFinite(edge.x1)).toBe(true);
      expect(Number.isFinite(edge.y2)).toBe(true);
    }
  });

  test('one input is one layout, and an empty fleet is an empty square', () => {
    const model = constellationModel(FLEET);
    expect(constellationLayout(model, 240)).toEqual(constellationLayout(model, 240));

    const empty = constellationLayout(constellationModel({ profiles: [] }), 240);
    expect(empty.empty).toBe(true);
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
    expect(empty.size).toBe(240);
  });

  test('a wide fleet fits a tall box: no node lands outside width or height', () => {
    // Ten gateways around the ring, the connected one carrying 9 Bots — the
    // widest constellation the map can be asked to hold.
    const model = constellationModel({
      profiles: Array.from({ length: 10 }, (_, i) => ({ id: `gw-${i}`, name: `GW ${i}` })),
      connectedGatewayId: 'gw-0',
      roster: Array.from({ length: 9 }, (_, i) => ({ id: `bot-${i}`, displayName: `B${i}` })),
    });
    const box = constellationLayout(model, 320, 520);
    expect(box.size).toBe(320);
    expect(box.height).toBe(520);
    for (const node of box.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(320);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(520);
    }
    for (const edge of box.edges) {
      [edge.x1, edge.x2].forEach((x) => {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(320);
      });
      [edge.y1, edge.y2].forEach((y) => {
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(520);
      });
    }
  });

  test('a zero-size first measurement answers zeros, never NaN', () => {
    const model = constellationModel(FLEET);
    const layout = constellationLayout(model, 0);
    expect(layout.size).toBe(0);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.empty).toBe(false);
    expect(layout.summary).toEqual(model.summary);
  });
});

describe('relativeLastSeenCopy dates a down gateway without ever going negative', () => {
  const NOW = 1_700_000_000_000;

  test('under a minute is just now, and a future stamp is not a negative age', () => {
    expect(relativeLastSeenCopy(NOW, NOW)).toBe('just now');
    expect(relativeLastSeenCopy(NOW - 59_000, NOW)).toBe('just now');
    expect(relativeLastSeenCopy(NOW + 60_000, NOW)).toBe('just now');
  });

  test('it names minutes, hours and days', () => {
    expect(relativeLastSeenCopy(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relativeLastSeenCopy(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(relativeLastSeenCopy(NOW - 30 * 86_400_000, NOW)).toBe('30d ago');
  });
});

describe('constellationNodeAccessibilityLabel never calls a down gateway live', () => {
  test('a live gateway reads live once, a saved one reads last seen or offline', () => {
    const model = constellationModel(FLEET);
    const home = model.nodes.find((node) => node.id === 'gateway:gw-home');
    const travel = model.nodes.find((node) => node.id === 'gateway:gw-travel');
    const offline = constellationModel({
      profiles: [{ id: 'gw-cold', name: 'Cold' }],
    }).nodes[0];

    expect(constellationNodeAccessibilityLabel(home!)).toBe('Home, live');
    expect(constellationNodeAccessibilityLabel(travel!)).toBe('Travel, last seen');
    expect(constellationNodeAccessibilityLabel(offline)).toBe('Cold, offline');
    expect(constellationNodeAccessibilityLabel(travel!)).not.toMatch(/live/);
  });

  test('a Bot reads its badges after its name', () => {
    const bot = constellationModel(FLEET).nodes.find((node) => node.kind === 'bot');
    expect(constellationNodeAccessibilityLabel(bot!)).toBe('Scout, running, 2 approvals');
  });
});
