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

test('streamChat fires onModelReport once for a model substitution frame', async () => {
  const reports: Array<{ requested?: string; ran?: string; provider?: string }> = [];
  installStreamingFetch((async () =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'hello' } }] }),
      JSON.stringify({ model: 'deepseek-v4-flash', requested_model: 'longcat-2.0', provider: 'opencode-go', choices: [] }),
    ])) as unknown as typeof globalThis.fetch);

  const client = new HermesGatewayClient(PROFILE, {});
  const full = await client.streamChat(
    [{ role: 'user', content: 'hi' }],
    () => undefined,
    { model: 'longcat-2.0', onModelReport: (r) => reports.push(r) },
  );

  expect(reports).toEqual([{ requested: 'longcat-2.0', ran: 'deepseek-v4-flash', provider: 'opencode-go' }]);
  expect(full).toBe('hello');
});

test('streamChat does not fire onModelReport a second time for a duplicate frame', async () => {
  const reports: Array<{ requested?: string; ran?: string; provider?: string }> = [];
  installStreamingFetch((async () =>
    sseResponse([
      JSON.stringify({ model: 'deepseek-v4-flash', requested_model: 'longcat-2.0', provider: 'opencode-go', choices: [] }),
      JSON.stringify({ model: 'deepseek-v4-flash', requested_model: 'longcat-2.0', provider: 'opencode-go', choices: [] }),
      JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
    ])) as unknown as typeof globalThis.fetch);

  const client = new HermesGatewayClient(PROFILE, {});
  await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
    model: 'longcat-2.0',
    onModelReport: (r) => reports.push(r),
  });

  expect(reports).toHaveLength(1);
});

test('streamChat fires again when the reported pair changes', async () => {
  const reports: Array<{ requested?: string; ran?: string; provider?: string }> = [];
  installStreamingFetch((async () =>
    sseResponse([
      JSON.stringify({ model: 'model-a', requested_model: 'longcat-2.0', provider: 'p1', choices: [] }),
      JSON.stringify({ model: 'model-b', requested_model: 'longcat-2.0', provider: 'p1', choices: [] }),
    ])) as unknown as typeof globalThis.fetch);

  const client = new HermesGatewayClient(PROFILE, {});
  await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
    model: 'longcat-2.0',
    onModelReport: (r) => reports.push(r),
  });

  expect(reports).toEqual([
    { requested: 'longcat-2.0', ran: 'model-a', provider: 'p1' },
    { requested: 'longcat-2.0', ran: 'model-b', provider: 'p1' },
  ]);
});

test('streamChat without onModelReport does not throw when model frame arrives', async () => {
  installStreamingFetch((async () =>
    sseResponse([
      JSON.stringify({ model: 'deepseek-v4-flash', requested_model: 'longcat-2.0', choices: [] }),
      JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
    ])) as unknown as typeof globalThis.fetch);

  const client = new HermesGatewayClient(PROFILE, {});
  const full = await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, { model: 'm' });
  expect(full).toBe('ok');
});

test('ordinary text chunks do not trigger onModelReport', async () => {
  const reports: unknown[] = [];
  installStreamingFetch((async () =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { content: 'just text' } }] }),
      JSON.stringify({ choices: [{ delta: { content: ' more' } }] }),
    ])) as unknown as typeof globalThis.fetch);

  const client = new HermesGatewayClient(PROFILE, {});
  await client.streamChat([{ role: 'user', content: 'hi' }], () => undefined, {
    model: 'm',
    onModelReport: (r) => reports.push(r),
  });
  expect(reports).toEqual([]);
});
