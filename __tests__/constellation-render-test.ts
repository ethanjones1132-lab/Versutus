import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { ConstellationView } from '@/components/fleet/constellation-view';
import { Badge, PressableScale, Text } from '@/components/ui';
import { fleetConstellationInput } from '@/lib/fleet/constellation-input';
import { constellationLayout, constellationModel, constellationNodeAccessibilityLabel } from '@/lib/fleet/constellation-model';

jest.mock('@/constants/tokens', () => ({
  Radius: { xxl: 24 },
  Spacing: { half: 2, two: 8, three: 12, four: 16 },
}));
jest.mock('@/components/ui', () => ({
  Badge: 'Badge',
  EmptyState: 'EmptyState',
  GlassSurface: 'GlassSurface',
  PressableScale: 'PressableScale',
  Text: 'Text',
}));
jest.mock('@/components/ui/Icon', () => ({ Icon: 'Icon' }));
jest.mock('@/components/fleet/constellation-canvas', () => ({ ConstellationCanvas: 'Canvas' }));
jest.mock('@/hooks/use-now', () => ({ useNow: () => 100 }));
jest.mock('@/hooks/use-tokens', () => ({ useTokens: () => ({ glassBorder: '#000' }) }));

test('the live gateway reports readiness outside the packed star labels and saved gateways do not', async () => {
  const model = constellationModel({
    profiles: [{ id: 'home' }, { id: 'saved' }], connectedGatewayId: 'home',
    capabilitySnapshot: {
      checkedAt: 100, status: 'fresh', methods: {}, scopes: [],
      groups: [{ id: 'chat', label: 'Chat', status: 'ready' }],
    },
  });
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ConstellationView, { model, size: 320 })); });
  try {
    const stars = renderer.root.findAllByType(PressableScale);
    expect(renderer.root.findAllByType(Text).map((text) => text.props.children)).toContain('home · Capabilities 1/1 ready');
    expect(stars[0].findAllByType(Text).map((text) => text.props.children)).not.toContain('Capabilities 1/1 ready');
    expect(stars[0].props.accessibilityLabel).toContain('Capabilities 1/1 ready');
    expect(stars[1].findAllByType(Text).map((text) => text.props.children)).not.toContain('Capabilities 1/1 ready');
  } finally {
    await act(async () => { renderer.unmount(); });
  }
});

describe('only approval badges offer the Activity action', () => {
  let renderer: ReactTestRenderer;
  afterEach(async () => { await act(async () => { renderer.unmount(); }); });

  test.each([1, 2, 12])('%s approvals stay actionable alongside read-only failure facts', async (count) => {
    const model = constellationModel({
      profiles: [{ id: 'home' }],
      connectedGatewayId: 'home',
      roster: [{ id: 'scout', displayName: 'Scout' }],
      activityRuns: [{ id: 'failed-run', botId: 'scout', status: 'failed' }],
      pendingApprovals: Array.from({ length: count }, () => ({ botId: 'scout' })),
      routineReadStatus: 'ready',
      cronJobs: [{ id: 'routine', name: '[bot:scout] Check', lastStatus: 'error', failureStreak: 3 }],
    });
    const onPressApproval = jest.fn();
    const onPressNode = jest.fn();
    await act(async () => {
      renderer = create(createElement(ConstellationView, { model, size: 320, onPressApproval, onPressNode }));
    });
    const buttons = renderer.root.findAllByType(PressableScale);
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.props.accessibilityLabel)).not.toContain('Scout, 1 failed');
    expect(buttons.map((button) => button.props.accessibilityLabel)).not.toContain('Scout, routine failing');
    expect(renderer.root.findAllByType(Badge).map((badge) => badge.props.label)).toEqual(
      expect.arrayContaining(['1 failed', 'routine failing']),
    );
    const approvalLabel = `Scout, ${count} approval${count === 1 ? '' : 's'}`;
    await act(async () => { buttons.find((button) => button.props.accessibilityLabel === approvalLabel)!.props.onPress(); });
    expect(onPressApproval).toHaveBeenCalledTimes(1);
    expect(onPressApproval.mock.calls[0][0].botId).toBe('scout');
    expect(onPressNode).not.toHaveBeenCalled();
    const bot = model.nodes.find((node) => node.kind === 'bot')!;
    await act(async () => {
      buttons.find((button) => button.props.accessibilityLabel === constellationNodeAccessibilityLabel(bot))!.props.onPress();
    });
    expect(onPressNode).toHaveBeenCalledTimes(1);
    expect(onPressNode.mock.calls[0][0].botId).toBe('scout');
    expect(onPressApproval).toHaveBeenCalledTimes(1);
  });

  test('without an Activity handler an approval remains a visible fact', async () => {
    const model = constellationModel({
      profiles: [{ id: 'home' }], connectedGatewayId: 'home',
      roster: [{ id: 'scout' }], pendingApprovals: [{ botId: 'scout' }],
    });
    await act(async () => { renderer = create(createElement(ConstellationView, { model, size: 320 })); });
    expect(renderer.root.findAllByType(PressableScale)).toHaveLength(2);
    expect(renderer.root.findAllByType(Badge).map((badge) => badge.props.label)).toContain('1 approval');
  });
});

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const fleetComponents = (...parts: string[]) =>
  readSource('src', 'components', 'fleet', ...parts);
