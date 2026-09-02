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

/** A four-environment Gate like the production one: Claude advertises first. */
const MULTI_BACKEND_IDENTITY: GatewayIdentity = {
  kind: 'custom',
  kindLabel: 'Custom — versutus-gate',
  auth: { schemes: ['bearer'], requiresToken: true, grantPath: '/.well-known/gateway/access' },
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Test Gate',
    auth: { schemes: ['bearer'], grantPath: '/.well-known/gateway/access' },
    transport: { primary: 'http' },
    endpoints: { health: '/health', runs: '/v1/runs' },
    capabilities: {},
    backends: [
      { id: 'claude-local', label: 'Claude Code', kind: 'environment' },
      { id: 'hermes-local', label: 'Hermes', kind: 'environment' },
      { id: 'codex-local', label: 'Codex', kind: 'environment' },
      { id: 'opencode-local', label: 'OpenCode', kind: 'environment' },
    ],
  },
  source: 'manifest',
  identifiedAt: 0,
};

describe('ManifestClient startRun backend scoping', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  function clientWith(fetchMock: jest.Mock) {
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    return new ManifestClient(PROFILE, MULTI_BACKEND_IDENTITY, {});
  }

  function jsonResponse(body: unknown) {
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  }

  function sseResponse() {
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"run.completed"}\n\n'));
          controller.close();
        },
      }),
    };
  }

  test('a run with no explicit backend leaves the route unpinned for the Gate to resolve', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ run_id: 'run-1', status: 'started' }),
    });
    const client = clientWith(fetchMock);

    const started = await client.startRun('reply with the single word pong');
    expect(started.run_id).toBe('run-1');

    // backends[0] here is claude-local — the whole point is that the default
    // pin (which made prod answer 501 runs_unsupported) must NOT be sent.
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/v1/runs');
    expect(url).not.toContain('backendId=');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      input: 'reply with the single word pong',
    });
  });

  test('an explicit backend selection is honoured as a deliberate pin', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ run_id: 'run-2', status: 'started' }),
    });
    const client = clientWith(fetchMock);
    client.setBackendId('hermes-local');

    await client.startRun('pong', { sessionId: 's1', model: 'hermes-agent' });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('backendId=hermes-local');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      input: 'pong',
      session_id: 's1',
      model: 'hermes-agent',
    });
  });

  test('a bot selection alone does not pin a backend — the Gate resolves runs', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ run_id: 'run-3', status: 'started' }),
    });
    const client = clientWith(fetchMock);
    // A Bot names its chat environment, but runs are a Gate-level surface
    // (same class as listBots): the bot must not leak a backend pin when the
    // operator never picked one for this run.
    client.setBotId('scribe');

    await client.startRun('status?');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).not.toContain('backendId=');
    expect(url).not.toContain('bot=');
  });

  test('every follow-up action keeps the explicitly selected backend', async () => {
    const fetchMock = jest.fn((input: unknown) => {
      const url = String(input);
      return Promise.resolve(url.includes('/events') ? sseResponse() : jsonResponse({ status: 'completed' }));
    });
    const client = clientWith(fetchMock);
    client.setBackendId('hermes-local');

    await client.getRunStatus('run-4');
    await client.streamRunEvents('run-4', () => undefined);
    await client.resolveApproval('run-4', true, 'looks good');
    await client.stopRun('run-4');

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://gate.test:8760/v1/runs/run-4?backendId=hermes-local',
      'http://gate.test:8760/v1/runs/run-4/events?backendId=hermes-local',
      'http://gate.test:8760/v1/runs/run-4/approval?backendId=hermes-local',
      'http://gate.test:8760/v1/runs/run-4/stop?backendId=hermes-local',
    ]);
  });
});
