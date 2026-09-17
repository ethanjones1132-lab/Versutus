import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import FleetScreen from '@/app/fleet';
import { ConstellationView } from '@/components/fleet/constellation-view';
import { useGateway } from '@/context/gateway-provider';
import type { GatewayCapabilitySnapshot } from '@/lib/gateway/types';

jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn(), push: jest.fn() }) }));
jest.mock('@/components/fleet/constellation-view', () => ({ ConstellationView: 'ConstellationView' }));
jest.mock('@/components/fleet/bot-sheet', () => ({ FleetBotSheet: 'FleetBotSheet' }));
jest.mock('@/components/ui', () => ({ Screen: 'Screen', Text: 'Text' }));
jest.mock('@/constants/tokens', () => ({ Spacing: { one: 4, four: 16 } }));
jest.mock('@/context/gateway-provider', () => ({ useGateway: jest.fn() }));
jest.mock('@/hooks/use-gateway-reachability', () => ({ useGatewayReachability: () => ({}) }));

describe('the Fleet uses the existing capability snapshot', () => {
  let renderer: ReactTestRenderer;
  afterEach(async () => { if (renderer) await act(async () => { renderer.unmount(); }); });

  test('snapshot changes update the live star without a read and disconnect removes its facts', async () => {
    const snapshot: GatewayCapabilitySnapshot = {
      checkedAt: 100, status: 'fresh', methods: {}, scopes: [],
      groups: [{ id: 'chat', label: 'Chat', status: 'ready' }],
    };
    const home = { id: 'home' };
    const state = {
      gateways: [home, { id: 'saved' }], activeGateway: home, status: 'connected', lastError: null,
      capabilitySnapshot: snapshot, listBots: jest.fn().mockResolvedValue([]),
      routineRead: { gatewayId: 'home', jobs: [], status: 'ready' },
      gatewayRequest: jest.fn(), refreshCapabilities: jest.fn(),
    };
    jest.mocked(useGateway).mockImplementation(() => state as unknown as ReturnType<typeof useGateway>);
    await act(async () => { renderer = create(createElement(FleetScreen)); });
    const nodes = () => renderer.root.findByType(ConstellationView).props.model.nodes as
      import('@/lib/fleet/constellation-model').ConstellationNode[];
    expect(nodes()[0].capabilityDetail).toBe('Capabilities 1/1 ready');
    expect(nodes()[1].capabilityDetail).toBeUndefined();
    state.capabilitySnapshot = { ...snapshot, status: 'stale' };
    await act(async () => { renderer.update(createElement(FleetScreen)); });
    expect(nodes()[0].capabilityDetail).toBe('Capabilities stale · 1/1 last known ready');
    state.status = 'disconnected';
    await act(async () => { renderer.update(createElement(FleetScreen)); });
    expect(nodes().every((node) => node.capabilityDetail === undefined)).toBe(true);
    expect(state.listBots).toHaveBeenCalledTimes(1);
    expect(state.gatewayRequest).not.toHaveBeenCalled();
    expect(state.refreshCapabilities).not.toHaveBeenCalled();
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

const fleetRoute = () => readSource('src', 'app', 'fleet.tsx');
const rootLayout = () => readSource('src', 'app', '_layout.tsx');
const homeDashboard = () =>
  readSource('src', 'components', 'gateway', 'gateway-home-dashboard.tsx');

// D2's route is a lens over state the app already holds: one existing roster
// read, the reachability wave the dashboard already mounts, and no fetch or
// poll of its own. The taps drive the shipped destinations.
describe('the fleet route projects the fleet and adds no protocol', () => {
  test('it folds provider state plus the existing roster read into the pure model', () => {
    const src = fleetRoute();
    expect(src).toContain('useGateway()');
    expect(src).toContain('useGatewayReachability(');
    expect(src).toContain('listBots(');
    expect(src).toContain('fleetConstellationInput(');
    expect(src).toContain('constellationModel(');
    expect(src).toContain('activityRuns');
    expect(src).toContain('pendingRunApproval');
    expect(src).toContain('activeGateway');
  });

  test('it renders the shared view and never a fetch of its own', () => {
    const src = fleetRoute();
    expect(src).toContain('<ConstellationView');
    expect(src).not.toContain('gatewayRequest(');
  });

  test('a Bot tap opens the Bot Chat, a gateway tap connects, a badge opens Activity', () => {
    const src = fleetRoute();
    expect(src).toContain('onPressNode={handlePressNode}');
    expect(src).toContain('onPressApproval={handlePressApproval}');
    expect(src).toContain('openBot(');
    expect(src).toContain("requestSurface({ kind: 'bot'");
    expect(src).toContain('connectGateway(');
    expect(src).toContain("router.push('/activity')");
  });

  test('the model hands the Bot id to the tap rather than the route parsing it', () => {
    const src = fleetRoute();
    expect(src).toContain('node.botId');
    expect(src).not.toContain("node.id.replace(");
    expect(src).not.toContain("split(':')");
  });

  test('a disconnected or non-routable Bot tap lands on the roster detail, only a routable one calls openBot', () => {
    const src = fleetRoute();
    // The pure decision gates the Bot tap the way gatewayHandshake gates the gateway's.
    expect(src).toContain('botTap(');
    expect(src).toContain('connectedRoster.find(');
    // The verdict travels from the roster read: only reported-routable opens a chat.
    expect(src).toMatch(/bot \?\? \{ id: botId \}/);
    // The unroutable destination is the roster surface, not a silent no-op.
    expect(src).toContain("requestSurface({ kind: 'roster' })");
    // And the chat path is the decision's onChat, not an unconditional open.
    expect(src).toMatch(/onChat: \(\) => \{\s*void openBot\(botId\)/);
    expect(src).toMatch(/onDetail: showRosterFallback/);
  });

  test('a gateway tap is gated by the pure handshake decision, and its lines are painted', () => {
    const src = fleetRoute();
    expect(src).toContain('gatewayHandshake(');
    expect(src).toContain('!handshake.canConnect');
    expect(src).toContain('handshakeStatus');
  });
});

describe('the fleet is a Stack destination with one entry on Home', () => {
  test('the Stack registers a full-screen (not modal) fleet route', () => {
    const src = rootLayout();
    expect(src).toContain('<Stack.Screen');
    expect(src).toContain('name="fleet"');
    const fleet = src.slice(src.indexOf('name="fleet"'));
    expect(fleet.slice(0, fleet.indexOf('/>'))).not.toContain("presentation: 'modal'");
  });

  test("Home's connection hero carries the entry button", () => {
    const src = homeDashboard();
    expect(src).toContain("router.push('/fleet')");
  });
});


test('the Fleet scopes Routine facts to their gateway and forwards freshness without a new read', () => {
  const src = fleetRoute();
  expect(src).toContain('fleetRoutineRead(routineRead,');
  expect(src).toContain('routineReadStatus: connectedRoutineRead.status');
  expect(src).toContain('connectedRoutineRead.jobs');
  const provider = readSource('src', 'context', 'gateway-provider.tsx');
  expect(provider).toContain('setRoutineRead(beginFleetRoutineRead)');
  expect(provider).toContain("setRoutineRead({ gatewayId, jobs, status: 'ready' })");
  expect(provider).toContain('[activeGateway?.id, cron, status]');
});
