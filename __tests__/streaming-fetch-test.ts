import { ManifestClient } from '@/lib/gateway/manifest-client';
import { createEnvironmentClient } from '@/lib/gateway/environment-client';
import {
  installStreamingFetch,
  resetStreamingFetchForTests,
  streamingFetch,
} from '@/lib/net/streaming-fetch';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

/**
 * React Native's global fetch is whatwg-fetch over XMLHttpRequest, whose
 * Response has no `body` at all — so `response.body?.getReader()` is undefined
 * and every SSE reader threw "No response body to stream" on device. Streaming
 * chat and the Shell tab could not work, however correctly the Gate streamed.
 *
 * The device half of that cannot be reproduced here: Node's fetch does expose a
 * readable body, which is exactly why the bug survived a green test suite. What
 * these lock down instead is the seam — that streaming call sites go through
 * the installed implementation rather than the global one.
 */

const PROFILE: GatewayProfile = {
  id: 'g1', name: 'Gate', url: 'http://gate.test:8760', kind: 'custom', token: 'k', createdAt: 0,
};

const IDENTITY: GatewayIdentity = {
  kind: 'custom',
  kindLabel: 'Custom — versutus-gate',
  auth: { schemes: ['bearer'], requiresToken: true, grantPath: '/.well-known/gateway/access' },
  manifest: {
    manifest: 'versutus-gateway/v1', kind: 'versutus-gate', name: 'Gate',
    auth: { schemes: ['bearer'], grantPath: '/.well-known/gateway/access' },
    transport: { primary: 'http' },
    endpoints: { chat: '/v1/chat/completions' },
    capabilities: { chat: true },
  },
  source: 'manifest',
  identifiedAt: 0,
};

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
      controller.close();
    },
  }), { status: 200 });
}

afterEach(() => {
  // Back to the pristine state so tests cannot leak into each other. A bare
  // reinstall of globalThis.fetch would mask the uninstalled paths below.
  resetStreamingFetchForTests();
});

describe('streamingFetch', () => {
  test('delegates to the implementation the app installs', async () => {
    const calls: string[] = [];
    installStreamingFetch((async (url: string) => {
      calls.push(String(url));
      return new Response('ok', { status: 200 });
    }) as unknown as typeof globalThis.fetch);

    const res = await streamingFetch('http://example.test/stream');
    expect(await res.text()).toBe('ok');
    expect(calls).toEqual(['http://example.test/stream']);
  });

  test('resolves the implementation per call, not at import', async () => {
    // Capturing at module load is what broke mocking, and would silently pin
    // whichever fetch existed first at startup.
    installStreamingFetch((async () => new Response('first')) as unknown as typeof globalThis.fetch);
    installStreamingFetch((async () => new Response('second')) as unknown as typeof globalThis.fetch);
    expect(await (await streamingFetch('http://x.test')).text()).toBe('second');
  });
});

