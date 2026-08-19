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

function clientWithEndpoints(endpoints: Record<string, string>) {
  const identity: GatewayIdentity = {
    ...IDENTITY,
    manifest: { ...IDENTITY.manifest!, endpoints },
  };
  return new ManifestClient(PROFILE, identity, {});
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

  test('connect reports the health transport error instead of a blank no-response', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.reject(new TypeError('Network request failed')),
    );
    const errors: string[] = [];
    const client = new ManifestClient(PROFILE, IDENTITY, {
      onError: (message) => errors.push(message),
    });
    await client.connect();
    expect(errors.some((message) => /Network request failed/i.test(message))).toBe(true);
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
    const full = await client.streamChat([{ role: 'user', content: 'hi' }], (t) => chunks.push(t), {
      model: 'test-model',
    });

    expect(chunks).toEqual(['Hel', 'lo']);
    expect(full).toBe('Hello');
  });

  // The Gate reports a failed backend turn as an error frame inside an HTTP
  // 200 stream, so response.ok cannot catch it. Ignoring the frame renders an
  // empty assistant bubble with nothing to explain it — this is the exact
  // payload a credit-exhausted OpenCode provider produced on the real Gate.
  test('surfaces an error frame carried inside a 200 stream', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        const body = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(
              enc.encode(
                'data: {"error":{"message":"opencode: Insufficient balance.","code":"backend_error"}}\n\n',
              ),
            );
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
      }
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await expect(
      client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, { model: 'test-model' }),
    ).rejects.toThrow(/Insufficient balance/);
  });

  test('falls back to the error code when a frame carries no message', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        const body = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('data: {"error":{"code":"empty_turn"}}\n\n'));
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
      }
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await expect(
      client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, { model: 'test-model' }),
    ).rejects.toThrow(/empty_turn/);
  });

  test('throws a named error when the manifest has no chat endpoint', async () => {
    const identityNoChat: GatewayIdentity = { ...IDENTITY, manifest: { ...IDENTITY.manifest!, endpoints: { health: '/health' } } };
    const client = new ManifestClient(PROFILE, identityNoChat, {});
    await expect(
      client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, { model: 'm' }),
    ).rejects.toThrow(/chat/i);
  });

  test('throws a clear error when no model is selected and none is advertised', async () => {
    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await expect(client.streamChat([{ role: 'user', content: 'hi' }], () => undefined)).rejects.toThrow(
      /no model/i,
    );
  });

  // A model id can be declared by more than one provider (e.g. "minimax-m3"
  // from both nvidia and opencode-zen). The Gate refuses to guess and answers
  // ambiguous_model unless the request also carries providerId — the picker
  // already knows it (getModels() returns it per-model), so the request must
  // carry it too.
  test('a providerId option qualifies the model in the chat request body', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        capturedBody = JSON.parse(String(init?.body));
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
      }
      return Promise.resolve(jsonResponse({}));
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
      model: 'minimax-m3',
      providerId: 'nvidia',
    });

    expect(capturedBody?.model).toBe('minimax-m3');
    expect(capturedBody?.providerId).toBe('nvidia');
  });

  test('providerId is left off the request body when routed to a backend', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/v1/chat/completions')) {
        capturedBody = JSON.parse(String(init?.body));
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return Promise.resolve({ ok: true, status: 200, body } as unknown as Response);
      }
      return Promise.resolve(jsonResponse({}));
    });

    const identityWithBackend: GatewayIdentity = {
      ...IDENTITY,
      manifest: {
        ...IDENTITY.manifest!,
        backends: [{ id: 'opencode-local', label: 'OpenCode', kind: 'environment' }],
      },
    };
    const client = new ManifestClient(PROFILE, identityWithBackend, {});
    await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
      model: 'kilo/deepcogito/cogito-v2.1-671b',
      providerId: 'nvidia',
    });

    expect(capturedBody?.backendId).toBe('opencode-local');
    expect(capturedBody?.providerId).toBeUndefined();
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

