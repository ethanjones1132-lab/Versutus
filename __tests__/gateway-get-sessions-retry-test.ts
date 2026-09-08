import {
  GET_SESSIONS_ATTEMPT_TIMEOUT_MS,
  GET_SESSIONS_MAX_RETRIES,
  GET_SESSIONS_RETRY_BACKOFF_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  HermesGatewayClient,
} from '@/lib/gateway/client';
import { GATEWAY_PROBE_TIMEOUT_MS } from '@/lib/gateway/probe';
import { resolveResumeSession } from '@/lib/gateway/session-resume';
import type { GatewayProfile } from '@/lib/gateway/types';

const PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Test gateway',
  url: 'http://gateway.test:8760',
  kind: 'hermes',
  token: 'k',
  createdAt: 0,
};

const SESSIONS = { object: 'list', data: [{ id: 's-1' }, { id: 's-2' }] };

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function v1Calls(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/v1/sessions'));
}

function apiCalls(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/api/sessions'));
}

/**
 * Drive getSessions (or resolveResumeSession, which calls it) past the
 * 500ms then 1500ms retry backoffs without waiting on the real clock.
 */
async function withRetryClock<T>(run: () => Promise<T>): Promise<T> {
  const work = run();
  const settled = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await Promise.resolve();
  await Promise.resolve();
  await jest.advanceTimersByTimeAsync(GET_SESSIONS_RETRY_BACKOFF_MS[0]);
  await Promise.resolve();
  await Promise.resolve();
  await jest.advanceTimersByTimeAsync(GET_SESSIONS_RETRY_BACKOFF_MS[1]);
  await Promise.resolve();
  const result = await settled;
  if (result.ok) return result.value;
  throw result.error;
}

describe('getSessions retries a transient Gate list read', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('a hung list read still finishes under the 30s transport ceiling', () => {
    // 3 attempts × 8s + 500ms + 1500ms = 26s. Stacking the 30s default
    // three times would pin the sheet for 92s on a dead gateway.
    const worstCaseMs =
      GET_SESSIONS_ATTEMPT_TIMEOUT_MS * (GET_SESSIONS_MAX_RETRIES + 1) +
      GET_SESSIONS_RETRY_BACKOFF_MS[0] +
      GET_SESSIONS_RETRY_BACKOFF_MS[1];
    expect(worstCaseMs).toBe(26_000);
    expect(worstCaseMs).toBeLessThan(30_000);
  });

  test('connect healthCheck is not shorter than the Tailscale discovery probe', () => {
    // 3s aborts a DERP handshake still in SynReceived. Discovery already
    // waits 12s for that path; a shorter connect probe would fail a host
    // that just passed reachability.
    expect(HEALTH_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(GATEWAY_PROBE_TIMEOUT_MS);
  });

  test('one network error then a success is two attempts, not a dead end', async () => {
    let v1Hits = 0;
    const fetchMock = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/v1/sessions')) {
        v1Hits += 1;
        if (v1Hits === 1) return Promise.reject(new TypeError('Network request failed'));
        return Promise.resolve(jsonResponse(SESSIONS));
      }
      return Promise.resolve(jsonResponse({ error: 'Not Found' }, 404));
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const sessions = await withRetryClock(() => new HermesGatewayClient(PROFILE).getSessions(20));

    expect(sessions).toHaveLength(2);
    expect(v1Calls(fetchMock)).toHaveLength(2);
    expect(apiCalls(fetchMock)).toHaveLength(0);
  });

  test('a 404 is not retried — the /api/sessions fallback fires once', async () => {
    const fetchMock = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/v1/sessions')) {
        return Promise.resolve(jsonResponse({ error: 'Not Found' }, 404));
      }
      if (url.includes('/api/sessions')) {
        return Promise.resolve(jsonResponse(SESSIONS));
      }
      return Promise.resolve(jsonResponse({}));
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const sessions = await withRetryClock(() => new HermesGatewayClient(PROFILE).getSessions(20));

    expect(sessions).toHaveLength(2);
    expect(v1Calls(fetchMock)).toHaveLength(1);
    expect(apiCalls(fetchMock)).toHaveLength(1);
  });

  test('three network failures propagate and resume does not create a session', async () => {
    const fetchMock = jest.fn((input: unknown, _init?: { method?: string }) => {
      const url = String(input);
      if (url.includes('/v1/sessions')) {
        return Promise.reject(new TypeError('Network request failed'));
      }
      return Promise.resolve(jsonResponse({}));
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = new HermesGatewayClient(PROFILE);
    const createSession = jest.spyOn(client, 'createSession');

    await expect(withRetryClock(() => client.getSessions(20))).rejects.toThrow(/network/i);
    expect(v1Calls(fetchMock)).toHaveLength(3);
    expect(apiCalls(fetchMock)).toHaveLength(0);

    await expect(withRetryClock(() => resolveResumeSession(client))).resolves.toEqual({
      sessionId: undefined,
      sessions: [],
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});
