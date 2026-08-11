import { ManifestClient } from '@/lib/gateway/manifest-client';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

const PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Test gate',
  url: 'http://gate.test:8760',
  kind: 'custom',
  token: 'k',
  createdAt: 0,
};

const IDENTITY: GatewayIdentity = {
  kind: 'custom',
  kindLabel: 'Custom — versutus-gate',
  auth: { schemes: ['bearer'], requiresToken: true, grantPath: '/.well-known/gateway/access' },
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Test Gate',
    auth: { schemes: ['bearer'], grantPath: '/.well-known/gateway/access' },
    transport: { primary: 'http' },
    endpoints: { health: '/health', models: '/v1/models', chat: '/v1/chat/completions' },
    capabilities: { chat: true, models: true },
  },
  source: 'manifest',
  identifiedAt: 0,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('ManifestClient', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    jest.useRealTimers();
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });
  beforeEach(() => jest.useFakeTimers());

  test('connects by resolving health and models from manifest endpoints, not hardcoded paths', async () => {
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (url.endsWith('/v1/models')) return Promise.resolve(jsonResponse({ data: [{ id: 'm1', object: 'model' }] }));
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await client.connect();

    expect(client.connectionStatus).toBe('connected');
    expect(calls.some((u) => u.endsWith('/health'))).toBe(true);
    client.disconnect();
  });

  test('throws a named error when the manifest has no health endpoint', async () => {
    const identityNoHealth: GatewayIdentity = {
      ...IDENTITY,
      manifest: { ...IDENTITY.manifest!, endpoints: { models: '/v1/models' } },
    };
    const client = new ManifestClient(PROFILE, identityNoHealth, {});
    await expect(client.connect()).rejects.toThrow(/health/i);
  });

  test('getModels resolves from the manifest-declared models endpoint', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (url.endsWith('/v1/models')) {
        return Promise.resolve(jsonResponse({ data: [{ id: 'claude-opus-5', object: 'model' }] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await client.connect();
    const models = await client.getModels();
    expect(models).toEqual([{ id: 'claude-opus-5', object: 'model' }]);
    client.disconnect();
  });

  test('getCapabilities synthesizes a snapshot from the manifest, not a live endpoint', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (url.endsWith('/v1/models')) return Promise.resolve(jsonResponse({ data: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await client.connect();
    const caps = await client.getCapabilities();
    expect(caps.features.chat).toBe(true);
    expect(caps.features.models).toBe(true);
    client.disconnect();
  });

  test('a rejected models call surfaces as an auth failure, matching HermesGatewayClient', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (url.endsWith('/v1/models')) {
        return Promise.resolve(jsonResponse({ error: { message: 'Invalid token' } }, 401));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await expect(client.connect()).rejects.toThrow(/token/i);
    client.disconnect();
  });
});

describe('ManifestClient.streamChat', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('streams normalized SSE deltas from the manifest-declared chat endpoint', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        const body = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
      }
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    const chunks: string[] = [];
    const full = await client.streamChat([{ role: 'user', content: 'hi' }], (t) => chunks.push(t));

    expect(chunks).toEqual(['Hel', 'lo']);
    expect(full).toBe('Hello');
  });

  test('throws a named error when the manifest has no chat endpoint', async () => {
    const identityNoChat: GatewayIdentity = { ...IDENTITY, manifest: { ...IDENTITY.manifest!, endpoints: { health: '/health' } } };
    const client = new ManifestClient(PROFILE, identityNoChat, {});
    await expect(client.streamChat([{ role: 'user', content: 'hi' }], () => undefined)).rejects.toThrow(/chat/i);
  });
});

describe('ManifestClient — capabilities the manifest does not advertise', () => {
  test('getSessions names the missing capability rather than guessing a path', async () => {
    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await expect(client.getSessions()).rejects.toThrow(/sessions/i);
  });

  test('getSessionMessages names the missing capability', async () => {
    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await expect(client.getSessionMessages('s1')).rejects.toThrow(/sessions/i);
  });

  test('rpcRequest names the missing capability with the method that was requested', async () => {
    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await expect(client.rpcRequest('sessions.list')).rejects.toThrow(/sessions\.list/);
  });

  test('stopRun names the missing capability', async () => {
    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await expect(client.stopRun('r1')).rejects.toThrow(/run/i);
  });
});
