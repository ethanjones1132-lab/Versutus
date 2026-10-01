import { createElement, useEffect } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useGatewaySettingsScreen } from '@/hooks/use-gateway-settings-screen';
import { GatewayHttpError } from '@/lib/gateway/errors';
import { humanizeGatewayError } from '@/lib/gateway/error-humanizer';
import type { GatewayProfile } from '@/lib/gateway/types';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(rel: string[]): string {
  return nodeFs.readFileSync([__dirname, '..', ...rel].join(SEP), 'utf8').replace(/\r\n/g, '\n');
}

const dashboard = () => readSource(['src', 'components', 'gateway', 'gateway-home-dashboard.tsx']);
const management = () =>
  readSource(['src', 'components', 'gateway', 'gateway-management-section.tsx']);
const useGatewaySettingsScreenSource = () =>
  readSource(['src', 'hooks', 'use-gateway-settings-screen.ts']);

/**
 * Every seam the settings screen reaches is a mock, so the assertions are about
 * this screen's decisions and nothing else: what it does with a refused
 * connect, and whether it lets a remove sheet close over a failed write.
 */
let mockEnv: {
  push: jest.Mock;
  connectGateway: jest.Mock;
  deleteGateway: jest.Mock;
  gateways: GatewayProfile[];
  gateway: Record<string, unknown>;
};

jest.mock('expo-router', () => ({ useRouter: () => ({ push: (...args: unknown[]) => mockEnv.push(...args) }) }));
jest.mock('@/context/gateway-provider', () => ({ useGateway: () => mockEnv.gateway }));
jest.mock('@/hooks/use-gateway-reachability', () => ({ useGatewayReachability: () => ({}) }));
jest.mock('@/lib/discovery/scanner', () => ({
  GatewayDiscoveryScanner: jest.fn(() => ({
    subscribe: jest.fn(() => jest.fn()),
    start: jest.fn(),
    stop: jest.fn(),
  })),
  isNativeDiscoveryAvailable: jest.fn(() => false),
}));

type Screen = ReturnType<typeof useGatewaySettingsScreen>;
let screen!: Screen;
let host: ReactTestRenderer | null = null;

function ScreenHost() {
  const value = useGatewaySettingsScreen();
  useEffect(() => {
    screen = value;
  }, [value]);
  return null;
}

function gateway(id: string): GatewayProfile {
  return { id, name: id, url: `http://${id}:8642`, createdAt: 0 };
}

let renderers: ReactTestRenderer[] = [];
let unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(async () => {
  unhandled = [];
  process.on('unhandledRejection', recordUnhandled);
  mockEnv = {
    push: jest.fn() as unknown as jest.Mock,
    connectGateway: jest.fn() as unknown as jest.Mock,
    deleteGateway: jest.fn() as unknown as jest.Mock,
    gateways: [gateway('alpha'), gateway('beta')],
    gateway: {},
  };
  mockEnv.gateway = {
    gateways: mockEnv.gateways,
    activeGateway: null,
    status: 'disconnected',
    statusDetail: undefined,
    settings: {},
    deviceId: 'device-1',
    connectGateway: (profile: GatewayProfile) => mockEnv.connectGateway(profile),
    deleteGateway: (id: string) => mockEnv.deleteGateway(id),
    addGateway: jest.fn(),
    setAutoConnect: jest.fn(),
    refreshGateways: jest.fn(),
  };
  await act(async () => {
    host = create(createElement(ScreenHost));
    renderers.push(host);
  });
});

afterEach(async () => {
  process.off('unhandledRejection', recordUnhandled);
  for (const renderer of renderers) {
    await act(async () => {
      renderer.unmount();
    });
  }
  renderers = [];
  host = null;
});

/**
 * Re-render the host against a new provider status, as the live connection
 * flipping does. Nothing here touches the screen: the point of the tests below
 * is that a healthy connection clears a refusal with no tap at all.
 */
async function flipStatus(status: string) {
  mockEnv.gateway = { ...mockEnv.gateway, status };
  await act(async () => {
    host?.update(createElement(ScreenHost));
  });
  await settle();
}

