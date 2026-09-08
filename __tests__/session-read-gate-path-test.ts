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
function mockHost(opts: { v1: number; api: number; v1Body?: unknown }) {
  const calls: string[] = [];
  const fetchMock = jest.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
    if (url.includes('/v1/sessions')) {
      calls.push('/v1/sessions');
      if (opts.v1 === 200) return Promise.resolve(jsonResponse(SESSIONS));
      return Promise.resolve(jsonResponse(opts.v1Body ?? { error: 'Not Found' }, opts.v1));
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

  test('a non-404 Gate error surfaces instead of retrying another dialect', async () => {
    jest.useFakeTimers();
    try {
      const calls = mockHost({
        v1: 500,
        api: 200,
        v1Body: { error: { message: 'sessions exploded', code: 'session_list_failed' } },
      });
      const pending = new HermesGatewayClient(PROFILE).getSessions(20);
      const settled = pending.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1500);
      const result = await settled;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected getSessions to reject');
      expect(result.error).toEqual(expect.objectContaining({ message: expect.stringMatching(/sessions exploded/) }));
      // Same-path retries of /v1/sessions, never the Hermes-native dialect.
      expect(calls).toEqual(['/v1/sessions', '/v1/sessions', '/v1/sessions']);
    } finally {
      jest.useRealTimers();
    }
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

/**
 * A Gate serves DELETE /v1/sessions/{id} (answering `{ deleted: true }`) and
 * answers 404 to the Hermes-native DELETE /api/sessions/{id}; a Hermes host
 * is the reverse. The fallback client called only the native path, so every
 * delete through a Gate 404'd while the provider had already removed the
 * session from its visible list only after the remote call succeeded.
 */
function mockDeleteHost(opts: { v1: number; api: number }) {
  const calls: string[] = [];
  const fetchMock = jest.fn((input: unknown, init?: { method?: string }) => {
    const url = String(input);
    if (url.includes('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
    if (url.includes('/sessions/') && init?.method === 'DELETE') {
      if (url.includes('/v1/sessions/')) {
        calls.push('/v1/delete');
        if (opts.v1 === 200) return Promise.resolve(jsonResponse({ deleted: true }));
        return Promise.resolve(jsonResponse({ error: { message: 'delete failed', code: 'session_delete_failed' } }, opts.v1));
      }
      calls.push('/api/delete');
      if (opts.api === 200) return Promise.resolve(jsonResponse({ deleted: true }));
      return Promise.resolve(jsonResponse({ error: 'Not Found' }, opts.api));
    }
    return Promise.resolve(jsonResponse({}));
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return calls;
}

describe('deleteSession deletes through the path the host actually serves', () => {
  test('against a Gate it deletes /v1 and never falls back', async () => {
    const calls = mockDeleteHost({ v1: 200, api: 404 });
    await expect(new HermesGatewayClient(PROFILE).deleteSession('s-1')).resolves.toBeUndefined();
    expect(calls).toEqual(['/v1/delete']);
  });

  test('against a Hermes host it falls back to /api delete', async () => {
    const calls = mockDeleteHost({ v1: 404, api: 200 });
    await expect(new HermesGatewayClient(PROFILE).deleteSession('s-1')).resolves.toBeUndefined();
    expect(calls).toEqual(['/v1/delete', '/api/delete']);
  });

  test('a host serving neither path rejects rather than reporting a deletion', async () => {
    const calls = mockDeleteHost({ v1: 404, api: 404 });
    await expect(new HermesGatewayClient(PROFILE).deleteSession('s-1')).rejects.toBeDefined();
    expect(calls).toEqual(['/v1/delete', '/api/delete']);
  });

  test('a non-404 Gate refusal surfaces instead of retrying another dialect', async () => {
    const calls = mockDeleteHost({ v1: 502, api: 200 });
    await expect(new HermesGatewayClient(PROFILE).deleteSession('s-1')).rejects.toThrow(/delete failed/);
    expect(calls).toEqual(['/v1/delete']);
  });
});

describe('getSessionMessagePage threads the paging cursors through', () => {
  function mockPageHost(opts: { v1: number; api: number; v1Body?: unknown; apiBody?: unknown }) {
    const seen: string[] = [];
    const fetchMock = jest.fn((input: unknown) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/health')) return Promise.resolve(jsonResponse({ status: 'ok' }));
      if (url.includes('/v1/sessions/') && url.includes('/messages')) {
        if (opts.v1 === 200) return Promise.resolve(jsonResponse(opts.v1Body ?? GATE_MESSAGES));
        return Promise.resolve(jsonResponse({ error: { message: 'boom', code: 'session_read_failed' } }, opts.v1));
      }
      if (url.includes('/api/sessions/') && url.includes('/messages')) {
        if (opts.api === 200) return Promise.resolve(jsonResponse(opts.apiBody ?? NATIVE_MESSAGES));
        return Promise.resolve(jsonResponse({ error: 'Not Found' }, opts.api));
      }
      return Promise.resolve(jsonResponse({}));
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    return seen;
  }

  test('against a Gate it returns messages with the hasMore/nextBefore cursors', async () => {
    mockPageHost({ v1: 200, api: 404 });
    const page = await new HermesGatewayClient(PROFILE).getSessionMessagePage('s-1', 50);
    expect(page.messages.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(page.hasMore).toBe(true);
    expect(page.nextBefore).toBe('m-1');
  });

  test('message order and content pass through unchanged', async () => {
    mockPageHost({ v1: 200, api: 404 });
    const page = await new HermesGatewayClient(PROFILE).getSessionMessagePage('s-1', 50);
    expect(page.messages.map((m) => m.id)).toEqual(['m-1', 'm-2', 'm-3']);
    expect(page.messages[1].content).toEqual([{ type: 'text', text: 'hi there' }]);
  });

  test('the before cursor is carried on the Gate path', async () => {
    const seen = mockPageHost({ v1: 200, api: 404 });
    await new HermesGatewayClient(PROFILE).getSessionMessagePage('s-1', 25, 'm-1');
    expect(seen.some((u) => u.includes('/v1/sessions/s-1/messages') && u.includes('limit=25') && u.includes('before=m-1'))).toBe(true);
  });

  test('against a Hermes host it falls back to /api messages with no paging cursors', async () => {
    const seen = mockPageHost({ v1: 404, api: 200 });
    const page = await new HermesGatewayClient(PROFILE).getSessionMessagePage('s-1', 50);
    expect(page.messages).toHaveLength(2);
    expect(page.hasMore).toBeUndefined();
    expect(page.nextBefore).toBeUndefined();
    expect(seen.some((u) => u.includes('/v1/sessions/s-1/messages'))).toBe(true);
    expect(seen.some((u) => u.includes('/api/sessions/s-1/messages'))).toBe(true);
  });

  test('a non-404 Gate error surfaces instead of retrying another dialect', async () => {
    const seen = mockPageHost({ v1: 502, api: 200 });
    await expect(new HermesGatewayClient(PROFILE).getSessionMessagePage('s-1', 50)).rejects.toThrow(/boom/);
    expect(seen.some((u) => u.includes('/api/'))).toBe(false);
  });
});
