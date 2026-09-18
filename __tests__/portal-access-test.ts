// ─── Signed universal access request travels the bounded host-lookup transport ──
// The signed POST that asks a gate for access ran over a bare fetch, so a
// MagicDNS miss right after identity discovery failed the request even though
// the gate's advertised tailnet IPv4 was still fine. It now retries the same
// candidates ordinary Gate requests use — what the manifest advertised and the
// configured hosts — and only for a lookup miss. The signed body and device
// identity are identical on every attempt; https is never rewritten; a real
// denial answers once.

jest.mock('@/lib/gateway/device-identity', () => ({
  loadOrCreateDeviceIdentity: async () => ({
    deviceId: 'device-abc',
    publicKeyB64Url: 'public-key',
  }),
  signDevicePayload: async () => 'signed-payload',
}));

// access.ts also imports the OpenClaw client for the WS pairing dialect; its
// storage chain pulls RN async-storage which has no jest shim here.
jest.mock('@/lib/gateway/openclaw-client', () => ({
  OpenClawGatewayClient: class {
    connect() {}
    disconnect() {}
  },
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: {
    expoConfig: {
      extra: {
        gatewayHosts: ['gate.test', '192.168.4.30', 'not-an-ip', '100.95.137.83'],
      },
    },
  },
}));

import { requestGatewayAccess } from '@/lib/portal/access';
import type { GatewayIdentity } from '@/lib/portal/identify';

function manifestIdentity(overrides: Partial<GatewayIdentity> = {}): GatewayIdentity {
  return {
    kind: 'custom',
    kindLabel: 'Custom — Test',
    manifest: {
      manifest: 'versutus-gateway/v1',
      kind: 'test',
      auth: { schemes: ['challenge-response'], grantPath: '/grant' },
      transport: { ipv4: ['100.95.137.83'] },
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
    body: { status: 'granted', token: 'device-token-1', role: 'operator', scopes: ['chat:send', 'runs:start'] },
  });
}

