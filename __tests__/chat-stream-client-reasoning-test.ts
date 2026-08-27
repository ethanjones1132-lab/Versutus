import { HermesGatewayClient } from '@/lib/gateway/client';
import { installStreamingFetch, resetStreamingFetchForTests } from '@/lib/net/streaming-fetch';
import type { GatewayProfile } from '@/lib/gateway/types';

const PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Test gateway',
  url: 'http://gateway.test:8642',
  kind: 'hermes',
  token: 'k',
  createdAt: 0,
};

function sseResponse(chunks: string[]) {
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const json of chunks) controller.enqueue(enc.encode(`data: ${json}\n\n`));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

afterEach(() => resetStreamingFetchForTests());

test('streamChat forwards reasoning_content via onReasoning and not via onDelta', async () => {
  const reasoningChunks: string[] = [];
  const textChunks: string[] = [];
  installStreamingFetch((async () =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'let me think' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: ' more' } }] }),
    ])) as unknown as typeof globalThis.fetch);

  const client = new HermesGatewayClient(PROFILE, {});
  const full = await client.streamChat(
    [{ role: 'user', content: 'hi' }],
    (t) => textChunks.push(t),
    { model: 'm', onReasoning: (r) => reasoningChunks.push(r) },
  );

  expect(reasoningChunks).toEqual(['let me think', ' more']);
  expect(textChunks).toEqual(['hello']);
  // fullText must stay text-only
  expect(full).toBe('hello');
  expect(full).not.toContain('let me think');
});

test('streamChat forwards reasoning and thinking aliases', async () => {
  const reasoningChunks: string[] = [];
  installStreamingFetch((async () =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { reasoning: 'r1' } }] }),
      JSON.stringify({ choices: [{ delta: { thinking: 't1' } }] }),
    ])) as unknown as typeof globalThis.fetch);

  const client = new HermesGatewayClient(PROFILE, {});
  await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
    model: 'm',
    onReasoning: (r) => reasoningChunks.push(r),
  });

  expect(reasoningChunks).toEqual(['r1', 't1']);
});

test('streamChat without onReasoning does not throw when reasoning arrives', async () => {
  installStreamingFetch((async () =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'silent' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
    ])) as unknown as typeof globalThis.fetch);

  const client = new HermesGatewayClient(PROFILE, {});
  const textChunks: string[] = [];
  const full = await client.streamChat([{ role: 'user', content: 'hi' }], (t) => textChunks.push(t), {
    model: 'm',
  });

  expect(textChunks).toEqual(['ok']);
  expect(full).toBe('ok');
});

test('streamChat keeps fullText separate from reasoning across mixed chunks', async () => {
  const reasoningChunks: string[] = [];
  installStreamingFetch((async () =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'A', reasoning_content: 'R1' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'B' } }] }),
    ])) as unknown as typeof globalThis.fetch);

  const client = new HermesGatewayClient(PROFILE, {});
  const full = await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
    model: 'm',
    onReasoning: (r) => reasoningChunks.push(r),
  });

  expect(reasoningChunks).toEqual(['R1']);
  expect(full).toBe('AB');
});
