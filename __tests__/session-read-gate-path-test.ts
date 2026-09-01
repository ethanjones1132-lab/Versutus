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

const SESSIONS = { object: 'list', data: [{ id: 's-1' }, { id: 's-2' }] };

/**
 * A Gate serves /v1/sessions and answers 404 to /api/sessions; a Hermes host is
 * the reverse. The client asked only for /api/sessions, so every read through a
 * Gate 404'd and the session sheet reported "Sessions could not be read".
 */
function mockHost(opts: { v1: number; api: number }) {
  const calls: string[] = [];
  const fetchMock = jest.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
    if (url.includes('/v1/sessions')) {
      calls.push('/v1/sessions');
      return Promise.resolve(opts.v1 === 200 ? jsonResponse(SESSIONS) : jsonResponse({ error: 'Not Found' }, opts.v1));
    }
    if (url.includes('/api/sessions')) {
      calls.push('/api/sessions');
      return Promise.resolve(opts.api === 200 ? jsonResponse(SESSIONS) : jsonResponse({ error: 'Not Found' }, opts.api));
    }
    return Promise.resolve(jsonResponse({}));
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return calls;
}

describe('getSessions reads the path the host actually serves', () => {
  test('against a Gate it reads /v1/sessions and never falls back', async () => {
    const calls = mockHost({ v1: 200, api: 404 });
    const sessions = await new HermesGatewayClient(PROFILE).getSessions(20);
    expect(sessions).toHaveLength(2);
    expect(calls).toContain('/v1/sessions');
    expect(calls).not.toContain('/api/sessions');
  });

  test('against a Hermes host it falls back to /api/sessions', async () => {
    const calls = mockHost({ v1: 404, api: 200 });
    const sessions = await new HermesGatewayClient(PROFILE).getSessions(20);
    expect(sessions).toHaveLength(2);
    expect(calls).toEqual(['/v1/sessions', '/api/sessions']);
  });

  test('the limit is carried on whichever path answers', async () => {
    const seen: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      return Promise.resolve(jsonResponse(SESSIONS));
    });
    await new HermesGatewayClient(PROFILE).getSessions(7);
    expect(seen.some((u) => u.includes('/v1/sessions') && u.includes('limit=7'))).toBe(true);
  });

  test('a host serving neither path rejects rather than reporting an empty list', async () => {
    mockHost({ v1: 404, api: 404 });
    await expect(new HermesGatewayClient(PROFILE).getSessions(20)).rejects.toBeDefined();
  });
});