describe('streaming call sites', () => {
  test('streamChat reads through the installed fetch, not the global one', async () => {
    let usedInstalled = false;
    installStreamingFetch((async () => {
      usedInstalled = true;
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'to' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ken' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    }) as unknown as typeof globalThis.fetch);

    const globalFetch = jest.spyOn(globalThis, 'fetch');
    const deltas: string[] = [];
    const client = new ManifestClient(PROFILE, IDENTITY, {});
    const full = await client.streamChat([{ role: 'user', content: 'hi' }], (d) => deltas.push(d), {
      model: 'test/model',
    });

    expect(usedInstalled).toBe(true);
    expect(globalFetch).not.toHaveBeenCalled();
    // Arriving as separate deltas is the whole point — one block means no live feed.
    expect(deltas).toEqual(['to', 'ken']);
    expect(full).toBe('token');
    globalFetch.mockRestore();
  });

  test('the CLI run event stream reads through the installed fetch, not the global one', async () => {
    let usedInstalled = false;
    installStreamingFetch((async () => {
      usedInstalled = true;
      return sseResponse([
        `data: ${JSON.stringify({ type: 'run.started' })}\n\n`,
        `data: ${JSON.stringify({ type: 'run.output', payload: { text: 'pong', stream: 'stdout' } })}\n\n`,
        `data: ${JSON.stringify({ type: 'run.completed', payload: { exitCode: 0 } })}\n\n`,
      ]);
    }) as unknown as typeof globalThis.fetch);

    const globalFetch = jest.spyOn(globalThis, 'fetch');
    const client = new ManifestClient(PROFILE, IDENTITY, {});
    // Same wiring as production: gateway-provider.gatewayFetch hands the
    // environments section client.authorizedFetch, and streamRun reads the SSE
    // body off the response. On device a plain-fetch response has no body at
    // all, so this seam is what makes the streamed reply arrive — or not.
    const environments = createEnvironmentClient(
      async <T,>() => undefined as T,
      (path, init) => client.authorizedFetch(path, init),
    );
    const types: string[] = [];
    await environments.streamRun('env-1', 'r-1', (event) => types.push(event.type));

    expect(usedInstalled).toBe(true);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(types).toEqual(['run.started', 'run.output', 'run.completed']);
    globalFetch.mockRestore();
  });
});

describe('before any installation', () => {
  /**
   * Stands in for whatwg-fetch's Response under React Native — its prototype
   * has no `body` (the exact shape recorded in streaming-fetch.ts). This is
   * the half of the fb46406 bug that Node cannot reproduce by default: there
   * the global CAN stream, so a blind fallback was indistinguishable from a
   * correct one and every test stayed green while device streams came empty.
   */
  function bodylessResponseCtor(): { new (): Response } {
    const ctor = function (this: { bodyUsed: boolean }) {
      this.bodyUsed = false;
    } as unknown as { new (): Response };
    Object.defineProperty(ctor, 'prototype', { value: { bodyUsed: false } });
    return ctor;
  }

  function useDeviceClassGlobals(): () => void {
    const original = globalThis.Response;
    Object.defineProperty(globalThis, 'Response', {
      value: bodylessResponseCtor(),
      configurable: true,
      writable: true,
    });
    return () => {
      Object.defineProperty(globalThis, 'Response', {
        value: original,
        configurable: true,
        writable: true,
      });
    };
  }

  test('a device-class global fails named instead of returning a body-less response', () => {
    const restoreGlobals = useDeviceClassGlobals();
    try {
      expect(() => streamingFetch('http://x.test')).toThrow(/installStreamingFetch/);
    } finally {
      restoreGlobals();
    }
  });

  test('an uninstalled call still rides the global fetch where the global can stream', async () => {
    // Node/web: undici's Response exposes `body`, so delegation stays correct.
    const globalFetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    try {
      const res = await streamingFetch('http://x.test');
      expect(await res.text()).toBe('ok');
      expect(globalFetch).toHaveBeenCalledTimes(1);
    } finally {
      globalFetch.mockRestore();
    }
  });

  test('resetting returns to the pristine delegate-to-global state', async () => {
    installStreamingFetch((async () => new Response('installed')) as unknown as typeof globalThis.fetch);
    expect(await (await streamingFetch('http://x.test')).text()).toBe('installed');

    resetStreamingFetchForTests();
    const globalFetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('global'));
    try {
      expect(await (await streamingFetch('http://x.test')).text()).toBe('global');
      expect(globalFetch).toHaveBeenCalledTimes(1);
    } finally {
      globalFetch.mockRestore();
    }
  });

  test('streamChat refuses to run uninstalled on a device-class fetch instead of bubbling silence', async () => {
    const restoreGlobals = useDeviceClassGlobals();
    try {
      const client = new ManifestClient(PROFILE, IDENTITY, {});
      await expect(
        client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
          model: 'test/model',
        }),
      ).rejects.toThrow(/installStreamingFetch/);
    } finally {
      restoreGlobals();
    }
  });
});