describe('rpcRequest against a gate advertising capabilitiesRpc', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('posts {method, params} and unwraps the result envelope', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ result: { ranInstance: 'standup' } }),
      json: async () => ({ result: { ranInstance: 'standup' } }),
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = clientWithEndpoints({ health: '/health', capabilitiesRpc: '/v1/capabilities/rpc' });
    const result = await client.rpcRequest('standup.run', { dryRun: true });

    expect(result).toEqual({ ranInstance: 'standup' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/v1/capabilities/rpc');
    expect(JSON.parse(init.body)).toEqual({ method: 'standup.run', params: { dryRun: true } });
  });

  test('throws the gateway error message when the envelope carries one', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ error: { message: 'instance "nope" not found', code: 'rpc_error' } }),
      json: async () => ({ error: { message: 'instance "nope" not found', code: 'rpc_error' } }),
    }) as any;

    const client = clientWithEndpoints({ health: '/health', capabilitiesRpc: '/v1/capabilities/rpc' });
    await expect(client.rpcRequest('registry.instances.get', { id: 'nope' })).rejects.toThrow(/not found/);
  });

  test('still throws a named error when the manifest advertises no rpc endpoint', async () => {
    const client = clientWithEndpoints({ health: '/health' });
    await expect(client.rpcRequest('anything')).rejects.toThrow(/not supported/);
  });

  test('posts capabilitiesRpc against the parent origin when the profile is a child /p/{id}', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ result: { ok: true } }),
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const child: GatewayProfile = {
      ...PROFILE,
      url: 'http://gate.test:8760/p/nvidia',
      parentId: 'parent',
    };
    const identity: GatewayIdentity = {
      ...IDENTITY,
      manifest: {
        ...IDENTITY.manifest!,
        endpoints: { health: '/health', capabilitiesRpc: '/v1/capabilities/rpc' },
      },
    };
    const client = new ManifestClient(child, identity, {});
    await client.rpcRequest('standup.run', {});

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://gate.test:8760/v1/capabilities/rpc');
  });
});

describe('ManifestClient sessions and runs when advertised', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('getSessions GETs the advertised sessions path', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ object: 'list', data: [{ id: 's1', source: 'gate' }] }),
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = clientWithEndpoints({ health: '/health', sessions: '/api/sessions' });
    const sessions = await client.getSessions(10);
    expect(sessions).toEqual([{ id: 's1', source: 'gate' }]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/sessions?limit=10');
  });

  test('getSessionMessages GETs the advertised sessions path plus id/messages', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ object: 'list', data: [{ role: 'user', content: 'hi' }] }),
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = clientWithEndpoints({ health: '/health', sessions: '/api/sessions' });
    const messages = await client.getSessionMessages('abc', 20);
    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/sessions/abc/messages?limit=20');
  });

  test('stopRun POSTs the advertised stopRun path with the run id', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({}),
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = clientWithEndpoints({ health: '/health', stopRun: '/v1/runs/{id}/stop' });
    await client.stopRun('run-9');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://gate.test:8760/v1/runs/run-9/stop');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });
});


describe('rpcMethods pass-through', () => {
  function clientWithManifest(extra: Record<string, unknown>) {
    const identity: GatewayIdentity = {
      ...IDENTITY,
      manifest: { ...IDENTITY.manifest!, ...extra },
    };
    return new ManifestClient(PROFILE, identity, {});
  }

  test('a gate that enumerates its dispatch table has it carried onto capabilities', async () => {
    // This is the seam the app's command filtering reads: without it every rpc
    // button falls back to guessing from the gateway's kind.
    const caps = await clientWithManifest({ rpcMethods: ['skills.list', 'cron.list'] }).getCapabilities();
    expect(caps.rpcMethods).toEqual(['skills.list', 'cron.list']);
  });

  test('a gate that reports none leaves it undefined rather than empty', async () => {
    // Undefined means "cannot say"; an empty array would mean "dispatches
    // nothing", which would blank every command button.
    const caps = await clientWithManifest({}).getCapabilities();
    expect(caps.rpcMethods).toBeUndefined();
  });

  test('non-string entries are dropped rather than trusted', async () => {
    const caps = await clientWithManifest({ rpcMethods: ['skills.list', 42, null] }).getCapabilities();
    expect(caps.rpcMethods).toEqual(['skills.list']);
  });
});
