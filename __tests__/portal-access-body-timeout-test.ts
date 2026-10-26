// The access-request deadline stays armed through response-body consumption.
// Headers resolving used to clear the abort timer before response.json(), so a
// stalled body hung the add/pair sheet. These tests pin that the same deadline
// still settles a body that never arrives, and that a grant, a denial and a
// status-line 404 still clear the timer.

jest.mock('@/lib/gateway/device-identity', () => ({
  loadOrCreateDeviceIdentity: jest.fn(async () => ({
    deviceId: 'device-abc',
    publicKeyB64Url: 'public-key',
  })),
  signDevicePayload: jest.fn(async () => 'signed-payload'),
}));

// access.ts also imports the OpenClaw client for the WS pairing dialect; its
// storage chain pulls RN async-storage which has no jest shim here. The fake
// records the profile it was handed and answers the handshake, so the probe's
// own wiring can be inspected without a socket.
const mockOpenclawProfiles: Record<string, unknown>[] = [];
jest.mock('@/lib/gateway/openclaw-client', () => ({
  OpenClawGatewayClient: class {
    callbacks: { onHello?: (hello: unknown) => void };
    constructor(profile: Record<string, unknown>, callbacks: { onHello?: (hello: unknown) => void }) {
      mockOpenclawProfiles.push(profile);
      this.callbacks = callbacks;
    }
    connect() {
      this.callbacks.onHello?.({ auth: { deviceToken: 'dt-1', role: 'operator' } });
    }
    disconnect() {}
  },
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        gatewayHosts: ['gate.test', '192.168.1.30', 'not-an-ip', '100.101.102.103'],
      },
    },
  },
}));

import { resetHostLookupMemoryForTests } from '@/lib/gateway/host-lookup';
import { requestGatewayAccess, type AccessRequestResult } from '@/lib/portal/access';
import type { GatewayIdentity } from '@/lib/portal/identify';

function manifestIdentity(overrides: Partial<GatewayIdentity> = {}): GatewayIdentity {
  return {
    kind: 'custom',
    kindLabel: 'Custom — Test',
    manifest: {
      manifest: 'versutus-gateway/v1',
      kind: 'test',
      auth: { schemes: ['challenge-response'], grantPath: '/grant' },
      transport: { ipv4: ['100.101.102.103'] },
    },
    auth: { schemes: ['challenge-response'], requiresToken: true, grantPath: '/grant' },
    transportHint: 'http',
    source: 'manifest',
    identifiedAt: Date.now(),
    ...overrides,
  };
}

function response(init: { ok: boolean; status: number; body: unknown }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: () => Promise.resolve(init.body),
  } as unknown as Response;
}

function grantedResponse(): Response {
  return response({
    ok: true,
    status: 200,
    body: { status: 'granted', token: 'dt-1', role: 'operator', scopes: ['chat:send', 'runs:start'] },
  });
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  // The host-lookup failure memory is module-level; without this a marked
  // hostname from one test would reorder the next test's IPv4-first retry.
  resetHostLookupMemoryForTests();
  mockOpenclawProfiles.length = 0;
});
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  jest.restoreAllMocks();
  resetHostLookupMemoryForTests();
});

describe('the access request deadline stays armed until the response body is read', () => {
  // A gateway can answer the signed POST with a status line and then stall the
  // body. The abort timer used to be cleared as soon as fetch resolved, so
  // `response.json()` had no deadline and the add/pair sheet sat in its saving
  // state until the operator left the screen. The body read now races the same
  // deadline: a stalled body is a dead path ("unreachable"), never a denial,
  // and the timer is cleared on every terminal path.

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  async function flushMicrotasks(): Promise<void> {
    // Only promise hops here — the fetch mock resolves immediately, so the
    // request reaches its body read without any timer being advanced.
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
  }

  test('headers that arrive and a body that never settles time out as a dead path', async () => {
    let bodyRequested = false;
    const fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => {
          bodyRequested = true;
          return new Promise<never>(() => {});
        },
      } as unknown as Response),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    let settled: AccessRequestResult | undefined;
    const request = requestGatewayAccess({
      baseUrl: 'http://gate.test',
      identity: manifestIdentity(),
      timeoutMs: 10_000,
    }).then((result) => {
      settled = result;
      return result;
    });

    // Headers resolved and the body read is underway — the exact moment the old
    // implementation disarmed its timer and the request became unbounded.
    await flushMicrotasks();
    expect(bodyRequested).toBe(true);
    expect(settled).toBeUndefined();

    await jest.advanceTimersByTimeAsync(10_000);
    await flushMicrotasks();

    // The existing timeout contract: nothing answered, so the path is dead.
    expect(settled).toEqual({
      status: 'unreachable',
      reason: 'The access request timed out before the gateway answered.',
    });
    await request;
    // A timeout is not the gate refusing a signature, so nothing is retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a body that arrives inside the deadline still grants, and the timer is cleared', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise<Record<string, unknown>>((resolve) => {
            setTimeout(() => resolve({ status: 'granted', token: 'dt-1', role: 'operator' }), 500);
          }),
      } as unknown as Response),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const request = requestGatewayAccess({
      baseUrl: 'http://gate.test',
      identity: manifestIdentity(),
      timeoutMs: 10_000,
    });

    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(500);

    await expect(request).resolves.toMatchObject({
      status: 'granted',
      token: 'dt-1',
      role: 'operator',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a grant read before the deadline resolves granted and leaves no timer armed', async () => {
    const fetchMock = jest.fn(() => Promise.resolve(grantedResponse()));
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const result = await requestGatewayAccess({
      baseUrl: 'http://gate.test',
      identity: manifestIdentity(),
      timeoutMs: 10_000,
    });

    expect(result).toEqual({
      status: 'granted',
      token: 'dt-1',
      role: 'operator',
      scopes: ['chat:send', 'runs:start'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a denial read before the deadline stays a denial and clears the timer', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        response({
          ok: false,
          status: 403,
          body: { status: 'denied', reason: 'This device is not on the allowlist.' },
        }),
      ),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const result = await requestGatewayAccess({
      baseUrl: 'http://gate.test',
      identity: manifestIdentity(),
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ status: 'denied', reason: 'This device is not on the allowlist.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a 404 is still answered by its status line without waiting for a stalled body', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => new Promise<never>(() => {}),
      } as unknown as Response),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    // No timer is advanced: a 404/405 is a verdict from the status line alone,
    // exactly as before, so a body that never settles cannot change it.
    const result = await requestGatewayAccess({
      baseUrl: 'http://gate.test',
      identity: manifestIdentity(),
      timeoutMs: 10_000,
    });

    expect(result.status).toBe('token-required');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
