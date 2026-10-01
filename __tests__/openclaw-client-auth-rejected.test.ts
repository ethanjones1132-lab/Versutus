// A refused credential on the WS dialect must be told apart from a gateway
// that is merely unreachable. The Hermes dialects announce it with
// setStatus('disconnected', message, { authRejected: true }); this client
// forwarded only two arguments, so the provider never raised authFailureRef,
// kept auto-retrying forever, and each new attempt erased the message that
// named the cause.

jest.mock('@/lib/gateway/device-auth-token', () => ({
  loadDeviceAuthToken: jest.fn(),
  saveDeviceAuthToken: jest.fn(() => Promise.resolve()),
  clearDeviceAuthToken: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/gateway/device-identity', () => ({
  loadOrCreateDeviceIdentity: jest.fn(() =>
    Promise.resolve({
      deviceId: 'device-1',
      publicKeyB64Url: 'public-key',
      privateKeyB64Url: 'private-key',
      createdAtMs: 0,
    }),
  ),
  signDevicePayload: jest.fn(() => Promise.resolve('signature')),
}));

import { OpenClawGatewayClient } from '@/lib/gateway/openclaw-client';
import { OpenClawAdapterClient } from '@/lib/portal/openclaw-adapter';
import type { ConnectionStatus, GatewayProfile } from '@/lib/gateway/types';

import { loadDeviceAuthToken } from '@/lib/gateway/device-auth-token';

const mockLoadToken = loadDeviceAuthToken as jest.Mock;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    // A real socket answers close asynchronously; the fake stays silent unless
    // a test drives serverClose itself.
  }

  serverOpen() {
    this.onopen?.();
  }

  serverFrame(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  serverClose(code = 1006, reason = '') {
    this.onclose?.({ code, reason });
  }
}

const PROFILE: GatewayProfile = {
  id: 'gw1',
  name: 'OpenClaw gate',
  url: 'ws://gate.test:8642/openclaw',
  kind: 'openclaw',
  bootstrapToken: 'bootstrap-secret',
  createdAt: 0,
};

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

/** Drive one handshake attempt and answer `connect` with `answer`. */
async function answerConnect(
  client: { connect: () => void },
  answer: Record<string, unknown>,
): Promise<FakeWebSocket> {
  client.connect();
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.serverOpen();
  ws.serverFrame({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } });
  await flush();
  ws.serverFrame({ type: 'res', id: 'connect', ...answer });
  await flush();
  return ws;
}

describe('OpenClawGatewayClient auth rejection', () => {
  const realWebSocket = globalThis.WebSocket;
  let randomSpy: jest.SpyInstance<number>;

  beforeEach(() => {
    jest.useFakeTimers();
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    FakeWebSocket.instances = [];
    mockLoadToken.mockReset().mockResolvedValue(null);
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });

  afterEach(() => {
    randomSpy.mockRestore();
    jest.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  test('a refused token is reported as an auth rejection and stops the retry ladder', async () => {
    const statuses: { status: ConnectionStatus; detail?: string; authRejected?: boolean }[] = [];
    const client = new OpenClawGatewayClient(PROFILE, {
      onStatus: (status, detail, info) => statuses.push({ status, detail, authRejected: info?.authRejected }),
    });

    await answerConnect(client, {
      ok: false,
      error: { code: 'AUTH_TOKEN_MISSING', message: 'no token' },
    });

    expect(client.connectionStatus).toBe('disconnected');
    expect(client.authRejected).toBe(true);
    expect(statuses).toContainEqual({
      status: 'disconnected',
      detail: 'Gateway requires setup token or pairing approval',
      authRejected: true,
    });

    // A refusal no amount of retrying can fix: no further socket is dialled.
    jest.advanceTimersByTime(600_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.connectionStatus).toBe('disconnected');
    client.disconnect();
  });

  test('AUTH_TOKEN_NOT_CONFIGURED is the same refusal', async () => {
    const client = new OpenClawGatewayClient(PROFILE, {});

    await answerConnect(client, {
      ok: false,
      error: { code: 'AUTH_TOKEN_NOT_CONFIGURED', message: 'unset' },
    });

    expect(client.authRejected).toBe(true);
    expect(client.statusDetail).toMatch(/setup token or pairing approval/);
    client.disconnect();
  });

  test('a stale pairing token that fails again after its single retry is a rejection too', async () => {
    const client = new OpenClawGatewayClient(PROFILE, {});
    mockLoadToken.mockResolvedValue({ token: 'stale', scopes: ['operator.read'] });

    // First answer: the one retry this client is allowed.
    await answerConnect(client, {
      ok: false,
      error: { code: 'AUTH_DEVICE_TOKEN_MISMATCH', message: 'stale' },
    });
    expect(client.connectionStatus).toBe('reconnecting');
    expect(client.authRejected).toBe(false);

    jest.advanceTimersByTime(1000); // the scheduled retry
    const second = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    second.serverOpen();
    second.serverFrame({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n2' } });
    await flush();
    second.serverFrame({
      type: 'res',
      id: 'connect',
      ok: false,
      error: { code: 'AUTH_DEVICE_TOKEN_MISMATCH', message: 'stale' },
    });
    await flush();

    expect(client.connectionStatus).toBe('disconnected');
    expect(client.authRejected).toBe(true);
    client.disconnect();
  });

  test('a new connect() clears the flag — the operator changed something', async () => {
    const client = new OpenClawGatewayClient(PROFILE, {});

    await answerConnect(client, {
      ok: false,
      error: { code: 'AUTH_TOKEN_MISSING', message: 'no token' },
    });
    expect(client.authRejected).toBe(true);

    client.connect();

    expect(client.authRejected).toBe(false);
    expect(client.connectionStatus).toBe('connecting');
    client.disconnect();
  });

  test('PAIRING_REQUIRED is a pairing state, not a rejected credential', async () => {
    const client = new OpenClawGatewayClient(PROFILE, {});

    await answerConnect(client, {
      ok: false,
      error: { code: 'PAIRING_REQUIRED', message: 'Approval required', details: { requestId: 'req-1' } },
    });

    expect(client.connectionStatus).toBe('pairing');
    expect(client.authRejected).toBe(false);
    client.disconnect();
  });

  test('an ordinary connect failure is not an auth rejection', async () => {
    const statuses: { authRejected?: boolean }[] = [];
    const client = new OpenClawGatewayClient(PROFILE, {
      onStatus: (_status, _detail, info) => statuses.push({ authRejected: info?.authRejected }),
    });

    await answerConnect(client, {
      ok: false,
      error: { code: 'PROTOCOL_UNSUPPORTED', message: 'wire v4 required' },
    });

    expect(client.connectionStatus).toBe('disconnected');
    expect(client.authRejected).toBe(false);
    expect(statuses.some((entry) => entry.authRejected)).toBe(false);
    client.disconnect();
  });

  test('the adapter surfaces the flag the provider reads', async () => {
    const adapter = new OpenClawAdapterClient(PROFILE, {});

    await answerConnect(adapter, {
      ok: false,
      error: { code: 'AUTH_TOKEN_MISSING', message: 'no token' },
    });

    expect(adapter.authRejected).toBe(true);
    adapter.disconnect();
  });
});