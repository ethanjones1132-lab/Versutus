import { HermesGatewayClient } from '@/lib/gateway/client';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import { installStreamingFetch, resetStreamingFetchForTests } from '@/lib/net/streaming-fetch';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

// CONN-4. `disconnect()` advertised one teardown — "abort whatever is in
// flight" — and it iterated a map nothing ever wrote to, so a client the
// provider threw away mid-turn kept streaming: the phone went on reading frames
// for a thread it had left and the socket stayed open on the Gate for the rest
// of the turn. The turn's real signal belongs to the provider, which is why
// aborting the client's own controller could never have reached it.

const profile: GatewayProfile = {
  id: 'g1', name: 'Gate', url: 'http://gate.test:8760', kind: 'custom', token: 'k', createdAt: 0,
};
const identity: GatewayIdentity = {
  kind: 'custom',
  kindLabel: 'Gate',
  auth: { schemes: ['bearer'], requiresToken: true },
  manifest: { endpoints: { chat: '/v1/chat/completions' } },
} as unknown as GatewayIdentity;

/**
 * A stream that never ends, which is what a long turn looks like: the response
 * arrives and the body simply stays open.
 */
function hangingStream(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"half"}}]}\n\n'));
      signal?.addEventListener('abort', () => {
        try {
          controller.error(new Error('The operation was aborted.'));
        } catch {
          // already closed
        }
      }, { once: true });
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

/** Start a turn and hand back the signal its request actually ran under. */
function startTurn(
  client: HermesGatewayClient | ManifestClient,
  callerSignal: AbortSignal,
): Promise<string> {
  return client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
    model: 'm',
    signal: callerSignal,
  });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

afterEach(() => resetStreamingFetchForTests());

const clients: [string, () => HermesGatewayClient | ManifestClient][] = [
  ['Hermes', () => new HermesGatewayClient({ ...profile, kind: 'hermes' }, {})],
  ['manifest', () => new ManifestClient(profile, identity, {})],
];

test.each(clients)('%s disconnect stops a turn that is still streaming', async (_name, makeClient) => {
  let sent: AbortSignal | null | undefined;
  installStreamingFetch((async (_input: unknown, init: { signal?: AbortSignal }) => {
    sent = init?.signal;
    return hangingStream(sent);
  }) as unknown as typeof globalThis.fetch);

  const client = makeClient();
  // The provider always hands its own signal to a turn, so the signal under test
  // is the one a caller owns — the shape that could never be aborted before.
  const caller = new AbortController();
  const turn = startTurn(client, caller.signal);
  await flush();
  expect(sent).toBeDefined();
  expect(sent?.aborted).toBe(false);

  client.disconnect();

  expect(sent?.aborted).toBe(true);
  await expect(turn).rejects.toThrow(/stopped|abort/i);
});

test.each(clients)('%s a turn with no caller signal is aborted by disconnect too', async (_name, makeClient) => {
  let sent: AbortSignal | null | undefined;
  installStreamingFetch((async (_input: unknown, init: { signal?: AbortSignal }) => {
    sent = init?.signal;
    return hangingStream(sent);
  }) as unknown as typeof globalThis.fetch);

  const client = makeClient();
  const turn = client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, { model: 'm' });
  await flush();

  client.disconnect();

  expect(sent?.aborted).toBe(true);
  await expect(turn).rejects.toThrow(/stopped|abort/i);
});

test.each(clients)('%s a caller abort still reaches the request', async (_name, makeClient) => {
  let sent: AbortSignal | null | undefined;
  installStreamingFetch((async (_input: unknown, init: { signal?: AbortSignal }) => {
    sent = init?.signal;
    return hangingStream(sent);
  }) as unknown as typeof globalThis.fetch);

  const client = makeClient();
  const caller = new AbortController();
  const turn = startTurn(client, caller.signal);
  await flush();

  caller.abort();

  expect(sent?.aborted).toBe(true);
  await expect(turn).rejects.toThrow(/stopped|abort/i);
});

test.each(clients)('%s a finished turn leaves nothing in flight', async (_name, makeClient) => {
  const calls: string[] = [];
  installStreamingFetch((async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    }),
  })) as unknown as typeof globalThis.fetch);

  const client = makeClient();
  await client.streamChat([{ role: 'user', content: 'hi' }], (delta) => calls.push(delta), { model: 'm' });
  expect(calls).toEqual([]);

  // A registry that only ever grows would abort controllers of turns that ended
  // long ago; nothing may be left to abort here.
  expect(() => client.disconnect()).not.toThrow();
});
