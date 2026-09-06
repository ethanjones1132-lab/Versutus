import { probeGatewayCandidates, probeHighPriorityCandidates } from '@/lib/gateway/probe';

function okResponse() {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

function failedResponse(status = 500) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('probeGatewayCandidates fallback pool', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('prefers the earliest-listed healthy candidate even when a later one answers first', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.startsWith('http://slow:8641')) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(okResponse()), 30);
        });
      }
      return Promise.resolve(okResponse());
    });

    const result = await probeGatewayCandidates(
      ['http://slow:8641', 'http://fast:8642'],
      undefined,
      2000,
    );

    expect(result?.ok).toBe(true);
    expect(result?.ok && result.url).toBe('http://slow:8641');
    expect((globalThis.fetch as jest.Mock).mock.calls.length).toBe(2);
  });

  test('starts the tail concurrently through the capped pool instead of one at a time', async () => {
    const gates = [
      deferred<Response>(),
      deferred<Response>(),
      deferred<Response>(),
      deferred<Response>(),
    ];
    const fetchMock = jest.fn((input: unknown) => {
      const url = String(input);
      const index = ['http://a:8641', 'http://b:8642', 'http://c:8643', 'http://d:8644'].indexOf(
        url.replace(/\/health$/, ''),
      );
      return gates[index].promise;
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const run = probeGatewayCandidates(
      ['http://a:8641', 'http://b:8642', 'http://c:8643', 'http://d:8644'],
      undefined,
      2000,
    );

    // The pool cap (3) starts three lanes at once; a serial loop would have
    // started exactly one, and an uncapped fan-out would have started four.
    expect(fetchMock.mock.calls.length).toBe(3);

    for (const gate of gates) gate.resolve(failedResponse());
    await expect(run).resolves.toBeNull();
  });

  test('reports each attempt via onProgress and resolves null when none answer', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(failedResponse()),
    );
    const messages: string[] = [];

    const result = await probeGatewayCandidates(
      ['http://a:8641', 'http://b:8642'],
      (message) => messages.push(message),
      2000,
    );

    expect(result).toBeNull();
    expect(messages.length).toBe(2);
    expect(messages[0]).toContain('a');
    expect(messages[1]).toContain('b');
  });

  test('resolves null without fetching when there are no candidates', async () => {
    const fetchMock = jest.fn(() => Promise.resolve(okResponse()));
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    const messages: string[] = [];

    await expect(
      probeGatewayCandidates([], (message) => messages.push(message)),
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(messages).toEqual([]);
  });
});

describe('probeHighPriorityCandidates manifest preference', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  function manifestResponse() {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ manifest: 'versutus-gateway/1.0' }),
    } as unknown as Response;
  }

  function routeFetch(manifestHosts: string[], manifestGates?: Map<string, ReturnType<typeof deferred<Response>>>) {
    return jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/.well-known/gateway.json')) {
        const gated = manifestGates
          ? [...manifestGates.entries()].find(([host]) => url.startsWith(host))
          : undefined;
        if (gated) return gated[1].promise;
        const host = manifestHosts.find((h) => url.startsWith(h));
        return Promise.resolve(host ? manifestResponse() : okResponse());
      }
      return Promise.resolve(okResponse());
    });
  }

  test('prefers the manifest-bearing gate over an earlier bare /health', async () => {
    (globalThis as { fetch: unknown }).fetch = routeFetch(['http://gate:8642']);
    const result = await probeHighPriorityCandidates(
      ['http://bare:8641', 'http://gate:8642'],
      undefined,
      2000,
    );
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.url).toBe('http://gate:8642');
  });

  test('returns the first success when no manifest answers', async () => {
    const fetchMock = routeFetch([]);
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    const result = await probeHighPriorityCandidates(
      ['http://a:8641', 'http://b:8642'],
      undefined,
      2000,
    );
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.url).toBe('http://a:8641');
  });

  test('resolves null when no high-priority candidate answers', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(failedResponse()),
    );
    await expect(
      probeHighPriorityCandidates(['http://a:8641', 'http://b:8642'], undefined, 2000),
    ).resolves.toBeNull();
  });

  test('fires the manifest checks together instead of one at a time', async () => {
    const gates = new Map([
      ['http://a:8641', deferred<Response>()],
      ['http://b:8642', deferred<Response>()],
    ]);
    const fetchMock = routeFetch([], gates);
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const run = probeHighPriorityCandidates(
      ['http://a:8641', 'http://b:8642'],
      undefined,
      2000,
    );
    // Let the /health wave settle so both manifest reads are in flight.
    // A serial walk would have started exactly one manifest fetch here.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const manifestCalls = fetchMock.mock.calls.filter((call: unknown[]) =>
      String(call[0]).endsWith('/.well-known/gateway.json'),
    );
    expect(manifestCalls.length).toBe(2);

    gates.get('http://a:8641')!.resolve(okResponse());
    gates.get('http://b:8642')!.resolve(manifestResponse());
    const result = await run;
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.url).toBe('http://b:8642');
  });
});
