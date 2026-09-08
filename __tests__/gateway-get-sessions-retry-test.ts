import {
  GET_SESSIONS_ATTEMPT_TIMEOUT_MS,
  GET_SESSIONS_MAX_RETRIES,
  GET_SESSIONS_RETRY_BACKOFF_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  HermesGatewayClient,
} from '@/lib/gateway/client';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import { GATEWAY_PROBE_TIMEOUT_MS } from '@/lib/gateway/probe';
import { resolveResumeSession } from '@/lib/gateway/session-resume';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

declare const __dirname: string;
const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as { readFileSync(p: string, e: string): string };
const readSource = (...parts: string[]): string =>
  nodeFs.readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8').replace(/\r\n/g, '\n');

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

  test('both session-list clients call the shared retry helper', () => {
    // A Hermes-only test is what left ManifestClient (the live Versutus Gate
    // path) without the retry. Both bodies must go through the same helper.
    const hermes = readSource('src', 'lib', 'gateway', 'client.ts');
    const manifest = readSource('src', 'lib', 'gateway', 'manifest-client.ts');
    expect(hermes).toMatch(/withGetSessionsRetry/);
    expect(manifest).toMatch(/withGetSessionsRetry/);
  });

  test('ManifestClient.healthCheck uses HEALTH_CHECK_TIMEOUT_MS, not a private 12_000', () => {
    const src = readSource('src', 'lib', 'gateway', 'manifest-client.ts');
    expect(src).toMatch(/healthCheck\(timeoutMs = HEALTH_CHECK_TIMEOUT_MS\)/);
    expect(src).not.toMatch(/healthCheck\(timeoutMs = 12_000\)/);
  });
});

const MANIFEST_PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Test gate',
  url: 'http://gate.test:8760',
  kind: 'custom',
  token: 'k',
  createdAt: 0,
};

const MANIFEST_IDENTITY: GatewayIdentity = {
  kind: 'custom',
  kindLabel: 'Custom — versutus-gate',
  auth: { schemes: ['bearer'], requiresToken: true, grantPath: '/.well-known/gateway/access' },
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Test Gate',
    auth: { schemes: ['bearer'], grantPath: '/.well-known/gateway/access' },
    transport: { primary: 'http' },
    endpoints: { health: '/health', sessions: '/v1/sessions' },
    capabilities: { chat: true, sessions: true },
  },
  source: 'manifest',
  identifiedAt: 0,
};

function manifestClient(endpoints: Record<string, string> = { health: '/health', sessions: '/v1/sessions' }) {
  const identity: GatewayIdentity = {
    ...MANIFEST_IDENTITY,
    manifest: { ...MANIFEST_IDENTITY.manifest!, endpoints },
  };
  return new ManifestClient(MANIFEST_PROFILE, identity, {});
}

function sessionCalls(fetchMock: jest.Mock): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.includes('/sessions'));
}

describe('ManifestClient.getSessions retries a transient list read', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('one network error then a success is two attempts, not a dead end', async () => {
    let hits = 0;
    const fetchMock = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/v1/sessions')) {
        hits += 1;
        if (hits === 1) return Promise.reject(new TypeError('Network request failed'));
        return Promise.resolve(jsonResponse(SESSIONS));
      }
      return Promise.resolve(jsonResponse({ error: 'Not Found' }, 404));
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const sessions = await withRetryClock(() => manifestClient().getSessions(20));

    expect(sessions).toHaveLength(2);
    expect(sessionCalls(fetchMock)).toHaveLength(2);
  });

  test('a 5xx then a success retries the advertised path, never a guessed one', async () => {
    let hits = 0;
    const fetchMock = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/v1/sessions')) {
        hits += 1;
        if (hits === 1) {
          return Promise.resolve(jsonResponse({ error: { message: 'sessions exploded' } }, 500));
        }
        return Promise.resolve(jsonResponse(SESSIONS));
      }
      return Promise.resolve(jsonResponse({}));
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const sessions = await withRetryClock(() => manifestClient().getSessions(20));

    expect(sessions).toHaveLength(2);
    expect(sessionCalls(fetchMock)).toHaveLength(2);
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('/api/sessions'))).toBe(true);
  });

  test('a 404 on the advertised path is not retried', async () => {
    const fetchMock = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/v1/sessions')) {
        return Promise.resolve(jsonResponse({ error: 'Not Found' }, 404));
      }
      return Promise.resolve(jsonResponse(SESSIONS));
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    await expect(withRetryClock(() => manifestClient().getSessions(20))).rejects.toThrow(/not found/i);
    expect(sessionCalls(fetchMock)).toHaveLength(1);
  });

  test('no sessions endpoint throws immediately, with no fetch and no retry', async () => {
    const fetchMock = jest.fn();
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    await expect(manifestClient({ health: '/health' }).getSessions()).rejects.toThrow(
      /does not advertise session management/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('createSession is not retried on 5xx — POST is not idempotent', async () => {
    const fetchMock = jest.fn((input: unknown, _init?: { method?: string }) => {
      const url = String(input);
      if (url.includes('/v1/sessions')) {
        return Promise.resolve(jsonResponse({ error: { message: 'create failed' } }, 500));
      }
      return Promise.resolve(jsonResponse({}));
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    await expect(withRetryClock(() => manifestClient().createSession('notes'))).rejects.toThrow(/create failed/);
    expect(sessionCalls(fetchMock)).toHaveLength(1);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true);
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

    const client = manifestClient();
    const createSession = jest.spyOn(client, 'createSession');

    await expect(withRetryClock(() => client.getSessions(20))).rejects.toThrow(/network/i);
    expect(sessionCalls(fetchMock)).toHaveLength(3);

    await expect(withRetryClock(() => resolveResumeSession(client))).resolves.toEqual({
      sessionId: undefined,
      sessions: [],
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});
