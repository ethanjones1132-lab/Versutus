// A WebSocket can go half-open without ever delivering a close frame (Wi-Fi
// drop, silent tailnet path change). This dialect had no probe at all: the
// monitor was constructed with none and never started, healthCheck() answered
// "ok" straight from the local status flag, and nothing ever fired
// onHealthCheck — so a dead socket read as a live session until each request
// timed out on its own 30s budget, and a reconnect never re-read the thread.

// The adapter remembers the sessions it owns through key-value storage, and
// key-value pulls in AsyncStorage's native module.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

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
import type { HealthResponse } from '@/lib/gateway/types';

import { loadDeviceAuthToken } from '@/lib/gateway/device-auth-token';

const mockLoadToken = loadDeviceAuthToken as jest.Mock;

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

  serverClose(code = 1006, reason = '') {
    this.onclose?.({ code, reason });
  }

  serverFrame(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  frames(method: string): Record<string, unknown>[] {
    return this.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.method === method);
  }

  sentFrames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

const PROFILE = {
  id: 'gw1',
  name: 'OpenClaw gate',
  url: 'ws://gate.test:8642/openclaw',
  kind: 'openclaw',
  bootstrapToken: 'bootstrap-secret',
  createdAt: 0,
} as const;

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

function helloOk() {
  return {
    type: 'res',
    id: 'connect',
    ok: true,
    payload: {
      type: 'hello-ok',
      protocol: 4,
      server: { version: '0.9.1' },
      auth: { deviceToken: 'dt-1', role: 'operator', scopes: ['operator.read'] },
    },
  };
}

