import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import FleetScreen from '@/app/fleet';
import { ConstellationView } from '@/components/fleet/constellation-view';
import { Text } from '@/components/ui';
import { useGateway } from '@/context/gateway-provider';
import type { PublicBot } from '@/lib/gateway/bots';
import type { ConstellationNode, ConstellationModel } from '@/lib/fleet/constellation-model';

jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn(), push: jest.fn() }) }));
jest.mock('@/components/fleet/constellation-view', () => ({ ConstellationView: 'ConstellationView' }));
jest.mock('@/components/fleet/bot-sheet', () => ({ FleetBotSheet: 'FleetBotSheet' }));
jest.mock('@/components/ui', () => ({ Screen: 'Screen', Text: 'Text' }));
jest.mock('@/constants/tokens', () => ({ Spacing: { one: 4, four: 16 } }));
jest.mock('@/context/gateway-provider', () => ({ useGateway: jest.fn() }));
jest.mock('@/hooks/use-gateway-reachability', () => ({ useGatewayReachability: () => ({}) }));

const home = { id: 'home', name: 'Home' };
const away = { id: 'away', name: 'Away' };
const scout: PublicBot = { id: 'scout', displayName: 'Scout', routable: true };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

let state: Record<string, unknown>;
let unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', recordUnhandled);
  state = {
    gateways: [home],
    activeGateway: null,
    status: 'disconnected',
    statusDetail: undefined,
    lastError: null,
    capabilitySnapshot: undefined,
    activityRunsForActiveGateway: [],
    pendingRunApproval: [],
    listBots: jest.fn().mockResolvedValue([]),
    routineRead: { gatewayId: undefined, jobs: [], status: 'unreported' },
    requestSurface: jest.fn(),
    openBot: jest.fn(),
    connectGateway: jest.fn().mockResolvedValue(undefined),
  };
  jest.mocked(useGateway).mockImplementation(
    () => state as unknown as ReturnType<typeof useGateway>,
  );
});

let renderer: ReactTestRenderer | null = null;

afterEach(async () => {
  process.off('unhandledRejection', recordUnhandled);
  if (renderer) {
    const doomed = renderer;
    renderer = null;
    await act(async () => {
      doomed.unmount();
    });
  }
});

/** Drain the microtask queue AND one macrotask, so Node can report a
 *  rejection that nothing handled. */
async function settle(rounds = 3) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render() {
  await act(async () => {
    renderer = create(createElement(FleetScreen));
  });
  await settle();
}

async function update() {
  await act(async () => {
    renderer?.update(createElement(FleetScreen));
  });
  await settle();
}

function model(): ConstellationModel {
  return renderer!.root.findByType(ConstellationView).props.model as ConstellationModel;
}

function node(gatewayId: string): ConstellationNode {
  const found = model().nodes.find(
    (candidate) => candidate.gatewayId === gatewayId && candidate.kind === 'gateway',
  );
  if (!found) throw new Error(`no gateway star for ${gatewayId}`);
  return found;
}

function noticeText(): string {
  return renderer!.root
    .findAllByType(Text)
    .map((element) => element.props.children)
    .filter((child): child is string => typeof child === 'string')
    .join(' | ');
}

async function press(target: ConstellationNode) {
  await act(async () => {
    (renderer!.root.findByType(ConstellationView).props.onPressNode as (node: ConstellationNode) => void)(
      target,
    );
  });
  await settle();
}

describe('FLEET-1: a refused connect is answered on screen, never dropped', () => {
  test('no rejection escapes the tap and the refusal is named', async () => {
    // `connectGateway` rejects on an auth refusal ON PURPOSE, and the
    // provider's own onStatus has already recorded the reason in `lastError`.
    state.lastError = 'Gateway rejected the API key';
    state.connectGateway = jest.fn().mockRejectedValue(new Error('Gateway rejected the API key.'));
    await render();

    await press(node('home'));

    expect(unhandled).toEqual([]);
    expect(noticeText()).toContain('Gateway rejected the API key');
  });

  test("the provider's words win over the rejected promise's", async () => {
    state.lastError = 'The API key for Home was refused';
    state.connectGateway = jest.fn().mockRejectedValue(new Error('socket hang up'));
    await render();

    await press(node('home'));

    expect(noticeText()).toContain('The API key for Home was refused');
    expect(noticeText()).not.toContain('socket hang up');
  });

  test('a rejection with no usable text falls back to the provider lastError', async () => {
    state.lastError = 'Gateway rejected the API key';
    state.connectGateway = jest.fn().mockRejectedValue(new Error(''));
    await render();

    await press(node('home'));

    expect(noticeText()).toContain('Gateway rejected the API key');
  });

  test('a connected gateway disproves the line, so it goes with no tap', async () => {
    state.lastError = 'Gateway rejected the API key';
    state.connectGateway = jest.fn().mockRejectedValue(new Error('Gateway rejected the API key.'));
    await render();
    await press(node('home'));
    expect(noticeText()).toContain('Gateway rejected the API key');

    // The stale-error rule (stale-error.ts): a gateway that is answering has
    // refused nothing, so the card must not sit beside a live connection.
    state.status = 'connected';
    state.activeGateway = home;
    state.lastError = null;
    await update();

    expect(noticeText()).not.toContain('Gateway rejected the API key');
  });

  test('the next attempt clears the previous refusal, and the success path is unchanged', async () => {
    state.gateways = [home, away];
    state.lastError = 'Gateway rejected the API key';
    state.connectGateway = jest.fn().mockRejectedValue(new Error('Gateway rejected the API key.'));
    await render();
    await press(node('home'));
    expect(noticeText()).toContain('Gateway rejected the API key');

    state.connectGateway = jest.fn().mockResolvedValue(undefined);
    // The screen reads the provider through a render, so the new mock has to
    // land in one before the next tap can reach it.
    await update();
    await press(node('away'));

    expect(noticeText()).not.toContain('Gateway rejected the API key');
    expect(state.connectGateway).toHaveBeenLastCalledWith(away);
  });
});

