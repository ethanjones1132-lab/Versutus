// ─── Gateway identification retries a MagicDNS miss over tailnet IPv4s ─────
// identifyGateway walked bare fetch + bare probes, so a hostname lookup miss
// before any client existed (manual add, first connect) silently skipped the
// manifest and every fingerprint. It now takes an injected alternate-address
// set, retries the manifest and the Hermes probes over it on a lookup miss,
// folds in whatever IPv4s the served manifest advertised, and never rewrites
// an https base or a URL that belongs to another gateway.

import { identifyGateway } from '@/lib/portal/identify';

const MANIFEST = {
  manifest: 'versutus-gateway/v1',
  kind: 'hermes',
  name: 'Gate',
};

function manifestResponse(): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(MANIFEST)),
  } as unknown as Response;
}

function noManifestResponse(): Response {
  return {
    ok: false,
    status: 404,
    text: () => Promise.resolve('{}'),
  } as unknown as Response;
}

function hermesHealthResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ status: 'ok', platform: 'hermes' }),
  } as unknown as Response;
}

function hermesCapsResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ object: 'hermes', auth: { required: true } }),
  } as unknown as Response;
}

function lookupMiss(): Error {
  return new TypeError('fetch failed', {
    cause: { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'gate.test' },
  });
}

const realFetch = globalThis.fetch;
const realWebSocket: unknown = globalThis.WebSocket;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
});

function withoutWebSocket() {
  (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
}

function recordingFetch(calls: string[], handler: (url: string) => Promise<Response>) {
  return jest.fn((input: unknown) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  });
}

describe('identifyGateway retries a MagicDNS miss over tailnet IPv4s', () => {
  test('a manifest lookup miss is retried over the injected IPv4 and identifies the gate', async () => {
    withoutWebSocket();
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = recordingFetch(calls, (url) => {
      if (url.startsWith('http://gate.test')) throw lookupMiss();
      return Promise.resolve(manifestResponse());
    });

    const identity = await identifyGateway({
      baseUrl: 'http://gate.test',
      alternateIpv4: ['100.95.137.83'],
    });

    expect(identity.kind).toBe('hermes');
    expect(identity.source).toBe('manifest');
    // The retry rewrites only the host name — the same manifest path, never
    // some other gateway's address.
    expect(calls).toEqual([
      'http://gate.test/.well-known/gateway.json',
      'http://100.95.137.83/.well-known/gateway.json',
    ]);
  });

  test('a hostname that serves the manifest directly is never probed on the IPv4', async () => {
    withoutWebSocket();
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = recordingFetch(calls, () =>
      Promise.resolve(manifestResponse()),
    );

    const identity = await identifyGateway({
      baseUrl: 'http://gate.test',
      alternateIpv4: ['100.95.137.83'],
    });

    expect(identity.source).toBe('manifest');
    expect(calls).toEqual(['http://gate.test/.well-known/gateway.json']);
  });

  test('a full lookup miss still identifies a Hermes gate over its tailnet IPv4', async () => {
    withoutWebSocket();
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = recordingFetch(calls, (url) => {
      if (url.startsWith('http://gate.test')) throw lookupMiss();
      if (url.endsWith('/.well-known/gateway.json')) return Promise.resolve(noManifestResponse());
      if (url.endsWith('/health')) return Promise.resolve(hermesHealthResponse());
      return Promise.resolve(hermesCapsResponse());
    });

    const identity = await identifyGateway({
      baseUrl: 'http://gate.test',
      alternateIpv4: ['100.95.137.83'],
    });

    expect(identity.kind).toBe('hermes');
    expect(identity.source).toBe('probe-hermes');
    // Hostname misses once for the manifest and once for the fingerprint; the
    // IPv4 then serves the full Hermes read.
    expect(calls).toEqual([
      'http://gate.test/.well-known/gateway.json',
      'http://100.95.137.83/.well-known/gateway.json',
      'http://gate.test/health',
      'http://100.95.137.83/health',
      'http://100.95.137.83/v1/capabilities',
    ]);
  });

  test('an https base keeps its hostname and is never probed on any IPv4', async () => {
    withoutWebSocket();
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = recordingFetch(calls, () => {
      throw lookupMiss();
    });

    const identity = await identifyGateway({
      baseUrl: 'https://gate.test',
      alternateIpv4: ['100.95.137.83'],
    });

    expect(identity.kind).toBe('unknown');
    expect(calls.every((url) => url.startsWith('https://gate.test'))).toBe(true);
    expect(calls.join()).not.toContain('100.95.137.83');
  });

  test('a gate that answers nothing anywhere still resolves to an honest unknown identity', async () => {
    withoutWebSocket();
    (globalThis as { fetch: unknown }).fetch = jest.fn(() => {
      throw lookupMiss();
    });

    const identity = await identifyGateway({
      baseUrl: 'http://gate.test',
      alternateIpv4: ['100.95.137.83'],
    });

    expect(identity.kind).toBe('unknown');
    expect(identity.source).toBe('unknown');
    expect(identity.transportHint).toBeUndefined();
  });

  test('an invalid entry in the alternate-address set adds no retry candidate', async () => {
    withoutWebSocket();
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = recordingFetch(calls, () => {
      throw lookupMiss();
    });

    const identity = await identifyGateway({
      baseUrl: 'http://gate.test',
      alternateIpv4: ['not-an-ip'],
    });

    expect(identity.kind).toBe('unknown');
    expect(calls.filter((url) => url.includes('not-an-ip'))).toHaveLength(0);
  });

  test('an empty alternate set leaves the cascade on the hostname only', async () => {
    withoutWebSocket();
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = recordingFetch(calls, () => {
      throw lookupMiss();
    });

    const identity = await identifyGateway({ baseUrl: 'http://gate.test' });

    expect(identity.kind).toBe('unknown');
    expect(calls.every((url) => url.startsWith('http://gate.test'))).toBe(true);
  });
});