const nativeCanvas = () => fleetComponents('constellation-canvas.native.tsx');
const webCanvas = () => fleetComponents('constellation-canvas.web.tsx');
const defaultCanvas = () => fleetComponents('constellation-canvas.tsx');
const fallbackCanvas = () => fleetComponents('constellation-canvas-fallback.tsx');
const constellationView = () => fleetComponents('constellation-view.tsx');

describe('saved gateway probe verdicts reach the map and its spoken copy', () => {
  test.each([
    ['reachable', 'Reachable', '23 ms'],
    ['unreachable', 'Unreachable', 'Probe timed out'],
    ['checking', 'Checking', undefined],
    ['unknown', 'Unknown', undefined],
    ['connected', 'Unknown', undefined],
    ['unexpected', 'Unknown', undefined],
  ])('%s is a saved verdict, never a live connection', (state, label, detail) => {
    const model = constellationModel(fleetConstellationInput({
      gateways: [{ id: 'saved', name: 'Saved' }, { id: 'live', name: 'Live gateway' }],
      connectedGatewayId: 'live',
      reachability: {
        saved: { state, checkedAt: 100, latencyMs: 23.2, error: 'Timed out waiting for gateway' },
        live: { state: 'unreachable', error: 'old error' },
      },
      roster: [{ id: 'scout' }],
    }));
    const saved = model.nodes[0];
    expect(saved.live).toBe(false);
    expect(saved.badges).toEqual([{ label, tone: 'neutral' }]);
    expect(saved.probeDetail).toBe(detail);
    expect(saved.lastSeenAt).toBe(100);
    expect(constellationNodeAccessibilityLabel(saved)).toBe(
      ['Saved', 'saved gateway', label!.toLowerCase(), detail].filter(Boolean).join(', '),
    );
    const live = model.nodes.find((node) => node.id === 'gateway:live')!;
    expect(live.badges).toEqual([{ label: 'Live', tone: 'success' }]);
    expect(live.probeDetail).toBeUndefined();
    expect(model.nodes.filter((node) => node.kind === 'bot').map((node) => node.gatewayId)).toEqual(['live']);
  });

  test.each([
    ['Gateway returned HTTP 503', 'HTTP 503'],
    ['Network request failed', 'Could not reach the gateway'],
    ['private diagnostic '.repeat(100), 'Probe failed'],
    ['', undefined],
  ])('probe errors have bounded display copy for %s', (error, expected) => {
    const node = constellationModel(fleetConstellationInput({
      gateways: [{ id: 'saved' }],
      reachability: { saved: { state: 'unreachable', error } },
    })).nodes[0];
    expect(node.probeDetail).toBe(expected);
    expect(node.probeDetail?.length ?? 0).toBeLessThanOrEqual(80);
  });

  test.each([
    [0, '0 ms'], [23.6, '24 ms'], [100_000, '99999+ ms'],
    [Number.NaN, undefined], [Infinity, undefined], [-1, undefined],
  ])('latency %s is bounded or omitted', (latencyMs, expected) => {
    const node = constellationModel(fleetConstellationInput({
      gateways: [{ id: 'saved' }],
      reachability: { saved: { state: 'reachable', latencyMs } },
    })).nodes[0];
    expect(node.probeDetail).toBe(expected);
  });

  test('an absent probe is unknown, not evidence the gateway is offline', () => {
    const node = constellationModel({ profiles: [{ id: 'saved' }] }).nodes[0];
    expect(node.badges).toEqual([{ label: 'Unknown', tone: 'neutral' }]);
    expect(node.lastSeenAt).toBeUndefined();
  });

  test('the view paints the same bounded detail that the shared spoken label reads', () => {
    const src = constellationView();
    expect(src).toContain('{node.probeDetail}');
    expect(src).toContain('Probe {relativeLastSeenCopy(node.lastSeenAt, now)}');
    expect(src).toContain('constellationNodeAccessibilityLabel(node)');
  });
});

