import { ManifestClient } from '@/lib/gateway/manifest-client';
import { THREAD_SWITCH_BOUND_MS, validateThreadSwitch } from '@/lib/gateway/thread-switch';
import type { PortalClient } from '@/lib/portal/adapters';

// CONN-1, the client half. The tap validation read had no budget of its own: it
// raced the transport's 30 s default and then walked away, so a tap on a slow
// Gate left `POST /v1/capabilities/rpc` — and the catalogue read behind it on
// the Gate — running for the rest of those 30 s. Worse, 30 s is the same number
// the Gate's own session read uses, so which side gave up first was not a
// designed bound but a race. The bound now travels WITH the read.

const PROFILE = {
  id: 'g1',
  name: 'Test gate',
  url: 'http://gate.test:8760',
  kind: 'custom' as const,
  token: 'k',
  createdAt: 0,
};

const IDENTITY = {
  kind: 'custom' as const,
  kindLabel: 'Custom — versutus-gate',
  auth: { schemes: ['bearer' as const], requiresToken: true, grantPath: '/.well-known/gateway/access' },
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Test Gate',
    auth: { schemes: ['bearer' as const], grantPath: '/.well-known/gateway/access' },
    transport: { primary: 'http' as const },
    endpoints: { health: '/health', capabilitiesRpc: '/v1/capabilities/rpc' },
    capabilities: { chat: true, models: true },
  },
  source: 'manifest' as const,
  identifiedAt: 0,
};

/** A request whose transport is the real one, standing in for a slow read. */
function neverAnswers() {
  return jest.fn((_url: unknown, init: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('fetch failed: canceled')), { once: true });
  }));
}

async function clientWith(fetchImpl: jest.Mock) {
  (globalThis as { fetch: unknown }).fetch = fetchImpl;
  return new ManifestClient(PROFILE, IDENTITY as never, {});
}

describe('a capability read the caller has bounded stops when the caller stops waiting', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('the budget the caller names is the one the request runs under', async () => {
    const fetchMock = neverAnswers();
    const client = await clientWith(fetchMock as unknown as jest.Mock);

    const read = client.rpcRequest('session.restore', { sessionId: 's-1' }, { timeoutMs: 1_000 });
    const settled = read.catch((error: Error) => error);
    await Promise.resolve();

    const signal = (fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal }).signal;
    expect(signal).toBeDefined();

    jest.advanceTimersByTime(999);
    expect(signal?.aborted).toBe(false);

    jest.advanceTimersByTime(1);
    expect(signal?.aborted).toBe(true);
    await expect(settled).resolves.toThrow(/Request timed out: POST \/v1\/capabilities\/rpc/);
  });

  test('no budget leaves the transport default in place', async () => {
    const fetchMock = neverAnswers();
    const client = await clientWith(fetchMock as unknown as jest.Mock);

    const settled = client.rpcRequest('session.restore', { sessionId: 's-1' }).catch((error: Error) => error);
    await Promise.resolve();
    const signal = (fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal }).signal;

    jest.advanceTimersByTime(29_999);
    expect(signal?.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    await expect(settled).resolves.toThrow(/Request timed out/);
  });
});

describe('the tap validation hands its own bound to the read', () => {
  test('the read is asked for the bound the tap itself races', async () => {
    const request = jest.fn().mockResolvedValue({ sessionId: 's-1' });
    await validateThreadSwitch(request, 's-1', undefined, 250);

    expect(request).toHaveBeenCalledWith(
      'session.restore',
      { sessionId: 's-1' },
      { timeoutMs: 250 },
    );
  });

  test('the default bound is the one a tap waits for', async () => {
    const request = jest.fn().mockResolvedValue({});
    await validateThreadSwitch(request, 's-1');
    expect(request).toHaveBeenCalledWith(
      'session.restore',
      { sessionId: 's-1' },
      { timeoutMs: THREAD_SWITCH_BOUND_MS },
    );
  });

  test('a client that takes no options still works', async () => {
    // The direct-Hermes client and any older build answer the same two
    // arguments; the third is optional exactly so they do.
    const request: PortalClient['rpcRequest'] = jest.fn().mockResolvedValue({});
    await expect(validateThreadSwitch(request, 's-1')).resolves.toEqual({ ok: true });
    expect(request).toHaveBeenCalledWith('session.restore', { sessionId: 's-1' }, { timeoutMs: 8000 });
  });
});