describe('FLEET-3: the roster read is one per gateway', () => {
  test('a connection blip while the first read is still running joins it', async () => {
    const first = deferred<PublicBot[]>();
    state.status = 'connected';
    state.activeGateway = home;
    state.listBots = jest.fn().mockReturnValue(first.promise);
    await render();
    expect(state.listBots).toHaveBeenCalledTimes(1);

    // The self-heal (connected → reconnecting → connected) mints a new request
    // identity while gateway A's enumeration is still on the wire.
    state.status = 'reconnecting';
    await update();
    state.status = 'connected';
    await update();

    // One enumeration, not two: `/v1/bots` enumerates Hermes profiles.
    expect(state.listBots).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve([scout]);
    });
    await settle();
    expect(model().nodes.some((entry) => entry.botId === 'scout')).toBe(true);
  });

  test('a settled read is not replayed: the next wave is a fresh one', async () => {
    state.status = 'connected';
    state.activeGateway = home;
    state.listBots = jest.fn().mockResolvedValue([scout]);
    await render();
    expect(state.listBots).toHaveBeenCalledTimes(1);

    state.status = 'reconnecting';
    await update();
    state.status = 'connected';
    await update();

    expect(state.listBots).toHaveBeenCalledTimes(2);
  });

  test('switching gateway A → B reads once each, and A never paints B', async () => {
    const a = deferred<PublicBot[]>();
    state.status = 'connected';
    state.activeGateway = home;
    state.listBots = jest.fn().mockReturnValueOnce(a.promise).mockResolvedValue([]);
    await render();
    expect(state.listBots).toHaveBeenCalledTimes(1);

    state.activeGateway = away;
    await update();
    expect(state.listBots).toHaveBeenCalledTimes(2);

    // A's answer lands last, and the map must still be B's.
    await act(async () => {
      a.resolve([scout]);
    });
    await settle();
    expect(model().nodes.filter((entry) => entry.kind === 'bot')).toEqual([]);
  });

  test('coming back to A joins A, not a second enumeration of it', async () => {
    const a = deferred<PublicBot[]>();
    state.status = 'connected';
    state.activeGateway = home;
    state.listBots = jest.fn().mockReturnValueOnce(a.promise).mockResolvedValue([]);
    await render();

    state.activeGateway = away;
    await update();
    state.activeGateway = home;
    await update();

    expect(state.listBots).toHaveBeenCalledTimes(2);

    await act(async () => {
      a.resolve([scout]);
    });
    await settle();
    expect(model().nodes.some((entry) => entry.botId === 'scout')).toBe(true);
  });
});

describe('FLEET-4: a star whose profile is gone is never a silent no-op', () => {
  test('the tap says the gateway was removed and does not connect', async () => {
    state.gateways = [home, away];
    state.status = 'connected';
    state.activeGateway = home;
    await render();
    const stale = node('home');

    // Settings removed `home` while Fleet stayed mounted, so the graph the tap
    // is holding names a profile this device no longer has.
    state.gateways = [away];
    state.activeGateway = away;
    await update();
    expect(model().nodes.some((entry) => entry.gatewayId === 'home')).toBe(false);

    await press(stale);

    expect(noticeText()).toContain('That gateway was removed');
    expect(state.connectGateway).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  test('the next gateway tap clears the notice and connects as before', async () => {
    state.gateways = [home, away];
    state.status = 'disconnected';
    await render();
    const stale = node('home');
    state.gateways = [away];
    await update();
    await press(stale);
    expect(noticeText()).toContain('That gateway was removed');

    await press(node('away'));

    expect(state.connectGateway).toHaveBeenCalledWith(away);
    expect(noticeText()).not.toContain('That gateway was removed');
  });
});