// D2's render: one pure layout, painted in Skia on native and in plain views
// (SVG) on web and whenever the Skia mount fails. The view is only the
// interaction and label layer over that canvas — it never re-derives the
// graph the model already emitted.
describe('the constellation is painted from one layout', () => {
  test('both painters consume the shared pure layout helper', () => {
    for (const src of [nativeCanvas(), fallbackCanvas()]) {
      expect(src).toContain('constellationLayout(');
      expect(src).toContain("from '@/lib/fleet/constellation-model'");
      expect(src).not.toContain('constellationModel(');
    }
  });

  test('the view draws the model it is handed and never re-derives it', () => {
    const src = constellationView();
    expect(src).toContain('<ConstellationCanvas');
    expect(src).toContain('constellationEmptyCopy()');
    expect(src).not.toContain('constellationModel(');
    expect(src).not.toContain('fleetConstellationInput(');
  });

  test('the view derives its paint geometry from the shared layout, not ad-hoc math', () => {
    const src = constellationView();
    expect(src).toContain('constellationLayout(model, box)');
    expect(src).toContain('useWindowDimensions()');
    expect(src).not.toContain('DEFAULT_SIZE');
  });

  test('map and labels share one envelope, so no profile bleeds off the edge', () => {
    const src = constellationView();
    // The node press targets are positioned INSIDE the same box the canvas is
    // handed (box, not a second size), and the map clips to that envelope.
    expect(src).toContain('styles.mapWrap');
    expect(src).toContain("width: box, height: box");
    expect(src).toContain('<ConstellationCanvas model={model} size={box} />');
    // Each press target is centred on its node with the width that node was
    // given: a Bot's scaled label budget, a gateway's default box
    // (constellationNodeBoxWidth). A single fixed box over tightly packed Bots
    // is what smeared a 15-Bot roster into one line on 2026-09-16.
    expect(src).toContain('constellationNodeBoxWidth(node, box, NODE_BOX_WIDTH)');
    expect(src).toContain('left: node.x - boxWidth / 2');
    expect(src).toContain('width: boxWidth,');
  });

  test('the HUD reads the model summary, not its own arithmetic', () => {
    const src = constellationView();
    expect(src).toContain('constellationSummaryCopy(model.summary)');
    expect(src).toContain('model.summary.approvals');
    expect(src).not.toContain("badges.filter((b");
  });
});

describe('native paints in Skia, every other path paints plain views', () => {
  test('the native canvas paints edges and nodes in one Skia Canvas', () => {
    const src = nativeCanvas();
    expect(src).toContain("from '@shopify/react-native-skia'");
    expect(src).toContain('<Canvas');
    expect(src).toContain('<Line');
    expect(src).toContain('<Circle');
    expect(src).toContain('constellationLayout(');
  });

  test('a Skia mount that throws falls back to the plain canvas', () => {
    const src = nativeCanvas();
    expect(src).toContain('getDerivedStateFromError');
    expect(src).toContain('<ConstellationCanvasFallback {...props} />');
  });

  test('the fallback draws the same layout in SVG', () => {
    const src = fallbackCanvas();
    expect(src).toContain("from 'react-native-svg'");
    expect(src).toContain('constellationLayout(');
  });

  test('web and the default resolution both re-export the plain canvas', () => {
    expect(webCanvas()).toBe(
      "export { ConstellationCanvasFallback as ConstellationCanvas } from './constellation-canvas-fallback';\n",
    );
    expect(defaultCanvas()).toContain('ConstellationCanvasFallback as ConstellationCanvas');
  });

  test('no Skia import reaches web, the default resolution, or the fallback', () => {
    for (const src of [webCanvas(), defaultCanvas(), fallbackCanvas()]) {
      expect(src).not.toContain('@shopify/react-native-skia');
    }
  });
});

