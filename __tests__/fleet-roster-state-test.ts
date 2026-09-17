import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import FleetScreen from '@/app/fleet';
import { ConstellationView } from '@/components/fleet/constellation-view';
import { useGateway } from '@/context/gateway-provider';
import type { PublicBot } from '@/lib/gateway/bots';
import { constellationNodeAccessibilityLabel, constellationSummaryCopy } from '@/lib/fleet/constellation-model';

jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn(), push: jest.fn() }) }));
jest.mock('@/components/fleet/constellation-view', () => ({ ConstellationView: 'ConstellationView' }));
jest.mock('@/components/fleet/bot-sheet', () => ({ FleetBotSheet: 'FleetBotSheet' }));
jest.mock('@/components/ui', () => ({ Screen: 'Screen', Text: 'Text' }));
jest.mock('@/constants/tokens', () => ({ Spacing: { one: 4, four: 16 } }));
jest.mock('@/context/gateway-provider', () => ({ useGateway: jest.fn() }));
jest.mock('@/hooks/use-gateway-reachability', () => ({ useGatewayReachability: () => ({}) }));

const scout: PublicBot = { id: 'scout', displayName: 'Scout', routable: true };
const keeper: PublicBot = { id: 'keeper', displayName: 'Keeper', routable: true };
const home = { id: 'home', name: 'Home' };
const away = { id: 'away', name: 'Away' };

function deferredRoster() {
  let resolve!: (bots: PublicBot[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<PublicBot[]>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('Fleet Roster reads retain honest, gateway-scoped facts', () => {
  let renderer: ReactTestRenderer;
  let state: {
    gateways: typeof home[];
    activeGateway: typeof home;
    status: string;
    lastError: null;
    listBots: jest.Mock<Promise<PublicBot[]>, []>;
    routineRead: { gatewayId: string; jobs: []; status: 'ready' };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    state = {
      gateways: [home, away], activeGateway: home, status: 'connected', lastError: null,
      listBots: jest.fn().mockResolvedValue([scout]),
      routineRead: { gatewayId: 'home', jobs: [], status: 'ready' },
    };
    jest.mocked(useGateway).mockImplementation(() => state as unknown as ReturnType<typeof useGateway>);
  });
  afterEach(async () => {
    if (renderer) await act(async () => { renderer.unmount(); });
    jest.useRealTimers();
  });

  async function mount() {
    await act(async () => { renderer = create(createElement(FleetScreen)); });
    await flushRead();
  }
  async function render() {
    await act(async () => { renderer.update(createElement(FleetScreen)); });
  }
  async function flushRead() {
    await act(async () => { jest.runOnlyPendingTimers(); });
  }
  function model() {
    return renderer.root.findByType(ConstellationView).props.model as
      ReturnType<typeof import('@/lib/fleet/constellation-model').constellationModel>;
  }
  function bots() { return model().nodes.filter((node) => node.kind === 'bot'); }

  test('a failed reconnect retains the last Roster and warns on the map and spoken labels', async () => {
    await mount();
    expect(bots().map((bot) => bot.label)).toEqual(['Scout']);
    state.status = 'disconnected';
    await render();
    expect(bots()).toEqual([]);
    const read = deferredRoster();
    state.listBots.mockReturnValue(read.promise);
    state.status = 'connected';
    await render();
    await flushRead();
    expect(constellationSummaryCopy(model().summary)).toContain('Roster stale');
    await act(async () => { read.reject(new Error('private gateway diagnostic')); });
    expect(bots().map((bot) => bot.label)).toEqual(['Scout']);
    expect(model().summary.rosterReadStatus).toBe('stale');
    expect(constellationSummaryCopy(model().summary)).toContain('1 last-known Bot');
    expect(constellationSummaryCopy(model().summary)).not.toContain('all quiet');
    const gateway = model().nodes.find((node) => node.id === 'gateway:home')!;
    expect(gateway.badges).toContainEqual({ label: 'Roster stale', tone: 'neutral' });
    expect(constellationNodeAccessibilityLabel(gateway)).toContain('roster stale');
    expect(constellationNodeAccessibilityLabel(bots()[0])).toContain('roster stale');
    expect(JSON.stringify(model())).not.toContain('private gateway diagnostic');
    expect(state.listBots).toHaveBeenCalledTimes(2);
  });

  test('a first read failure admits unavailable rather than zero Bots and quiet work', async () => {
    state.listBots.mockRejectedValue(new Error('refused'));
    await mount();
    expect(bots()).toEqual([]);
    expect(model().summary.rosterReadStatus).toBe('unavailable');
    expect(constellationSummaryCopy(model().summary)).toContain('Roster unavailable');
    expect(constellationSummaryCopy(model().summary)).not.toMatch(/0 Bots|all quiet/);
  });

  test('a successful read replaces stale Bots and a successful empty read clears them', async () => {
    await mount();
    for (const result of [null, [keeper], []]) {
      state.status = 'disconnected';
      await render();
      if (result === null) state.listBots.mockRejectedValue(new Error('refused'));
      else state.listBots.mockResolvedValue(result);
      state.status = 'connected';
      await render();
      await flushRead();
      expect(bots().map((bot) => bot.label)).toEqual(result === null ? ['Scout'] : result.map((bot) => bot.displayName));
      expect(model().summary.rosterReadStatus).toBe(result === null ? 'stale' : 'ready');
    }
    expect(constellationSummaryCopy(model().summary)).toBe('0 Bots · all quiet');
  });

  test('switching gateways while connected masks the old Roster and starts its own read', async () => {
    await mount();
    const read = deferredRoster();
    state.listBots.mockReturnValue(read.promise);
    state.activeGateway = away;
    await render();
    expect(bots()).toEqual([]);
    expect(constellationSummaryCopy(model().summary)).toContain('Roster unreported');
    await flushRead();
    expect(state.listBots).toHaveBeenCalledTimes(2);
    await act(async () => { read.reject(new Error('refused')); });
    expect(bots()).toEqual([]);
    expect(model().summary.rosterReadStatus).toBe('unavailable');
    expect(model().nodes.find((node) => node.id === 'gateway:home')!.badges)
      .not.toContainEqual({ label: 'Roster stale', tone: 'neutral' });
  });

  test.each(['resolve', 'reject'] as const)('a cancelled old read cannot %s into the new gateway', async (settle) => {
    const old = deferredRoster();
    state.listBots.mockReturnValue(old.promise);
    await mount();
    state.activeGateway = away;
    state.listBots.mockResolvedValue([keeper]);
    await render();
    await flushRead();
    await act(async () => {
      if (settle === 'resolve') old.resolve([scout]);
      else old.reject(new Error('late failure'));
    });
    expect(bots().map((bot) => [bot.gatewayId, bot.label])).toEqual([['away', 'Keeper']]);
    expect(model().summary.rosterReadStatus).toBe('ready');
    state.status = 'disconnected';
    await render();
    expect(bots()).toEqual([]);
    expect(constellationSummaryCopy(model().summary)).not.toContain('Roster');
  });
});
