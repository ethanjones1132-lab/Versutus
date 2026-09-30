import {
  probeGatewayCandidates,
  probeGatewayUrl,
  probeHighPriorityCandidates,
  PROBE_PRIORITY_GRACE_MS,
} from '@/lib/gateway/probe';

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
    jest.useRealTimers();
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

  test('checks the chosen success’s manifest first, then falls back to another success', async () => {
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
    // Let the /health wave settle so the chosen success's manifest read is in
    // flight. The chosen (highest-priority) success is checked first — one
    // manifest call, not a fan-out over every success.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const manifestCalls = () =>
      fetchMock.mock.calls.filter((call: unknown[]) =>
        String(call[0]).endsWith('/.well-known/gateway.json'),
      );
    expect(manifestCalls().length).toBe(1);
    expect(String(manifestCalls()[0][0])).toContain('a:8641');

    // The chosen lacks a manifest; the fallback's manifest check fires next.
    gates.get('http://a:8641')!.resolve(okResponse());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manifestCalls().length).toBe(2);
    expect(String(manifestCalls()[1][0])).toContain('b:8642');

    gates.get('http://b:8642')!.resolve(manifestResponse());
    const result = await run;
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.url).toBe('http://b:8642');
    expect(result?.ok && result.hasManifest).toBe(true);
  });

  test('races the fallback manifest checks instead of asking one at a time', async () => {
    jest.useFakeTimers();
    const gates = new Map([
      ['http://b:8642', deferred<Response>()],
      ['http://c:8643', deferred<Response>()],
      ['http://d:8644', deferred<Response>()],
    ]);
    const fetchMock = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/.well-known/gateway.json')) {
        // The chosen success (a) answers at once, without a manifest; every
        // other manifest read stays in flight until the test releases it.
        const gate = gates.get(url.replace('/.well-known/gateway.json', ''));
        return gate ? gate.promise : Promise.resolve(okResponse());
      }
      return Promise.resolve(okResponse());
    });
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    const manifestHosts = () =>
      fetchMock.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .filter((url) => url.endsWith('/.well-known/gateway.json'))
        .map((url) => url.replace('/.well-known/gateway.json', ''));

    const run = probeHighPriorityCandidates(
      ['http://a:8641', 'http://b:8642', 'http://c:8643', 'http://d:8644'],
      undefined,
      10_000,
    );
    await jest.advanceTimersByTimeAsync(0);
    // The chosen (highest-priority) success is asked first; every remaining
    // check then goes out together. A serial loop would leave only b in flight
    // and cost the wave one manifest budget per success.
    expect(manifestHosts()).toEqual([
      'http://a:8641',
      'http://b:8642',
      'http://c:8643',
      'http://d:8644',
    ]);

    gates.get('http://b:8642')!.resolve(manifestResponse());
    const result = await run;
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.url).toBe('http://b:8642');
    expect(result?.ok && result.hasManifest).toBe(true);
  });
});