describe('the view is tappable and honest', () => {
  test('every node is a press target announced by the shared honesty label', () => {
    const src = constellationView();
    expect(src).toContain('constellationNodeAccessibilityLabel(node)');
    expect(src).toContain('onPressNode');
    expect(src).toContain('onPressApproval');
    expect(src).toContain('<Badge');
  });

  test('a saved gateway is dated with the shared relative copy, never left undated', () => {
    const src = constellationView();
    expect(src).toContain('relativeLastSeenCopy(node.lastSeenAt, now)');
  });

  test('an empty fleet renders the dignified empty copy, not a blank square', () => {
    const src = constellationView();
    expect(src).toContain('if (model.empty)');
    expect(src).toContain('<EmptyState');
    expect(src).toContain('constellationEmptyCopy()');
  });

  test('the view adds no fetch and no provider of its own', () => {
    const src = constellationView();
    expect(src).not.toContain('gatewayRequest(');
    expect(src).not.toContain('useGateway(');
  });
});

describe('host and routine edges have unique ids and render correctly', () => {
  test('constellationLayout gives distinct ids to hosts and routine edges for the same pair', () => {
    const model = constellationModel({
      profiles: [{ id: 'home', name: 'Home' }],
      connectedGatewayId: 'home',
      roster: [{ id: 'scout', displayName: 'Scout' }],
      routineReadStatus: 'ready',
      cronJobs: [{ id: 'routine', name: '[bot:scout] Check', lastStatus: 'ok' }],
    });
    const layout = constellationLayout(model, 320);
    const hostsEdge = layout.edges.find((e) => e.kind === 'hosts');
    const routineEdge = layout.edges.find((e) => e.kind === 'routine');
    expect(hostsEdge).toBeDefined();
    expect(routineEdge).toBeDefined();
    expect(hostsEdge!.id).not.toBe(routineEdge!.id);
    expect(hostsEdge!.id).toContain('@hosts');
    expect(routineEdge!.id).toContain('@routine');
    expect(hostsEdge!.from).toBe(routineEdge!.from);
    expect(hostsEdge!.to).toBe(routineEdge!.to);
  });

  test('native canvas filters host edges to only kind=hosts', () => {
    const src = readSource('src', 'components', 'fleet', 'constellation-canvas.native.tsx');
    expect(src).toContain('layout.edges');
    expect(src).toContain(".filter((edge) => edge.kind === 'hosts')");
  });

  test('fallback canvas distinguishes edges by kind and uses unique keys', () => {
    const src = readSource('src', 'components', 'fleet', 'constellation-canvas-fallback.tsx');
    expect(src).toContain("edge.kind === 'routine'");
    expect(src).toContain('key={edge.id}');
  });

  test('a Bot with routines shows one host line and one routine arc in layout', () => {
    const model = constellationModel({
      profiles: [{ id: 'home', name: 'Home' }],
      connectedGatewayId: 'home',
      roster: [{ id: 'scout', displayName: 'Scout' }],
      routineReadStatus: 'ready',
      cronJobs: [
        { id: 'r1', name: '[bot:scout] Morning', lastStatus: 'ok' },
        { id: 'r2', name: '[bot:scout] Evening', lastStatus: 'warn' },
      ],
    });
    const layout = constellationLayout(model, 320);
    const hostsEdges = layout.edges.filter((e) => e.kind === 'hosts');
    const routineEdges = layout.edges.filter((e) => e.kind === 'routine');
    expect(hostsEdges).toHaveLength(1);
    expect(routineEdges).toHaveLength(1);
    expect(hostsEdges[0].from).toBe(routineEdges[0].from);
    expect(hostsEdges[0].to).toBe(routineEdges[0].to);
  });

  test('a Bot without routines shows only a host edge', () => {
    const model = constellationModel({
      profiles: [{ id: 'home', name: 'Home' }],
      connectedGatewayId: 'home',
      roster: [{ id: 'scout', displayName: 'Scout' }],
      routineReadStatus: 'ready',
      cronJobs: [],
    });
    const layout = constellationLayout(model, 320);
    const hostsEdges = layout.edges.filter((e) => e.kind === 'hosts');
    const routineEdges = layout.edges.filter((e) => e.kind === 'routine');
    expect(hostsEdges).toHaveLength(1);
    expect(routineEdges).toHaveLength(0);
  });
});
