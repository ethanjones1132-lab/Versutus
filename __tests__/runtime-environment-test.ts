import { probeRuntimeGlobals, probeStreamingFetch } from '@/lib/runtime-environment';
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
