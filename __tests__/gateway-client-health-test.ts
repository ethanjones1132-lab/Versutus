import { HermesGatewayClient } from '@/lib/gateway/client';
import type { ConnectionStatus, GatewayProfile } from '@/lib/gateway/types';

const PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Test gateway',
  url: 'http://gateway.test:8642',
  kind: 'hermes',
  token: 'k',
  createdAt: 0,
};

const HEALTH = { status: 'ok', platform: 'hermes-agent', version: '0.18.0' };
const CAPABILITIES = { object: 'caps', features: { chat_completions: true } };

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const UNAUTHORIZED = {
  error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' },
};

/**
 * Routes by path so tests set outcomes rather than counting calls.
 * `/health` is public here, matching the real gateway.
 */
function mockGateway() {
  const state = { healthUp: true, capabilitiesStatus: 200 };
  mockGatewayFetch(state);
  return state;
}

/** Installs the fetch mock for `state` and returns it, for header assertions. */
function mockGatewayFetch(state: { healthUp: boolean; capabilitiesStatus: number }) {
  const fetchMock = jest.fn((input: unknown, _init?: unknown) => {
    const url = String(input);
    if (url.includes('/health')) {
      return state.healthUp
        ? Promise.resolve(jsonResponse(HEALTH))
        : Promise.reject(new TypeError('Network request failed'));
    }
    if (url.includes('/v1/capabilities')) {
      if (state.capabilitiesStatus === 200) return Promise.resolve(jsonResponse(CAPABILITIES));
      if (state.capabilitiesStatus === 401) {
        return Promise.resolve(jsonResponse(UNAUTHORIZED, 401));
      }
      return Promise.resolve(jsonResponse({ detail: 'Not Found' }, state.capabilitiesStatus));
    }
    return Promise.resolve(jsonResponse({}));
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}

describe('HermesGatewayClient health monitoring', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('a single failed health sample does not drop the connection', async () => {
    const gateway = mockGateway();
    const statuses: ConnectionStatus[] = [];
    const client = new HermesGatewayClient(PROFILE, {
      onStatus: (status) => statuses.push(status),
    });

    await client.connect();
    expect(client.connectionStatus).toBe('connected');

    gateway.healthUp = false;
    await jest.advanceTimersByTimeAsync(30_000);

    expect(statuses).not.toContain('reconnecting');
    expect(client.connectionStatus).toBe('connected');

    client.disconnect();
  });

  test('two consecutive failed samples drop the connection', async () => {
    const gateway = mockGateway();
    const client = new HermesGatewayClient(PROFILE, {});

    await client.connect();
    gateway.healthUp = false;

    await jest.advanceTimersByTimeAsync(30_000);
    expect(client.connectionStatus).toBe('connected');

    await jest.advanceTimersByTimeAsync(30_000);
    expect(client.connectionStatus).toBe('reconnecting');

    client.disconnect();
  });

  test('recovered health cancels the pending reconnect instead of flapping', async () => {
    const gateway = mockGateway();
    const statuses: ConnectionStatus[] = [];
    const client = new HermesGatewayClient(PROFILE, {
      onStatus: (status) => statuses.push(status),
    });

    await client.connect();
    gateway.healthUp = false;
    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(client.connectionStatus).toBe('reconnecting');

    // Gateway comes back. The next health tick should adopt it and drop the
    // queued reconnect; a stale reconnect would bounce us through 'connecting'.
    gateway.healthUp = true;
    await jest.advanceTimersByTimeAsync(30_000);
    expect(client.connectionStatus).toBe('connected');

    statuses.length = 0;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(statuses).not.toContain('connecting');
    expect(client.connectionStatus).toBe('connected');

    client.disconnect();
  });

  test('connect surfaces an auth rejection instead of retrying forever', async () => {
    const gateway = mockGateway();
    gateway.capabilitiesStatus = 401;

    const client = new HermesGatewayClient(PROFILE, {});
    await expect(client.connect()).rejects.toThrow(/api key/i);
    expect(client.connectionStatus).toBe('disconnected');

    // No reconnect storm behind the rejection.
    await jest.advanceTimersByTimeAsync(120_000);
    expect(client.connectionStatus).toBe('disconnected');

    client.disconnect();
  });

  test('a busy gateway that still serves real requests is not declared down', async () => {
    // Hermes single-threads request handling: a slow /api/sessions blocks
    // /health too. Health timeouts must not disconnect a gateway that is
    // demonstrably still answering us.
    const gateway = mockGateway();
    const client = new HermesGatewayClient(PROFILE, {});
    await client.connect();

    gateway.healthUp = false;
    for (let tick = 0; tick < 4; tick += 1) {
      // A real call succeeds mid-cycle, proving the gateway is alive, then the
      // health tick fires and finds /health still stalled.
      await jest.advanceTimersByTimeAsync(15_000);
      await client.getModels().catch(() => undefined);
      await jest.advanceTimersByTimeAsync(15_000);
    }

    expect(client.connectionStatus).toBe('connected');

    // Once the gateway stops answering anything at all, it is reported down.
    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(client.connectionStatus).toBe('reconnecting');

    client.disconnect();
  });

  test('a token with stray whitespace still produces a valid header', async () => {
    // OkHttp rejects the request outright on a control character in a header
    // value, which fails every authenticated call while unauthenticated probes
    // to the same host keep working.
    const fetchMock = mockGatewayFetch(mockGateway());
    const client = new HermesGatewayClient(
      { ...PROFILE, token: '  secret-key-value\n' },
      {},
    );

    await client.connect();

    const authHeaders = fetchMock.mock.calls
      .map(([, init]) => (init as RequestInit | undefined)?.headers as Record<string, string>)
      .filter(Boolean)
      .map((headers) => headers['Authorization'])
      .filter(Boolean);

    expect(authHeaders.length).toBeGreaterThan(0);
    for (const header of authHeaders) {
      expect(header).toBe('Bearer secret-key-value');
      expect(header).not.toMatch(/[^\x20-\x7E]/);
    }

    client.disconnect();
  });

  test('a reachable gateway without a capability catalog still connects', async () => {
    const gateway = mockGateway();
    gateway.capabilitiesStatus = 404;

    const client = new HermesGatewayClient(PROFILE, {});
    await client.connect();
    expect(client.connectionStatus).toBe('connected');

    client.disconnect();
  });
});

describe('HermesGatewayClient connect concurrency', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    // Fake timers so a monitor interval started by a test that fails before
    // its disconnect() cannot leak a real handle and stall the worker.
    jest.useRealTimers();
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  const flushMicrotasks = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  test('resumeReconnect during an in-flight connect joins it instead of refetching everything', async () => {
    let releaseHealth!: (response: Response) => void;
    const healthHold = new Promise<Response>((resolve) => {
      releaseHealth = resolve;
    });
    const urls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/health')) return healthHold;
      return Promise.resolve(jsonResponse(CAPABILITIES));
    });

    const client = new HermesGatewayClient(PROFILE, {});
    const first = client.connect();
    // Fires while the attempt above is still parked on /health — this used to
    // stack a second full attempt (health + capabilities again) that raced its
    // sibling through the status machine.
    client.resumeReconnect();

    releaseHealth(jsonResponse(HEALTH));
    await first;
    await flushMicrotasks();

    expect(client.connectionStatus).toBe('connected');
    expect(urls.filter((u) => u.includes('/health'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/v1/capabilities'))).toHaveLength(1);
    client.disconnect();
  });

  test('two simultaneous connect() calls share one attempt', async () => {
    const urls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/health')) return Promise.resolve(jsonResponse(HEALTH));
      return Promise.resolve(jsonResponse(CAPABILITIES));
    });

    const client = new HermesGatewayClient(PROFILE, {});
    await Promise.all([client.connect(), client.connect()]);

    expect(client.connectionStatus).toBe('connected');
    expect(urls.filter((u) => u.includes('/health'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/v1/capabilities'))).toHaveLength(1);
    client.disconnect();
  });

  test('after a failed attempt a later connect starts fresh rather than joining the corpse', async () => {
    // Pins the clear-on-settle semantics: if the handle ever went sticky after
    // a rejection, every later connect() would re-throw the stale failure and
    // the session could never recover without an app restart.
    const state = { capabilitiesStatus: 401 };
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.includes('/health')) return Promise.resolve(jsonResponse(HEALTH));
      if (url.includes('/v1/capabilities')) {
        return state.capabilitiesStatus === 200
          ? Promise.resolve(jsonResponse(CAPABILITIES))
          : Promise.resolve(jsonResponse(UNAUTHORIZED, 401));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const client = new HermesGatewayClient(PROFILE, {});
    await expect(client.connect()).rejects.toThrow(/api key/i);

    state.capabilitiesStatus = 200;
    await client.connect();

    expect(client.connectionStatus).toBe('connected');
    client.disconnect();
  });
});
