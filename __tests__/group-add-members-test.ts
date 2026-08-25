import { ManifestClient } from '@/lib/gateway/manifest-client';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

/**
 * Transport pins for ManifestClient.addGroupMembers — kept in their own file
 * because manifest-client-test.ts currently carries another workstream's
 * uncommitted edits; these pins must be stageable without them.
 */
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

describe('ManifestClient.addGroupMembers', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('appends members with a PATCH to the room and returns the Gate roster', async () => {
    const updated = { id: 'room1', name: 'crew', memberIds: ['a', 'b', 'c'] };
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse(updated));
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    const client = clientWithEndpoints({ health: '/health', botGroups: '/v1/bot-groups' });

    await expect(client.addGroupMembers('room1', ['c'])).resolves.toEqual(updated);
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/bot-groups/room1');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ memberIds: ['c'] });
    // Rooms are Gate-level: no bot= / backendId may be appended even though
    // the client carries bot/backend state.
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('bot=');
    expect(String(fetchMock.mock.calls[0][0])).not.toContain('backendId=');
  });

  test('refuses with the rooms-capability error on a gate that advertises no rooms', async () => {
    const client = clientWithEndpoints({ health: '/health' });
    await expect(client.addGroupMembers('room1', ['c'])).rejects.toThrow(/botGroups/);
  });
});
