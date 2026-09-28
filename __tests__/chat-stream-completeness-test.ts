import { HermesGatewayClient } from '@/lib/gateway/client';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import { installStreamingFetch, resetStreamingFetchForTests } from '@/lib/net/streaming-fetch';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

const profile: GatewayProfile = {
  id: 'g1', name: 'Gate', url: 'http://gate.test:8760', kind: 'custom', token: 'k', createdAt: 0,
};
const identity: GatewayIdentity = {
  kind: 'custom',
  kindLabel: 'Gate',
  auth: { schemes: ['bearer'], requiresToken: true },
  manifest: { endpoints: { chat: '/v1/chat/completions' } },
} as unknown as GatewayIdentity;

function streamResponse(frames: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

afterEach(() => resetStreamingFetchForTests());

test.each([
  ['Hermes', () => new HermesGatewayClient({ ...profile, kind: 'hermes' }, {})],
  ['manifest', () => new ManifestClient(profile, identity, {})],
])('%s chat retains partial text but rejects a stream without completion', async (_name, makeClient) => {
  installStreamingFetch((async () => streamResponse([
    JSON.stringify({ choices: [{ delta: { content: 'partial answer' } }] }),
  ])) as unknown as typeof globalThis.fetch);
  const deltas: string[] = [];

  await expect(makeClient().streamChat(
    [{ role: 'user', content: 'Hi' }],
    (delta) => deltas.push(delta),
    { model: 'm' },
  )).rejects.toThrow(/stream closed unexpectedly/i);
  expect(deltas).toEqual(['partial answer']);
});

test('a Gate error frame remains the reported cause even without a completion marker', async () => {
  installStreamingFetch((async () => streamResponse([
    JSON.stringify({ error: { message: 'upstream failed', code: 'backend_error' } }),
  ])) as unknown as typeof globalThis.fetch);

  await expect(new ManifestClient(profile, identity, {}).streamChat(
    [{ role: 'user', content: 'Hi' }],
    () => undefined,
    { model: 'm' },
  )).rejects.toThrow('upstream failed');
});
