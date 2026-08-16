import { ManifestClient } from '@/lib/gateway/manifest-client';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

const PROFILE: GatewayProfile = {
  id: 'gate-1',
  name: 'Gate',
  url: 'http://gate.local:8760',
  token: 'tok',
  createdAt: 0,
};

/** A Gate that has a native environment attached, per the backend manifest. */
const IDENTITY = {
  kind: 'custom',
  kindLabel: 'Versutus Gate',
  source: 'manifest',
  identifiedAt: 0,
  auth: { schemes: ['bearer'], requiresToken: true },
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Gate',
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
      sessions: '/v1/sessions',
      sessionMessages: '/v1/sessions/{id}/messages',
      backends: '/v1/backends',
    },
    capabilities: { chat: true, models: true, sessions: true, tools: true },
    backends: [
      { id: 'opencode-local', label: 'OpenCode', kind: 'environment', capabilities: ['sessions', 'tools'] },
    ],
  },
} as unknown as GatewayIdentity;

function stub(responses: Record<string, unknown>) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(responses).find((k) => String(url).includes(k));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(key ? responses[key] : {}),
      json: async () => (key ? responses[key] : {}),
    };
  });
  return calls;
}

describe('ManifestClient against a backend-capable Gate', () => {
  it('exposes the backends the Gate advertises and defaults to the first', () => {
    const client = new ManifestClient(PROFILE, IDENTITY);
    expect(client.backends.map((b) => b.id)).toEqual(['opencode-local']);
    expect(client.backendId).toBe('opencode-local');
  });

  it('creates a session on the selected backend', async () => {
    const calls = stub({ '/v1/sessions': { id: 'ses_1', title: 'New' } });
    const client = new ManifestClient(PROFILE, IDENTITY);
    const created = await client.createSession('New');
    expect(created.id).toBe('ses_1');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toMatchObject({ backendId: 'opencode-local', title: 'New' });
  });

  it('deletes a session on the selected backend', async () => {
    const calls = stub({ '/v1/sessions': { deleted: true } });
    const client = new ManifestClient(PROFILE, IDENTITY);
    await client.deleteSession('ses_1');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('/v1/sessions/ses_1');
    expect(calls[0].url).toContain('backendId=opencode-local');
  });

  it('scopes session listing and history to the backend', async () => {
    const calls = stub({
      '/v1/sessions': { object: 'list', data: [{ id: 'ses_1' }] },
    });
    const client = new ManifestClient(PROFILE, IDENTITY);
    await client.getSessions(10);
    expect(calls[0].url).toContain('backendId=opencode-local');
    expect(calls[0].url).toContain('limit=10');
  });

  it('interpolates the session id into the messages endpoint', async () => {
    const calls = stub({ '/messages': { object: 'list', data: [] } });
    const client = new ManifestClient(PROFILE, IDENTITY);
    await client.getSessionMessages('ses_1', 20);
    expect(calls[0].url).toContain('/v1/sessions/ses_1/messages');
    expect(calls[0].url).toContain('backendId=opencode-local');
  });

  it('switching backend changes where sessions are read from', async () => {
    const client = new ManifestClient(PROFILE, {
      ...IDENTITY,
      manifest: {
        ...IDENTITY.manifest!,
        backends: [
          { id: 'opencode-local', label: 'OpenCode', kind: 'environment', capabilities: ['sessions'] },
          { id: 'codex-local', label: 'Codex', kind: 'environment', capabilities: ['sessions'] },
        ],
      },
    } as unknown as GatewayIdentity);
    client.setBackendId('codex-local');
    const calls = stub({ '/v1/sessions': { object: 'list', data: [] } });
    await client.getSessions();
    expect(calls[0].url).toContain('backendId=codex-local');
  });

  it('a Gate with no backends does not offer session creation', () => {
    const client = new ManifestClient(PROFILE, {
      ...IDENTITY,
      manifest: { ...IDENTITY.manifest!, backends: [], endpoints: { health: '/health', chat: '/v1/chat/completions' } },
    } as unknown as GatewayIdentity);
    expect(client.backends).toEqual([]);
    expect(client.backendId).toBeUndefined();
  });
});
