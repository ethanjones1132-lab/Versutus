import { HermesGatewayClient } from '@/lib/gateway/client';
import type { GatewayProfile } from '@/lib/gateway/types';

const PROFILE: GatewayProfile = {
  id: 'g1', name: 'Test gateway', url: 'http://gateway.test:8760',
  kind: 'hermes', token: 'k', createdAt: 0,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const SESSIONS = { object: 'list', data: [{ id: 's-1' }] };
const MESSAGES = { object: 'list', data: [{ id: 'm-1', role: 'user', content: 'hi' }] };

/**
 * A direct Hermes host 404s every `/v1/*` session route and answers `/api/*`.
 * After the first read the client has learned that dialect; every later session
 * route must lead with it instead of paying the same 404 probe again.
 */
function mockHermesHost() {
  const calls: { method: string; path: string }[] = [];
  const fetchMock = jest.fn((input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.includes('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
    if (url.includes('/v1/sessions')) {
      calls.push({ method, path: '/v1/sessions' });
      return Promise.resolve(jsonResponse({ error: 'Not Found' }, 404));
    }
    if (url.includes('/api/sessions') && url.includes('/messages')) {
      calls.push({ method, path: '/api/messages' });
      return Promise.resolve(jsonResponse(MESSAGES));
    }
    if (url.includes('/api/sessions')) {
      calls.push({ method, path: '/api/sessions' });
      if (method === 'POST') return Promise.resolve(jsonResponse({ session: { id: 'created' } }));
      return Promise.resolve(jsonResponse(url.includes('/api/sessions/s-1') ? { session: { id: 's-1' } } : SESSIONS));
    }
    return Promise.resolve(jsonResponse({}));
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return calls;
}

describe('session routes remember the dialect that answered', () => {
  test('a second getSessions leads with /api after a Hermes host answered', async () => {
    const calls = mockHermesHost();
    const client = new HermesGatewayClient(PROFILE);

    await client.getSessions(20);
    await client.getSessions(20);

    expect(calls.map((call) => call.path)).toEqual([
      '/v1/sessions',
      '/api/sessions',
      '/api/sessions',
    ]);
  });

  test('a second message page leads with /api after a Hermes host answered', async () => {
    const calls = mockHermesHost();
    const client = new HermesGatewayClient(PROFILE);

    await client.getSessionMessagePage('s-1', 50);
    await client.getSessionMessagePage('s-1', 50);

    expect(calls.map((call) => call.path)).toEqual([
      '/v1/sessions',
      '/api/messages',
      '/api/messages',
    ]);
  });

  test('a second delete leads with /api after a Hermes host answered', async () => {
    const calls = mockHermesHost();
    const client = new HermesGatewayClient(PROFILE);

    await client.deleteSession('s-1');
    await client.deleteSession('s-1');

    expect(calls.map((call) => call.path)).toEqual([
      '/v1/sessions',
      '/api/sessions',
      '/api/sessions',
    ]);
  });

  test('a second create leads with /api after a Hermes host answered', async () => {
    const calls = mockHermesHost();
    const client = new HermesGatewayClient(PROFILE);

    await client.createSession('one');
    await client.createSession('two');

    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'POST']);
    expect(calls.map((call) => call.path)).toEqual([
      '/v1/sessions',
      '/api/sessions',
      '/api/sessions',
    ]);
  });

  test('a Gate host still leads with /v1 on the second read', async () => {
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (url.includes('/v1/sessions')) {
        calls.push('/v1/sessions');
        return Promise.resolve(jsonResponse(SESSIONS));
      }
      calls.push('/api/sessions');
      return Promise.resolve(jsonResponse({ error: 'Not Found' }, 404));
    });
    const client = new HermesGatewayClient(PROFILE);

    await client.getSessions(20);
    await client.getSessions(20);

    expect(calls).toEqual(['/v1/sessions', '/v1/sessions']);
  });
});
