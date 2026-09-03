import { HermesGatewayClient } from '@/lib/gateway/client';
import type { GatewayProfile } from '@/lib/gateway/types';

const PROFILE: GatewayProfile = {
  id: 'g1', name: 'Test gateway', url: 'http://gateway.test:8642',
  kind: 'hermes', token: 'k', createdAt: 0,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const NATIVE_OPTIONS = {
  providers: [
    { slug: 'opencode', name: 'OpenCode', authenticated: true, models: ['zen', 'laguna'] },
  ],
};

const GATE_MODELS = {
  object: 'list',
  data: [{ id: 'hermes-agent', object: 'model', owned_by: 'hermes' }],
};

/**
 * A Gate serves only /v1/* and 404s GET /api/model/options; a direct Hermes
 * host serves the native options path. The client used to lead with the
 * native path on every read, so each Gate model read paid two requests.
 * It now remembers the dialect that answered, per connection.
 */
function mockModelHost(opts: { api: number; v1: number; apiBody?: unknown; v1Body?: unknown }) {
  const calls: string[] = [];
  const fetchMock = jest.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/api/model/options')) {
      calls.push('/api/model/options');
      if (opts.api === 200) return Promise.resolve(jsonResponse(opts.apiBody ?? NATIVE_OPTIONS));
      return Promise.resolve(jsonResponse({ error: 'Not Found' }, opts.api));
    }
    if (url.includes('/v1/models')) {
      calls.push('/v1/models');
      if (opts.v1 === 200) return Promise.resolve(jsonResponse(opts.v1Body ?? GATE_MODELS));
      return Promise.resolve(jsonResponse({ error: 'Not Found' }, opts.v1));
    }
    return Promise.resolve(jsonResponse({}));
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return calls;
}

function count(calls: string[], path: string) {
  return calls.filter((c) => c === path).length;
}

describe('getModels remembers the host dialect per connection', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('against a Gate the second read costs one request instead of two', async () => {
    const calls = mockModelHost({ api: 404, v1: 200 });
    const client = new HermesGatewayClient(PROFILE, {});

    const first = await client.getModels();
    expect(first).toHaveLength(1);
    expect(first[0].id).toBe('hermes-agent');
    expect(count(calls, '/api/model/options')).toBe(1);
    expect(count(calls, '/v1/models')).toBe(1);

    calls.length = 0;
    const second = await client.getModels();
    expect(second).toHaveLength(1);
    expect(count(calls, '/api/model/options')).toBe(0);
    expect(count(calls, '/v1/models')).toBe(1);

    client.disconnect();
  });

  test('against direct Hermes the full provider catalog wins over the single compatibility model', async () => {
    const calls = mockModelHost({ api: 200, v1: 200 });
    const client = new HermesGatewayClient(PROFILE, {});

    const first = await client.getModels();
    expect(first.map((m) => m.id).sort()).toEqual(['opencode/laguna', 'opencode/zen']);
    // The native path answers, so /v1/models is never consulted.
    expect(count(calls, '/api/model/options')).toBe(1);
    expect(count(calls, '/v1/models')).toBe(0);

    calls.length = 0;
    const second = await client.getModels();
    expect(second.map((m) => m.id).sort()).toEqual(['opencode/laguna', 'opencode/zen']);
    expect(count(calls, '/api/model/options')).toBe(1);
    expect(count(calls, '/v1/models')).toBe(0);

    client.disconnect();
  });

  test('a transient native failure does not pin the client to the compatibility model', async () => {
    const calls = mockModelHost({ api: 500, v1: 200 });
    const client = new HermesGatewayClient(PROFILE, {});

    await client.getModels();
    expect(count(calls, '/api/model/options')).toBe(1);
    expect(count(calls, '/v1/models')).toBe(1);

    // A 500 is not a dialect signal: the next read still leads with the
    // native path instead of serving /v1/models alone.
    calls.length = 0;
    await client.getModels();
    expect(count(calls, '/api/model/options')).toBe(1);
    expect(count(calls, '/v1/models')).toBe(1);

    client.disconnect();
  });

  test('switching gateway profiles re-identifies the dialect', async () => {
    const calls = mockModelHost({ api: 404, v1: 200 });
    const client = new HermesGatewayClient(PROFILE, {});

    await client.getModels();
    calls.length = 0;
    await client.getModels();
    // Identified as a Gate: one request.
    expect(count(calls, '/api/model/options')).toBe(0);
    expect(count(calls, '/v1/models')).toBe(1);

    // A new endpoint may speak the other dialect, so the next read probes
    // the native path again instead of assuming the Gate dialect.
    client.updateProfile({ ...PROFILE, url: 'http://other.test:8642' });
    calls.length = 0;
    await client.getModels();
    expect(count(calls, '/api/model/options')).toBe(1);

    client.disconnect();
  });

  test('a non-404 Gate refusal surfaces instead of retrying another dialect', async () => {
    const calls = mockModelHost({ api: 404, v1: 200 });
    const client = new HermesGatewayClient(PROFILE, {});
    await client.getModels();

    // Now remembered as a Gate. A 502 from /v1/models is the Gate's own
    // answer and must surface rather than fall back to the native path.
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      calls.push(url.includes('/v1/models') ? '/v1/models' : url.includes('/api/model/options') ? '/api/model/options' : url);
      if (url.includes('/v1/models')) {
        return Promise.resolve(jsonResponse({ error: { message: 'catalog unavailable', code: 'models_failed' } }, 502));
      }
      return Promise.resolve(jsonResponse({ error: 'Not Found' }, 404));
    });
    calls.length = 0;
    await expect(client.getModels()).rejects.toThrow('catalog unavailable');
    expect(count(calls, '/v1/models')).toBe(1);
    expect(count(calls, '/api/model/options')).toBe(0);

    client.disconnect();
  });
});
