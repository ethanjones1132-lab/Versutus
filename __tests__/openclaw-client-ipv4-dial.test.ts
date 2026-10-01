// The profile already carried the gateway's advertised tailnet IPv4 for every
// dialect, and the two HTTP dialects used it (HttpTransport's per-request
// host-lookup retry). The WebSocket dialect ignored it: `openSocket` dialled
// `profile.url` and nothing else, so a MagicDNS name that misses while the
// advertised address works could never connect — on the first attempt or on
// any reconnect.

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
import type { GatewayProfile } from '@/lib/gateway/types';

import { loadDeviceAuthToken } from '@/lib/gateway/device-auth-token';

const mockLoadToken = loadDeviceAuthToken as jest.Mock;

/** Records every dial; a test decides how each one fails. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static failConstructorFor = new Set<string>();
  readonly sent: string[] = [];
  closedByClient = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(readonly url: string) {
    if (FakeWebSocket.failConstructorFor.has(url)) {
      throw new Error(`failed to construct WebSocket to ${url}`);
    }
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

  /** Abort the dial before it ever opened — what a dead name looks like. */
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
  url: 'ws://gate.tailnet.ts.net:8642/openclaw',
  kind: 'openclaw',
  bootstrapToken: 'bootstrap-secret',
  createdAt: 0,
  alternateIpv4: ['100.64.0.9'],
};

const IPV4_URL = 'ws://100.64.0.9:8642/openclaw';

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function helloOk() {
  return {
    type: 'res',
    id: 'connect',
    ok: true,
    payload: { type: 'hello-ok', protocol: 4, server: {} },
  };
}

async function completeHandshake(ws: FakeWebSocket, nonce: string) {
  ws.serverOpen();
  ws.serverFrame({ type: 'event', event: 'connect.challenge', payload: { nonce } });
  await flush();
  ws.serverFrame(helloOk());
  await flush();
}

describe('OpenClawGatewayClient tailnet IPv4 dial', () => {
  const realWebSocket = globalThis.WebSocket;
  let randomSpy: jest.SpyInstance<number>;
  let client: OpenClawGatewayClient;

  beforeEach(() => {
    jest.useFakeTimers();
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    FakeWebSocket.instances = [];
    FakeWebSocket.failConstructorFor = new Set();
    mockLoadToken.mockReset().mockResolvedValue(null);
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    client = new OpenClawGatewayClient(PROFILE, {});
  });

  afterEach(() => {
    randomSpy.mockRestore();
    client.disconnect();
    jest.useRealTimers();
    (globalThis as { WebSocket: unknown }).WebSocket = realWebSocket;
  });

  test('a name that never opens rotates the next dial onto the advertised IPv4', async () => {
    client.connect();
    expect(FakeWebSocket.instances[0].url).toBe(PROFILE.url);

    FakeWebSocket.instances[0].serverClose(1006); // the name missed: no open event

    jest.advanceTimersByTime(1000); // the scheduled retry rung
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe(IPV4_URL);
  });

  test('a constructor that refuses the URL rotates too', () => {
    FakeWebSocket.failConstructorFor.add(PROFILE.url);
    client.connect();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(client.connectionStatus).toBe('reconnecting'); // the ladder owns recovery

    jest.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe(IPV4_URL);
  });

  test('once the IPv4 answers it is tried first on the next reconnect', async () => {
    client.connect();
    FakeWebSocket.instances[0].serverClose(1006);
    jest.advanceTimersByTime(1000);
    await completeHandshake(FakeWebSocket.instances[1], 'n1');
    expect(client.connectionStatus).toBe('connected');

    FakeWebSocket.instances[1].serverClose(1006); // a mid-session drop
    jest.advanceTimersByTime(1000);

    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(FakeWebSocket.instances[2].url).toBe(IPV4_URL);
  });

  test('a socket that opened and answered is not a lookup failure', async () => {
    client.connect();
    const first = FakeWebSocket.instances[0];
    await completeHandshake(first, 'n1');
    first.serverClose(1000, 'gateway restarted'); // closed, but it did open

    jest.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances[1].url).toBe(PROFILE.url);
  });

  test('a profile without an advertised address is dialled exactly as before', () => {
    const plain = new OpenClawGatewayClient({ ...PROFILE, alternateIpv4: undefined }, {});
    plain.connect();
    FakeWebSocket.instances[0].serverClose(1006);

    jest.advanceTimersByTime(1000);
    jest.advanceTimersByTime(2000);
    expect(FakeWebSocket.instances.map((ws) => ws.url)).toEqual([PROFILE.url, PROFILE.url]);
    plain.disconnect();

    // No address left to rotate onto: a constructor throw still ends the
    // attempt outright, exactly as it did before.
    FakeWebSocket.failConstructorFor.add(PROFILE.url);
    const undialable = new OpenClawGatewayClient({ ...PROFILE, alternateIpv4: undefined }, {});
    undialable.connect();
    expect(undialable.connectionStatus).toBe('disconnected');
    expect(FakeWebSocket.instances).toHaveLength(2);
    undialable.disconnect();
  });
});