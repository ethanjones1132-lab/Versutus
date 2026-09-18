import { fetchGatewayManifest, fetchGatewayManifestWithLookupRetry } from '@/lib/portal/manifest';

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

function lookupMiss(): Error {
  return new TypeError('fetch failed', {
    cause: { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'gate.test' },
  });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
});

describe('manifest fetch with the ordinary DNS fallback', () => {
  test('a hostname lookup miss is retried over an advertised IPv4 and serves the manifest', async () => {
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      calls.push(String(input));
      if (String(input).startsWith('http://gate.test')) throw lookupMiss();
      return Promise.resolve(manifestResponse());
    });

    const manifest = await fetchGatewayManifestWithLookupRetry(
      'http://gate.test',
      ['100.95.137.83'],
    );

    expect(manifest?.kind).toBe('hermes');
    expect(calls).toEqual([
      'http://gate.test/.well-known/gateway.json',
      'http://100.95.137.83/.well-known/gateway.json',
    ]);
  });

  test('a hostname that serves the manifest directly is never probed on the IPv4', async () => {
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      calls.push(String(input));
      return Promise.resolve(manifestResponse());
    });

    const manifest = await fetchGatewayManifestWithLookupRetry(
      'http://gate.test',
      ['100.95.137.83'],
    );

    expect(manifest?.name).toBe('Gate');
    expect(calls).toEqual(['http://gate.test/.well-known/gateway.json']);
  });

  test('a gateway that serves no manifest resolves null with no IPv4 retry', async () => {
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      calls.push(String(input));
      return Promise.resolve(noManifestResponse());
    });

    const manifest = await fetchGatewayManifestWithLookupRetry(
      'http://gate.test',
      ['100.95.137.83'],
    );

    expect(manifest).toBeNull();
    expect(calls).toEqual(['http://gate.test/.well-known/gateway.json']);
  });

  test('a non-lookup failure is not retried onto the IPv4 and resolves null', async () => {
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      calls.push(String(input));
      throw new Error('invalid api key');
    });

    const manifest = await fetchGatewayManifestWithLookupRetry(
      'http://gate.test',
      ['100.95.137.83'],
    );

    expect(manifest).toBeNull();
    expect(calls).toEqual(['http://gate.test/.well-known/gateway.json']);
  });

  test('an https base is never rewritten onto the IPv4', async () => {
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      calls.push(String(input));
      return Promise.resolve(manifestResponse());
    });

    const manifest = await fetchGatewayManifestWithLookupRetry(
      'https://gate.test',
      ['100.95.137.83'],
    );

    expect(manifest?.kind).toBe('hermes');
    expect(calls).toEqual(['https://gate.test/.well-known/gateway.json']);
    expect(calls.join()).not.toContain('100.95.137.83');
  });

  test('an https lookup miss resolves null instead of rewriting onto an IP', async () => {
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      calls.push(String(input));
      throw lookupMiss();
    });

    const manifest = await fetchGatewayManifestWithLookupRetry(
      'https://gate.test',
      ['100.95.137.83'],
    );

    expect(manifest).toBeNull();
    expect(calls).toEqual(['https://gate.test/.well-known/gateway.json']);
  });

  test('an invalid advertised address adds no retry candidate', async () => {
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      calls.push(String(input));
      throw lookupMiss();
    });

    const manifest = await fetchGatewayManifestWithLookupRetry(
      'http://gate.test',
      ['not-an-ip'],
    );

    expect(manifest).toBeNull();
    expect(calls).toEqual(['http://gate.test/.well-known/gateway.json']);
  });
});

describe('plain fetchGatewayManifest still resolves null on every failure', () => {
  test('a lookup miss resolves null', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() => {
      throw lookupMiss();
    });
    expect(await fetchGatewayManifest('http://gate.test')).toBeNull();
  });

  test('a non-ok response resolves null', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(noManifestResponse()),
    );
    expect(await fetchGatewayManifest('http://gate.test')).toBeNull();
  });

  test('a valid manifest is returned when the gateway serves one', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(manifestResponse()),
    );
    const manifest = await fetchGatewayManifest('http://gate.test');
    expect(manifest?.kind).toBe('hermes');
  });
});