/** Connect and complete the handshake; returns the live, healthy socket. */
async function connected(client: { connect: () => void }): Promise<FakeWebSocket> {
  client.connect();
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.serverOpen();
  ws.serverFrame({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n1' } });
  await flush();
  ws.serverFrame(helloOk());
  await flush();
  return ws;
}

describe('OpenClawGatewayClient liveness', () => {
  const realWebSocket = globalThis.WebSocket;
  let randomSpy: jest.SpyInstance<number>;
  let client: OpenClawGatewayClient;

  beforeEach(() => {
    jest.useFakeTimers();
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    FakeWebSocket.instances = [];
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

  test('a healthy socket answers the probe with a real frame on the wire', async () => {
    const health: (boolean | undefined)[] = [];
    const c = new OpenClawGatewayClient(PROFILE, {
      onHealthCheck: (healthy) => health.push(healthy),
    });
    const ws = await connected(c);

    const alive = c.probeLiveness(5000);
    const frame = ws.frames('capabilities').at(-1);
    expect(frame).toBeDefined();
    ws.serverFrame({ type: 'res', id: frame?.id as string, ok: true, payload: { models: [] } });

    await expect(alive).resolves.toBe(true);
    expect(health).toEqual([true]);
    c.disconnect();
  });

  test('a probe settles true on an ok:false refusal — the gateway is talking', async () => {
    const c = new OpenClawGatewayClient(PROFILE, {});
    const ws = await connected(c);

    const alive = c.probeLiveness(5000);
    const frame = ws.frames('capabilities').at(-1);
    expect(frame).toBeDefined();
    ws.serverFrame({
      type: 'res',
      id: frame?.id as string,
      ok: false,
      error: { code: 'UNKNOWN_METHOD', message: 'no such method' },
    });

    await expect(alive).resolves.toBe(true);
    c.disconnect();
  });

  test('a silent socket fails the probe on its timeout and the monitor declares it down', async () => {
    const health: boolean[] = [];
    const statuses: [string, string][] = [];
    const c = new OpenClawGatewayClient(PROFILE, {
      onHealthCheck: (healthy) => health.push(healthy),
      onStatus: (status, detail) => statuses.push([status, detail ?? '']),
    });
    const ws = await connected(c);
    // The socket stops answering and never closes. Nothing but a probe can see it.
    ws.send = (data: string) => {
      ws.sent.push(data);
    };

    // Two interval samples, each bounded by the 5s probe budget: tick at 30s
    // (times out at 35s), tick at 60s (times out at 65s).
    for (const step of [30_000, 5_000, 25_000, 5_000]) {
      jest.advanceTimersByTime(step);
      await flush();
    }

    expect(ws.frames('capabilities')).toHaveLength(2);
    expect(c.connectionStatus).toBe('reconnecting');
    expect(c.statusDetail).toMatch(/unreachable/i);
    expect(health).toContain(false);
    c.disconnect();
  });

  test('two quick nudges reach reconnecting in seconds, not after the interval', async () => {
    const c = new OpenClawGatewayClient(PROFILE, {});
    const ws = await connected(c);
    ws.send = (data: string) => {
      ws.sent.push(data);
    };

    c.nudge('stalled stream');
    jest.advanceTimersByTime(5_000); // first probe times out
    await flush();
    expect(c.connectionStatus).toBe('connected'); // one lost sample is not a verdict

    jest.advanceTimersByTime(2_000); // nudge re-proves immediately
    await flush();
    jest.advanceTimersByTime(5_000); // second probe times out
    await flush();

    expect(c.connectionStatus).toBe('reconnecting');
    expect(ws.frames('capabilities').length).toBeGreaterThanOrEqual(2);
    c.disconnect();
  });

  test('a request unanswered for its budget nudges the monitor too', async () => {
    const c = new OpenClawGatewayClient(PROFILE, {});
    const ws = await connected(c);
    ws.send = (data: string) => {
      ws.sent.push(data);
    };

    // The budget is the test's, not the client's default: what matters is that an
    // unanswered request buys a verdict on the caller's evidence rather than
    // after the 30s interval.
    void c.request('sessions.list', {}, 4_000).catch(() => undefined);
    await flush(); // the request reaches the wire
    jest.advanceTimersByTime(4_000); // the request's budget runs out → nudge
    await flush();
    expect(ws.frames('capabilities')).toHaveLength(1);

    for (const step of [5_000, 2_000, 5_000]) {
      jest.advanceTimersByTime(step); // probe budget, nudge re-prove, probe budget
      await flush();
    }

    expect(c.connectionStatus).toBe('reconnecting');
    c.disconnect();
  });

  test('forceReconnect re-verifies in place and reports the check', () => {
    const statuses: [string, string][] = [];
    const c = new OpenClawGatewayClient(PROFILE, {
      onStatus: (status, detail) => statuses.push([status, detail ?? '']),
    });
    c.connect();
    const first = FakeWebSocket.instances[0];

    c.forceReconnect();

    expect(statuses).toContainEqual(['reconnecting', 'Checking the connection']);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(first.closedByClient).toBe(true); // retired in place, not orphaned
    expect(FakeWebSocket.instances[1].closedByClient).toBe(false);
    c.disconnect();
  });

  test('onHealthCheck(true) fires on every completed handshake, so a reconnect reloads the thread', async () => {
    const health: { healthy: boolean; info?: HealthResponse }[] = [];
    const c = new OpenClawGatewayClient(PROFILE, {
      onHealthCheck: (healthy, info) => health.push({ healthy, info }),
    });

    const first = await connected(c);
    expect(health).toEqual([
      { healthy: true, info: { status: 'ok', platform: 'openclaw', version: '0.9.1' } },
    ]);

    first.serverClose(1006); // mid-session drop → a retry is queued
    jest.advanceTimersByTime(1000);
    const second = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    second.serverOpen();
    second.serverFrame({ type: 'event', event: 'connect.challenge', payload: { nonce: 'n2' } });
    await flush();
    second.serverFrame(helloOk());
    await flush();

    expect(health).toHaveLength(2);
    expect(health[1].healthy).toBe(true);
    c.disconnect();
  });

  test('an explicit disconnect stops the probe interval', async () => {
    const c = new OpenClawGatewayClient(PROFILE, {});
    const ws = await connected(c);

    jest.advanceTimersByTime(30_000); // one live interval sample
    await flush();
    const whileConnected = ws.frames('capabilities').length;
    expect(whileConnected).toBeGreaterThanOrEqual(1);

    c.disconnect();
    jest.advanceTimersByTime(120_000);
    await flush();

    expect(ws.frames('capabilities')).toHaveLength(whileConnected);
    expect(c.connectionStatus).toBe('disconnected');
    c.disconnect();
  });
});

describe('OpenClawAdapterClient healthCheck', () => {
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

  test('a live socket answers the health check with a frame on the wire', async () => {
    const adapter = new OpenClawAdapterClient(PROFILE, {});
    const ws = await connected(adapter);
    // The adapter already fetched capabilities on hello; the health check must
    // put a frame of its own on the wire, not read the local status flag.
    const before = ws.frames('capabilities').length;

    const health = adapter.healthCheck(5000);
    await flush();
    expect(ws.frames('capabilities')).toHaveLength(before + 1);
    const probeFrame = ws.frames('capabilities').at(-1);
    expect(probeFrame).toBeDefined();
    ws.serverFrame({
      type: 'res',
      id: probeFrame?.id as string,
      ok: true,
      payload: { platform: 'openclaw' },
    });

    await expect(health).resolves.toEqual({
      status: 'ok',
      platform: 'openclaw',
      version: '0.9.1',
    });
    adapter.disconnect();
  });

  test('the adapter forwards the provider\'s health callback through to the wire', async () => {
    const health: { healthy: boolean; platform?: string }[] = [];
    const adapter = new OpenClawAdapterClient(PROFILE, {
      onHealthCheck: (ok, info) => health.push({ healthy: ok, platform: info?.platform }),
    });

    await connected(adapter);

    // The provider's reconnect-time history reload hangs off this channel.
    expect(health).toEqual([{ healthy: true, platform: 'openclaw' }]);
    adapter.disconnect();
  });

  test('a socket that stops answering reports unhealthy instead of a fabricated ok', async () => {
    // Never connected: nothing on the wire, and no fabricated ok either.
    const idle = new OpenClawAdapterClient(PROFILE, {});
    await expect(idle.healthCheck()).resolves.toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
    idle.disconnect();

    const adapter = new OpenClawAdapterClient(PROFILE, {});
    const ws = await connected(adapter);
    ws.send = (data: string) => {
      ws.sent.push(data);
    };

    const pending = adapter.healthCheck(5000);
    jest.advanceTimersByTime(5000);

    await expect(pending).resolves.toBeNull();
    adapter.disconnect();
  });

  test('the adapter exposes nudge and forceReconnect for the provider heal', async () => {
    const adapter = new OpenClawAdapterClient(PROFILE, {});
    const ws = await connected(adapter);
    ws.send = (data: string) => {
      ws.sent.push(data);
    };

    adapter.nudge('stalled stream');
    jest.advanceTimersByTime(5000);
    await flush();
    jest.advanceTimersByTime(2000);
    await flush();
    jest.advanceTimersByTime(5000);
    await flush();
    expect(adapter.connectionStatus).toBe('reconnecting');

    adapter.forceReconnect();
    expect(adapter.connectionStatus).toBe('reconnecting');
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    adapter.disconnect();
  });
});