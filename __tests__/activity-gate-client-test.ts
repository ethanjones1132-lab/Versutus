import { createClientForKind } from '@/lib/portal/adapters';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import { readFailureKind, todaySince } from '@/lib/gateway/activity-feed';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra: {} } } }));

// A real Gate identifies as `custom` with a manifest health endpoint, so the
// factory builds a ManifestClient. The read methods used to live only on the
// Hermes client, which meant the Activity screen refused before any request.
// These build the client exactly the way the provider does and mock at HTTP.

const PROFILE: GatewayProfile = {
  id: 'gate-activity',
  name: 'Activity Gate',
  url: 'http://gate.test:8760',
  kind: 'custom',
  token: 'k',
  createdAt: 0,
};

const IDENTITY: GatewayIdentity = {
  kind: 'custom',
  kindLabel: 'Custom — versutus-gate',
  auth: { schemes: ['bearer'], requiresToken: true },
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Activity Gate',
    auth: { schemes: ['bearer'] },
    transport: { primary: 'http' },
    endpoints: { health: '/health', models: '/v1/models' },
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

function realClient() {
  const client = createClientForKind('custom', PROFILE, {}, IDENTITY);
  expect(client).toBeInstanceOf(ManifestClient);
  return client as ManifestClient;
}

const SINCE = todaySince(new Date(2026, 10, 10, 12));

describe('the real Gate client reports activity', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('getActivityFeed GETs /v1/activity with since and backendId', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({ since: SINCE, generatedAt: '2026-11-10T12:00:00.000Z', backends: [], items: [] }),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const feed = await realClient().getActivityFeed(SINCE, 'hermes-local');

    expect(feed).toEqual({
      since: SINCE,
      generatedAt: '2026-11-10T12:00:00.000Z',
      backends: [],
      items: [],
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/v1/activity?since=');
    expect(url).toContain('&backendId=hermes-local');
  });

  test('a successful empty feed is a real answer, not a refusal', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue(
      jsonResponse({ since: SINCE, generatedAt: '2026-11-10T12:00:00.000Z', backends: [], items: [] }),
    );

    const feed = await realClient().getActivityFeed(SINCE);

    expect(feed.items).toEqual([]);
    expect(feed.backends).toEqual([]);
  });

  test('a partial feed keeps its per-backend coverage distinct from empty', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        since: SINCE,
        generatedAt: '2026-11-10T12:00:00.000Z',
        backends: [
          { id: 'hermes-local', label: 'Hermes', status: 'partial', error: 'timed out' },
          { id: 'claude-local', label: 'Claude Code', status: 'complete' },
        ],
        items: [{
          id: 'hermes:session:1',
          backendId: 'hermes-local',
          botId: 'mira',
          kind: 'session',
          sessionId: 'api_1',
          startedAt: '2026-11-10T10:00:00.000Z',
          status: 'complete',
          title: 'Morning',
        }],
      }),
    );

    const feed = await realClient().getActivityFeed(SINCE);

    expect(feed.backends.map((backend) => backend.status)).toEqual(['partial', 'complete']);
    expect(feed.items[0]).toMatchObject({ backendId: 'hermes-local', botId: 'mira', sessionId: 'api_1' });
  });

  test('401/403 stays unauthorized instead of reading as an empty day', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Invalid token' } }, 401),
    );

    const error = await realClient().getActivityFeed(SINCE).catch((caught: unknown) => caught);
    expect(readFailureKind(error)).toBe('unauthorized');
  });

  test('404 from an older Gate stays honestly unsupported', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Not Found' } }, 404),
    );

    const error = await realClient().getActivityFeed(SINCE).catch((caught: unknown) => caught);
    expect(readFailureKind(error)).toBe('unsupported');
  });

  test('405 from a host without the method is unsupported too', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Method Not Allowed' } }, 405),
    );

    const error = await realClient().getActivityFeed(SINCE).catch((caught: unknown) => caught);
    expect(readFailureKind(error)).toBe('unsupported');
  });

  test('a network failure stays offline', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockRejectedValue(new TypeError('Network request failed'));

    const error = await realClient().getActivityFeed(SINCE).catch((caught: unknown) => caught);
    expect(readFailureKind(error)).toBe('offline');
  });

  test('getRoutineFeed GETs /v1/routines with the backend', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        generatedAt: '2026-11-10T12:00:00.000Z',
        backends: [{ id: 'hermes-local', label: 'Hermes', status: 'complete' }],
        routines: [{ id: 'r1', backendId: 'hermes-local', name: 'Morning', paused: false }],
      }),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const feed = await realClient().getRoutineFeed('hermes-local');

    expect(feed.routines[0]).toMatchObject({ id: 'r1', backendId: 'hermes-local', name: 'Morning' });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/v1/routines?backendId=hermes-local');
  });

  test('getRoutineFeed keeps a 404 distinct as unsupported', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Not Found' } }, 404),
    );

    const error = await realClient().getRoutineFeed().catch((caught: unknown) => caught);
    expect(readFailureKind(error)).toBe('unsupported');
  });
});