/** Let the microtask queue and one macrotask drain, as a real tap would. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('a connect that is refused is handled, named, and does not navigate', () => {
  test('no unhandled rejection escapes the tap, and /chat is never pushed', async () => {
    const refusal = new Error('gateway rejected the API key');
    mockEnv.connectGateway.mockRejectedValue(refusal);

    // Fired exactly the way the row wires it, and not awaited: that is what
    // made the rejection escape before.
    await act(async () => {
      void screen.handleConnect('alpha');
    });
    await settle();

    expect(unhandled).toEqual([]);
    expect(mockEnv.push).not.toHaveBeenCalled();
    expect(screen.connectFailure).toBe(refusal);
  });

  test('the refusal reaches the screen as the provider composed it, not a paraphrase', async () => {
    // `attachClient` rethrows whatever the transport said, and the ErrorCard is
    // fed that value directly — so the message the Gate wrote is what shows,
    // and a 401 still reads as a refused token rather than a generic failure.
    mockEnv.connectGateway.mockRejectedValue(new GatewayHttpError('HTTP 401', 401));
    await act(async () => {
      void screen.handleConnect('alpha');
    });
    await settle();

    expect(humanizeGatewayError(screen.connectFailure)).toMatchObject({
      title: 'Gateway rejected the key',
      next: 'Open gateway setup and update the token.',
    });
  });

  test('a connect that answers still navigates, and clears the previous refusal', async () => {
    mockEnv.connectGateway.mockRejectedValueOnce(new Error('gateway rejected the API key'));
    await act(async () => {
      void screen.handleConnect('alpha');
    });
    await settle();
    expect(screen.connectFailure).not.toBeNull();

    mockEnv.connectGateway.mockResolvedValue(undefined);
    await act(async () => {
      void screen.handleConnect('alpha');
    });
    await settle();

    expect(screen.connectFailure).toBeNull();
    expect(mockEnv.push).toHaveBeenCalledWith('/chat');
  });

  test('a tap on an unknown id neither connects nor navigates', async () => {
    await act(async () => {
      void screen.handleConnect('missing');
    });
    await settle();
    expect(mockEnv.connectGateway).not.toHaveBeenCalled();
    expect(mockEnv.push).not.toHaveBeenCalled();
  });

  test('a connection that answers clears the refusal without a tap', async () => {
    // The card this feeds says "Gateway rejected the key / The API key or token
    // was refused. / Open gateway setup and update the token." Beside a
    // CONNECTED badge it states something the live connection disproves and
    // sends the operator to replace a token that works — the rule every other
    // gateway error on these screens already follows (stale-error.ts). The
    // provider schedules its own 18s retry after an auth refusal, so the
    // gateway can answer with no tap here at all.
    mockEnv.connectGateway.mockRejectedValue(new GatewayHttpError('HTTP 401', 401));
    await act(async () => {
      void screen.handleConnect('alpha');
    });
    await settle();
    expect(screen.connectFailure).not.toBeNull();
    expect(screen.status).not.toBe('connected');

    await flipStatus('connected');

    expect(screen.connectFailure).toBeNull();
  });

  test('a refusal still shows while the gateway is not answering', async () => {
    // The other half of the rule: only `connected` disproves a failure.
    mockEnv.connectGateway.mockRejectedValue(new GatewayHttpError('HTTP 401', 401));
    await act(async () => {
      void screen.handleConnect('alpha');
    });
    await settle();

    await flipStatus('reconnecting');
    expect(screen.connectFailure).not.toBeNull();
  });
});

describe('the remove sheet only closes over a write that worked', () => {
  test('a refused write keeps the sheet up and names the refusal', async () => {
    mockEnv.deleteGateway.mockRejectedValue(new Error('secure store refused the write'));
    await act(async () => {
      screen.handleDelete('alpha');
    });
    await act(async () => {
      await screen.confirmDelete();
    });
    await settle();

    expect(screen.deleteCandidate?.id).toBe('alpha');
    expect(screen.deleteFailure).toBe('secure store refused the write');
    expect(unhandled).toEqual([]);
  });

  test('a successful write dismisses the sheet and leaves no failure behind', async () => {
    mockEnv.deleteGateway.mockResolvedValue(undefined);
    await act(async () => {
      screen.handleDelete('alpha');
    });
    expect(screen.deleteCandidate?.id).toBe('alpha');

    await act(async () => {
      await screen.confirmDelete();
    });
    await settle();

    expect(screen.deleteCandidate).toBeNull();
    expect(screen.deleteFailure).toBeNull();
    expect(mockEnv.deleteGateway).toHaveBeenCalledWith('alpha');
  });

  test('a second confirm press while the write is in flight is not a second remove', async () => {
    let release!: () => void;
    mockEnv.deleteGateway.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      }),
    );
    await act(async () => {
      screen.handleDelete('alpha');
    });
    await act(async () => {
      void screen.confirmDelete();
    });
    expect(screen.deletePending).toBe(true);

    await act(async () => {
      void screen.confirmDelete();
      void screen.confirmDelete();
    });
    expect(mockEnv.deleteGateway).toHaveBeenCalledTimes(1);

    release();
    await settle();
    expect(screen.deletePending).toBe(false);
    expect(screen.deleteCandidate).toBeNull();
  });

  test('two presses out of ONE rendered closure are one remove', async () => {
    // The guard above is read through `screen`, which re-reads after every
    // `act` — so it only ever exercises a closure that has already seen the
    // state update. Two taps inside one frame (or a programmatic double-fire)
    // come off the SAME closure, where `setDeletePending` has re-rendered
    // nothing yet; only a ref set before the first `await` can tell them apart.
    let release!: () => void;
    mockEnv.deleteGateway.mockReturnValue(
      new Promise<void>((resolve) => {
        release = () => resolve();
      }),
    );
    await act(async () => {
      screen.handleDelete('alpha');
    });

    const confirm = screen.confirmDelete;
    expect(confirm).toBe(screen.confirmDelete);
    await act(async () => {
      void confirm();
      void confirm();
    });

    expect(mockEnv.deleteGateway).toHaveBeenCalledTimes(1);

    release();
    await settle();
    expect(screen.deleteCandidate).toBeNull();
    expect(screen.deletePending).toBe(false);
  });

  test('cancelling clears the failure the sheet was showing', async () => {
    mockEnv.deleteGateway.mockRejectedValue(new Error('secure store refused the write'));
    await act(async () => {
      screen.handleDelete('alpha');
    });
    await act(async () => {
      await screen.confirmDelete();
    });
    expect(screen.deleteFailure).not.toBeNull();

    await act(async () => {
      screen.cancelDelete();
    });
    expect(screen.deleteCandidate).toBeNull();
    expect(screen.deleteFailure).toBeNull();
  });

  test('reopening the sheet for another gateway starts clean', async () => {
    mockEnv.deleteGateway.mockRejectedValueOnce(new Error('secure store refused the write'));
    await act(async () => {
      screen.handleDelete('alpha');
    });
    await act(async () => {
      await screen.confirmDelete();
    });
    expect(screen.deleteFailure).not.toBeNull();

    await act(async () => {
      screen.handleDelete('beta');
    });
    expect(screen.deleteFailure).toBeNull();
    expect(screen.deleteCandidate?.id).toBe('beta');
  });
});

describe('the two gateway screens surface both failures', () => {
  test('the Home dashboard row attaches a handler to the connect it fires', () => {
    // `connectGateway` rethrows an auth refusal on purpose, so `void
    // connectGateway(gateway)` on its own was an unhandled rejection.
    expect(dashboard()).not.toContain('onSelect={(gateway) => void connectGateway(gateway)}');
    expect(dashboard()).toContain(
      'void connectGateway(gateway).catch((error: unknown) => setConnectFailure(error));',
    );
  });

  test('the Home dashboard awaits its delete and keeps the sheet on a refusal', () => {
    const src = dashboard();
    expect(src).not.toMatch(/void deleteGateway\(deleteCandidate\.id\);/);
    expect(src).toMatch(
      /await deleteGateway\(target\.id\);\s*\n\s*setDeleteCandidate\(null\);[\s\S]*?catch \(error\) \{[\s\S]*?setDeleteFailure\(/,
    );
    // The in-flight flag is a REF on both screens, not the state read: two taps
    // inside one frame come off the same rendered closure, where the
    // `setDeletePending` that follows has re-rendered nothing yet.
    expect(src).toContain('if (!target || deletePendingRef.current) return;');
    expect(src).not.toContain('if (!target || deletePending) return;');
  });

  test('neither refusal card outlives the connection it names', () => {
    // The same rule both files' other gateway errors already follow
    // (stale-error.ts): a gateway that is answering has refused nothing, so
    // the card must not sit under a CONNECTED badge sending the operator to
    // replace a token that works. Both render through `connectionErrorShown`,
    // and both drop the state outright when the status turns healthy.
    for (const src of [dashboard(), management()]) {
      expect(src).toContain("from '@/lib/connection/stale-error'");
      expect(src).toMatch(
        /connectionErrorShown\(\s*status,\s*connectFailure instanceof Error \? connectFailure\.message : String\(connectFailure\),\s*\)/,
      );
      expect(src).toContain('{shownConnectFailure ? (');
      expect(src).not.toContain('{connectFailure ? (');
    }
    for (const src of [dashboard(), useGatewaySettingsScreenSource()]) {
      expect(src).toMatch(/if \(status === 'connected'\) setConnectFailure\(null\);/);
    }
  });

  test('the settings hook reads its in-flight delete from a ref', () => {
    const src = useGatewaySettingsScreenSource();
    expect(src).toContain('if (!id || deletePendingRef.current) return;');
    expect(src).not.toContain('if (!id || deletePending) return;');
  });

  test('both sheets and both screens render what they were told', () => {
    for (const src of [dashboard(), management()]) {
      expect(src).toContain('is still saved. ${deleteFailure}');
      expect(src).toContain('busy={deletePending}');
      expect(src).toContain('humanizeGatewayError(connectFailure)');
    }
    expect(dashboard()).toContain('onDismiss={() => setConnectFailure(null)}');
    expect(management()).toContain('onDismiss={clearConnectFailure}');
  });

  test('the management row wiring still calls the handler for the tapped gateway', () => {
    expect(management()).toContain('onSelect={(gateway) => void handleConnect(gateway.id)}');
    expect(management()).toContain('onDelete={(gateway) => handleDelete(gateway.id)}');
  });
});
