import { ManifestClient } from '@/lib/gateway/manifest-client';
import { createEnvironmentClient } from '@/lib/gateway/environment-client';
import { installStreamingFetch, streamingFetch } from '@/lib/net/streaming-fetch';
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
  // Reset the module-level installation so tests cannot leak into each other.
  installStreamingFetch(globalThis.fetch);
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
