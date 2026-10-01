// Two failures that used to be silent. `getIdentity()` memoised its promise
// and never cleared it, so one failed SecureStore read poisoned every later
// handshake rung of that client. And the two fire-and-forget token writes had
// no `.catch`, so a failed write lost the pairing silently and surfaced only
// as an unhandled rejection in the diagnostics log.

jest.mock('@/lib/gateway/device-auth-token', () => ({
  loadDeviceAuthToken: jest.fn(),
  saveDeviceAuthToken: jest.fn(() => Promise.resolve()),
  clearDeviceAuthToken: jest.fn(() => Promise.resolve()),
}));

jest.mock('@/lib/gateway/device-identity', () => ({
  loadOrCreateDeviceIdentity: jest.fn(),
  signDevicePayload: jest.fn(() => Promise.resolve('signature')),
}));

import { OpenClawGatewayClient } from '@/lib/gateway/openclaw-client';
import type { GatewayProfile } from '@/lib/gateway/types';

import {
  clearDeviceAuthToken,
  loadDeviceAuthToken,
  saveDeviceAuthToken,
} from '@/lib/gateway/device-auth-token';
import { loadOrCreateDeviceIdentity } from '@/lib/gateway/device-identity';

const mockLoadToken = loadDeviceAuthToken as jest.Mock;
const mockSaveToken = saveDeviceAuthToken as jest.Mock;
const mockClearToken = clearDeviceAuthToken as jest.Mock;
const mockIdentity = loadOrCreateDeviceIdentity as jest.Mock;

const IDENTITY = {
  deviceId: 'device-1',
  publicKeyB64Url: 'public-key',
  privateKeyB64Url: 'private-key',
  createdAtMs: 0,
};

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  closedByClient = false;
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
    this.closedByClient = true;
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

  sentFrames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
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

// Captured before the faked timers go in: an unhandled rejection is reported by
// the process on a real turn of the loop, which a faked one never reaches.
const realSetImmediate = setImmediate;

function challenge(nonce: string) {
  return { type: 'event', event: 'connect.challenge', payload: { nonce } };
}

function helloOk() {
  return {
    type: 'res',
    id: 'connect',
    ok: true,
    payload: {
      type: 'hello-ok',
      protocol: 4,
      server: {},
      auth: { deviceToken: 'dt-1', role: 'operator', scopes: ['operator.read'] },
    },
  };
}

describe('OpenClawGatewayClient identity and token writes', () => {
  const realWebSocket = globalThis.WebSocket;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  let randomSpy: jest.SpyInstance<number>;
  let client: OpenClawGatewayClient;

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    jest.useFakeTimers();
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    FakeWebSocket.instances = [];
    mockLoadToken.mockReset().mockResolvedValue(null);
    mockSaveToken.mockReset().mockResolvedValue(undefined);
    mockClearToken.mockReset().mockResolvedValue(undefined);
    mockIdentity.mockReset().mockResolvedValue(IDENTITY);
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    client = new OpenClawGatewayClient(PROFILE, {});
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    randomSpy.mockRestore();
    client.disconnect();
    jest.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  test('a failed identity read is retried on the next rung instead of poisoning the client', async () => {
    mockIdentity.mockRejectedValueOnce(new Error('keystore locked'));
    client.connect();
    const first = FakeWebSocket.instances[0];
    first.serverOpen();
    first.serverFrame(challenge('n1'));
    await flush();

    expect(first.sent).toHaveLength(0); // the handshake could not be signed
    expect(client.connectionStatus).toBe('reconnecting');

    jest.advanceTimersByTime(1000); // the scheduled retry rung
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1];
    second.serverOpen();
    second.serverFrame(challenge('n2'));
    await flush();

    // The identity was read again, and this rung answered the challenge.
    expect(mockIdentity).toHaveBeenCalledTimes(2);
    const frames = second.sentFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: 'connect', method: 'connect' });
    expect(client.connectionStatus).toBe('reconnecting'); // this rung is alive
  });

  test('a failed device-token write is reported and raises no unhandled rejection', async () => {
    const errors: string[] = [];
    const c = new OpenClawGatewayClient(PROFILE, { onError: (message) => errors.push(message) });
    mockSaveToken.mockRejectedValueOnce(new Error('secure store write failed: key=private-key'));

    c.connect();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverFrame(challenge('n1'));
    await flush();
    ws.serverFrame(helloOk());
    await flush();
    await new Promise((resolve) => realSetImmediate(resolve));

    expect(c.connectionStatus).toBe('connected'); // the connection itself is fine
    expect(errors.join('\n')).toMatch(/pairing token/i);
    expect(errors.join('\n')).not.toMatch(/private-key|secure store/i); // no raw storage text
    expect(unhandled).toEqual([]);
    c.disconnect();
  });

  test('a failed clear of the stale token still reaches the scheduled retry', async () => {
    const errors: string[] = [];
    const c = new OpenClawGatewayClient(PROFILE, { onError: (message) => errors.push(message) });
    mockLoadToken.mockResolvedValue({ token: 'stale', scopes: ['operator.read'] });
    mockClearToken.mockRejectedValueOnce(new Error('secure store refused the delete'));

    c.connect();
    const ws = FakeWebSocket.instances[0];
    ws.serverOpen();
    ws.serverFrame(challenge('n1'));
    await flush();
    ws.serverFrame({
      type: 'res',
      id: 'connect',
      ok: false,
      error: { code: 'AUTH_DEVICE_TOKEN_MISMATCH', message: 'stale' },
    });
    await flush();
    await new Promise((resolve) => realSetImmediate(resolve));

    expect(errors.join('\n')).toMatch(/pairing token/i);
    expect(unhandled).toEqual([]);
    expect(c.connectionStatus).toBe('reconnecting');

    jest.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2); // the retry still happened
    c.disconnect();
  });
});