describe('probeHighPriorityCandidates first-success probing', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
    jest.useRealTimers();
  });

  async function flushMicrotasks() {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  function manifestResponse() {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve({ manifest: 'versutus-gateway/1.0' }),
    } as unknown as Response;
  }

  test('a fast success returns before a black-holed candidate settles', async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init: RequestInit) => {
      const url = String(input);
      signals.push(init.signal!);
      if (url.startsWith('http://fast:8641')) {
        return Promise.resolve(okResponse());
      }
      return new Promise<Response>(() => {});
    });

    const result = await probeHighPriorityCandidates(
      ['http://fast:8641', 'http://blackhole:8642'],
      undefined,
      10_000,
    );

    expect(result?.ok).toBe(true);
    expect(result?.ok && result.url).toBe('http://fast:8641');
    // The black-holed probe is aborted, not left running.
    expect(signals[1]?.aborted).toBe(true);
  });

  test('a higher-priority success within the grace wins over an earlier lower one', async () => {
    const gates = new Map([
      ['http://slow:8641', deferred<Response>()],
      ['http://fast:8642', deferred<Response>()],
    ]);
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input).replace(/\/health$/, '');
      const gate = gates.get(url);
      if (!gate) return Promise.resolve(okResponse());
      return gate.promise;
    });

    const run = probeHighPriorityCandidates(
      ['http://slow:8641', 'http://fast:8642'],
      undefined,
      10_000,
    );

    // Let both /health probes start, then answer the lower-priority one first.
    await flushMicrotasks();
    gates.get('http://fast:8642')!.resolve(okResponse());
    await flushMicrotasks();
    // The higher-priority one answers within the priority grace.
    gates.get('http://slow:8641')!.resolve(okResponse());

    const result = await run;
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.url).toBe('http://slow:8641');
  });

  test('a priority-0 gate on a slow relay outranks a priority-1 /health that answers first', async () => {
    jest.useFakeTimers();
    const manifestHosts: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/.well-known/gateway.json')) {
        manifestHosts.push(url.replace('/.well-known/gateway.json', ''));
        return Promise.resolve(manifestResponse());
      }
      // A Tailscale/DERP hop measured at 0.9-1.7s RTT with loss, against a
      // bare Hermes on a fast local address.
      const delay = url.startsWith('http://slow-gate:8641') ? 1_500 : 50;
      return new Promise<Response>((resolve) => setTimeout(() => resolve(okResponse()), delay));
    });

    const run = probeHighPriorityCandidates(
      ['http://slow-gate:8641', 'http://bare:8642'],
      undefined,
      10_000,
    );
    await jest.advanceTimersByTimeAsync(1_600);

    const result = await run;
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.url).toBe('http://slow-gate:8641');
    // The winning gate is manifest-checked, not skipped as an aborted probe.
    expect(manifestHosts[0]).toBe('http://slow-gate:8641');
    expect(result?.ok && result.hasManifest).toBe(true);
  });

  test('a lower-priority success stands when a higher-priority probe stays black-holed', async () => {
    jest.useFakeTimers();
    const signals: AbortSignal[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown, init: RequestInit) => {
      const url = String(input);
      signals.push(init.signal!);
      if (url.startsWith('http://fast:8642')) {
        return Promise.resolve(okResponse());
      }
      return new Promise<Response>(() => {});
    });

    const run = probeHighPriorityCandidates(
      ['http://blackhole:8641', 'http://fast:8642'],
      undefined,
      10_000,
    );
    // Let the fast success land and start the priority grace.
    await flushMicrotasks();
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    // The grace is a wait, not a guess: a black hole is still given the time a
    // relay hop needs (measured at 0.9-1.7s RTT)...
    await jest.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    // ...and it must not hold the wave for the full 10s probe timeout either.
    await jest.advanceTimersByTimeAsync(PROBE_PRIORITY_GRACE_MS - 900);
    const result = await run;
    expect(result?.ok).toBe(true);
    expect(result?.ok && result.url).toBe('http://fast:8642');
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe('probeGatewayUrl body release', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('a successful probe cancels the response body', async () => {
    let cancelled = false;
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: {
          cancel: () => {
            cancelled = true;
            return Promise.resolve();
          },
        },
      } as unknown as Response),
    );

    const result = await probeGatewayUrl('http://gate:8642', 2000);
    expect(result.ok).toBe(true);
    // Only the status was needed: the body is released, not left open until GC.
    expect(cancelled).toBe(true);
  });

  test('a refused probe cancels the response body too', async () => {
    let cancelled = false;
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        body: {
          cancel: () => {
            cancelled = true;
            return Promise.resolve();
          },
        },
      } as unknown as Response),
    );

    const result = await probeGatewayUrl('http://gate:8642', 2000);
    expect(result.ok).toBe(false);
    // A refusal only needed the status too: the body is released, not left
    // open until GC.
    expect(cancelled).toBe(true);
  });
});
