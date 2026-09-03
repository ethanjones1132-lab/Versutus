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

const GATE_MESSAGES = {
  object: 'list',
  data: [
    { id: 'm-1', role: 'user', content: 'hello' },
    { id: 'm-2', role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    { id: 'm-3', role: 'assistant', content: 'done' },
  ],
  hasMore: true,
  nextBefore: 'm-1',
};

const NATIVE_MESSAGES = {
  object: 'list',
  data: [
    { id: 'm-1', role: 'user', content: 'hello' },
    { id: 'm-2', role: 'assistant', content: 'hi' },
  ],
};

/**
 * A Gate serves GET /v1/sessions/{id}/messages and answers 404 to the
 * Hermes-native GET /api/sessions/{id}/messages; a Hermes host is the
 * reverse. The fallback client asked only for the native path, so every
 * history read through a Gate 404'd.
 */
function mockMessageHost(opts: { v1: number; api: number; v1Body?: unknown; apiBody?: unknown }) {
  const calls: string[] = [];
  const fetchMock = jest.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
    if (url.includes('/messages')) {
      if (url.includes('/v1/sessions/')) {
        calls.push('/v1/messages');
        if (opts.v1 === 200) return Promise.resolve(jsonResponse(opts.v1Body ?? GATE_MESSAGES));
        return Promise.resolve(jsonResponse({ error: { message: 'boom', code: 'session_read_failed' } }, opts.v1));
      }
      calls.push('/api/messages');
      if (opts.api === 200) return Promise.resolve(jsonResponse(opts.apiBody ?? NATIVE_MESSAGES));
      return Promise.resolve(jsonResponse({ error: 'Not Found' }, opts.api));
    }
    return Promise.resolve(jsonResponse({}));
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return calls;
}

describe('getSessionMessages reads the path the host actually serves', () => {
  test('against a Gate it reads /v1 messages and never falls back', async () => {
    const calls = mockMessageHost({ v1: 200, api: 404 });
    const messages = await new HermesGatewayClient(PROFILE).getSessionMessages('s-1', 50);
    expect(messages).toHaveLength(3);
    expect(calls).toEqual(['/v1/messages']);
  });

  test('message order and tool-call content pass through unchanged', async () => {
    mockMessageHost({ v1: 200, api: 404 });
    const messages = await new HermesGatewayClient(PROFILE).getSessionMessages('s-1', 50);
    expect(messages.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(messages[1].content).toEqual([{ type: 'text', text: 'hi there' }]);
  });

  test('against a Hermes host it falls back to /api messages', async () => {
    const calls = mockMessageHost({ v1: 404, api: 200 });
    const messages = await new HermesGatewayClient(PROFILE).getSessionMessages('s-1', 50);
    expect(messages).toHaveLength(2);
    expect(calls).toEqual(['/v1/messages', '/api/messages']);
  });

  test('a non-404 Gate error surfaces instead of retrying another dialect', async () => {
    const calls = mockMessageHost({ v1: 502, api: 200 });
    await expect(new HermesGatewayClient(PROFILE).getSessionMessages('s-1', 50)).rejects.toThrow(/boom/);
    expect(calls).toEqual(['/v1/messages']);
  });

  test('the limit is carried on the Gate path', async () => {
    const seen: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      return Promise.resolve(jsonResponse(GATE_MESSAGES));
    });
    await new HermesGatewayClient(PROFILE).getSessionMessages('s-1', 25);
    expect(seen.some((u) => u.includes('/v1/sessions/s-1/messages') && u.includes('limit=25'))).toBe(true);
  });
});
