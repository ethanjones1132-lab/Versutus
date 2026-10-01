import {
  PROBE_FIRST_CHUNK_TIMEOUT_MS,
  PROBE_HEADER_TIMEOUT_MS,
  probeRuntimeGlobals,
  probeStreamingFetch,
} from '@/lib/runtime-environment';
import { installStreamingFetch } from '@/lib/net/streaming-fetch';

afterEach(() => installStreamingFetch(globalThis.fetch));

describe('probeRuntimeGlobals', () => {
  test('reports a React-Native-shaped engine honestly', () => {
    // whatwg-fetch's Response has no `body`, TextEncoder/atob/btoa are absent,
    // and Expo installs TextDecoder/URL. This is the real device shape.
    const rnLike = {
      Response: function Response() {} as unknown as { prototype: object },
      TextDecoder: () => undefined,
      ReadableStream: () => undefined,
      URL: () => undefined,
      URLSearchParams: () => undefined,
    } as unknown as Record<string, unknown>;

    const byId = Object.fromEntries(probeRuntimeGlobals(rnLike).map((c) => [c.id, c]));

    expect(byId['global-fetch-streaming'].ok).toBe(false);
    // Expected on RN, so it must not be flagged as breaking anything.
    expect(byId['global-fetch-streaming'].critical).toBe(false);
    expect(byId['text-decoder'].ok).toBe(true);
    expect(byId['url'].ok).toBe(true);
    // Absent, but the app no longer depends on them.
    expect(byId['base64'].ok).toBe(false);
    expect(byId['base64'].critical).toBe(false);
    expect(byId['text-encoder'].ok).toBe(false);
    expect(byId['text-encoder'].critical).toBe(false);
  });

  test('nothing critical fails on an engine that has everything', () => {
    const checks = probeRuntimeGlobals();
    const brokenCritical = checks.filter((c) => c.critical && !c.ok);
    expect(brokenCritical).toEqual([]);
  });

  test('a missing critical global is reported as critical', () => {
    const stripped = probeRuntimeGlobals({} as Record<string, unknown>);
    expect(stripped.find((c) => c.id === 'text-decoder')).toMatchObject({ ok: false, critical: true });
    expect(stripped.find((c) => c.id === 'readable-stream')).toMatchObject({ ok: false, critical: true });
  });
});

describe('probeStreamingFetch', () => {
  test('passes when the installed fetch yields a reader', async () => {
    installStreamingFetch((async () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":"ok"}'));
          controller.close();
        },
      }))) as unknown as typeof globalThis.fetch);

    const check = await probeStreamingFetch('http://gate.test/health');
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/incrementally/);
  });

  test('fails loudly when the response has no body — the device bug', async () => {
    // This is exactly what React Native's fetch returns, and what every test in
    // this repo previously could not observe.
    installStreamingFetch((async () => ({ body: undefined })) as unknown as typeof globalThis.fetch);

    const check = await probeStreamingFetch('http://gate.test/health');
    expect(check.ok).toBe(false);
    expect(check.critical).toBe(true);
    expect(check.detail).toMatch(/Shell tab cannot work/);
  });

  test('a network failure is reported, not thrown', async () => {
    installStreamingFetch((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof globalThis.fetch);
    const check = await probeStreamingFetch('http://gate.test/health');
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/ECONNREFUSED/);
  });
});

// The half-open path: a gateway that accepts the connection and then says
// nothing — what a Tailscale/DERP route that has gone bad looks like from the
// phone. This screen exists to diagnose exactly that, so a probe that hangs on
// it reproduces the failure it was opened to name. Both awaits (headers, first
// chunk) are therefore bounded, and the bound is reported as a failed check.
describe('probeStreamingFetch is bounded on both awaits', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    installStreamingFetch(globalThis.fetch);
  });

  test('headers that never arrive fail at the header deadline', async () => {
    // The engine ignores the signal entirely here, so only the probe's own
    // rejection can settle it.
    installStreamingFetch((() => new Promise(() => {})) as unknown as typeof globalThis.fetch);

    const probe = probeStreamingFetch('http://gate.test/health');
    await jest.advanceTimersByTimeAsync(PROBE_HEADER_TIMEOUT_MS);

    const check = await probe;
    expect(check.ok).toBe(false);
    expect(check.critical).toBe(true);
    expect(check.detail).toBe('The gateway did not answer within 8 s');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('an engine that honours the abort still reports the deadline, not the AbortError', async () => {
    // The message an operator reads must name the timeout. A raw AbortError
    // ("The user aborted a request") names a cancellation nobody performed.
    let signal: AbortSignal | undefined;
    installStreamingFetch(((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('The user aborted a request.')));
      });
    }) as unknown as typeof globalThis.fetch);

    const probe = probeStreamingFetch('http://gate.test/health');
    await jest.advanceTimersByTimeAsync(PROBE_HEADER_TIMEOUT_MS);

    const check = await probe;
    expect(signal?.aborted).toBe(true);
    expect(check.detail).toBe('The gateway did not answer within 8 s');
  });

  test('headers that arrive and then silence fail at the first-chunk deadline', async () => {
    installStreamingFetch((async () =>
      new Response(new ReadableStream({
        start() {
          // Accepts the connection, sends nothing, never closes.
        },
      }))) as unknown as typeof globalThis.fetch);

    const probe = probeStreamingFetch('http://gate.test/health');
    await jest.advanceTimersByTimeAsync(PROBE_HEADER_TIMEOUT_MS + PROBE_FIRST_CHUNK_TIMEOUT_MS);

    const check = await probe;
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('The gateway did not answer within 8 s');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('the deadlines are injectable, so the bounds can be tested without spending them', async () => {
    installStreamingFetch((() => new Promise(() => {})) as unknown as typeof globalThis.fetch);

    const probe = probeStreamingFetch('http://gate.test/health', { headerTimeoutMs: 250 });
    await jest.advanceTimersByTimeAsync(250);

    expect((await probe).detail).toBe('The gateway did not answer within 0.25 s');
  });

  test('a normal answer is unchanged, and the header timer is cleared behind it', async () => {
    installStreamingFetch((async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"status":"ok"}'));
          controller.close();
        },
      }));
    }) as unknown as typeof globalThis.fetch);

    const check = await probeStreamingFetch('http://gate.test/health');
    expect(check.ok).toBe(true);
    expect(check.detail).toMatch(/incrementally/);
    expect(jest.getTimerCount()).toBe(0);
  });
});