function lookupMiss(): Error {
  return new TypeError('fetch failed', {
    cause: { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'gate.test' },
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  jest.restoreAllMocks();
});

function recordCall(calls: { url: string; body: unknown }[], input: unknown, init: unknown) {
  calls.push({
    url: String(input),
    body: JSON.parse(String((init as { body?: string } | undefined)?.body ?? '{}')),
  });
}

describe('a signed access request retries a lookup miss over the fallback IPv4s', () => {
  test('the hostname miss is retried over the manifest-advertised IPv4 and grants', async () => {
    const calls: { url: string; body: unknown }[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init: unknown) => {
      recordCall(calls, input, init);
      if (String(input).startsWith('http://gate.test/grant')) throw lookupMiss();
      return Promise.resolve(grantedResponse());
    });

    const result = await requestGatewayAccess({
      baseUrl: 'http://gate.test',
      identity: manifestIdentity(),
    });

    expect(result).toEqual({
      status: 'granted',
      token: 'device-token-1',
      role: 'operator',
      scopes: ['chat:send', 'runs:start'],
    });
    expect(calls.map((c) => c.url)).toEqual([
      'http://gate.test/grant',
      'http://100.95.137.83/grant',
    ]);
  });

  test('the configured hosts join the retry when the manifest advertises nothing', async () => {
    const calls: { url: string; body: unknown }[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init: unknown) => {
      recordCall(calls, input, init);
      if (String(input) !== 'http://100.95.137.83/grant') throw lookupMiss();
      return Promise.resolve(grantedResponse());
    });

    const identity = manifestIdentity({
      manifest: {
        manifest: 'versutus-gateway/v1',
        kind: 'test',
        auth: { schemes: ['challenge-response'], grantPath: '/grant' },
      },
    });

    const result = await requestGatewayAccess({
      baseUrl: 'http://gate.test',
      identity,
    });

    expect(result.status).toBe('granted');
    // Advertised first (none here), then the expo-extra configured hosts, with
    // hostnames and malformed entries dropped — exactly the set the adapters
    // install on a profile.
    expect(calls.map((c) => c.url)).toEqual([
      'http://gate.test/grant',
      'http://192.168.4.30/grant',
      'http://100.95.137.83/grant',
    ]);
  });

  test('a live hostname answers once and never visits the IPv4s', async () => {
    const calls: { url: string; body: unknown }[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init: unknown) => {
      recordCall(calls, input, init);
      return Promise.resolve(grantedResponse());
    });

    const result = await requestGatewayAccess({
      baseUrl: 'http://gate.test',
      identity: manifestIdentity(),
    });

    expect(result.status).toBe('granted');
    expect(calls.map((c) => c.url)).toEqual(['http://gate.test/grant']);
  });

  test('an https base is never rewritten onto an IPv4', async () => {
    const calls: { url: string; body: unknown }[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init: unknown) => {
      recordCall(calls, input, init);
      throw lookupMiss();
    });

    const result = await requestGatewayAccess({
      baseUrl: 'https://gate.test',
      identity: manifestIdentity(),
    });

    expect(result.status).toBe('denied');
    expect(calls.map((c) => c.url)).toEqual(['https://gate.test/grant']);
    expect(calls.join()).not.toContain('100.95.137.83');
    expect(String((result as { reason: string }).reason)).toMatch(/could not look up/i);
  });

  test('a non-lookup failure is not retried and resolves denied once', async () => {
    const calls: { url: string; body: unknown }[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init: unknown) => {
      recordCall(calls, input, init);
      throw new Error('invalid api key');
    });

    const result = await requestGatewayAccess({
      baseUrl: 'http://gate.test',
      identity: manifestIdentity(),
    });

    expect(result).toEqual({ status: 'denied', reason: 'invalid api key' });
    expect(calls).toHaveLength(1);
  });

  test('the signed body and device identity are identical on the retry', async () => {
    const calls: { url: string; body: unknown }[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init: unknown) => {
      recordCall(calls, input, init);
      if (String(input).startsWith('http://gate.test/grant')) throw lookupMiss();
      return Promise.resolve(grantedResponse());
    });

    await requestGatewayAccess({
      baseUrl: 'http://gate.test',
      identity: manifestIdentity(),
      role: 'auditor',
      scopes: ['chat:read'],
    });

    expect(calls).toHaveLength(2);
    const first = calls[0].body as Record<string, unknown>;
    const second = calls[1].body as Record<string, unknown>;
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      manifest: 'versutus-gateway/v1',
      role: 'auditor',
      scopes: ['chat:read'],
      signedAtMs: expect.any(Number),
      signature: 'signed-payload',
      device: { id: 'device-abc', publicKey: 'public-key' },
    });
  });
});

describe('a denial or refusal is answered once, never written a second time', () => {
  test('a real 403 denial resolves denied with the gate reason and no second POST', async () => {
    const calls: { url: string; body: unknown }[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init: unknown) => {
      recordCall(calls, input, init);
      return Promise.resolve(
        response({
          ok: false,
          status: 403,
          body: { status: 'denied', reason: 'This device is not on the allowlist.' },
        }),
      );
    });

    const result = await requestGatewayAccess({
      baseUrl: 'http://gate.test',
      identity: manifestIdentity(),
    });

    expect(result).toEqual({ status: 'denied', reason: 'This device is not on the allowlist.' });
    expect(calls).toHaveLength(1);
  });

  test('a pending approval is reported with the requestId hint and no second POST', async () => {
    const calls: { url: string; body: unknown }[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init: unknown) => {
      recordCall(calls, input, init);
      return Promise.resolve(
        response({ ok: false, status: 202, body: { status: 'pending', requestId: 'req-42' } }),
      );
    });

    const result = await requestGatewayAccess({
      baseUrl: 'http://gate.test',
      identity: manifestIdentity(),
    });

    expect(result.status).toBe('pending-approval');
    expect(`${(result as { hint?: string }).hint}`).toContain('pair approve req-42');
    expect(calls).toHaveLength(1);
  });

  test('a 404 stays token-required and never retries onto an IP', async () => {
    const calls: { url: string; body: unknown }[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init: unknown) => {
      recordCall(calls, input, init);
      return Promise.resolve(response({ ok: false, status: 404, body: {} }));
    });

    const result = await requestGatewayAccess({
      baseUrl: 'http://gate.test',
      identity: manifestIdentity(),
    });

    expect(result.status).toBe('token-required');
    expect(calls).toHaveLength(1);
  });
});