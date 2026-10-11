import { GatewayHttpError, isAuthRejection } from '@/lib/gateway/errors';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import { installStreamingFetch, resetStreamingFetchForTests } from '@/lib/net/streaming-fetch';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

/**
 * A failed turn used to reach the screen as wire text. Reported 2026-08-26 with
 * a screenshot: the assistant bubble read
 *
 *   Error: {"error":{"message":"hermes: 500 Internal Server Error\n\nServer got
 *   itself in trouble","code":"backend_error"}}
 *
 * — a transport failure rendered as though the model had said it, JSON envelope
 * and all. The run-events path already unwrapped these bodies; the chat path
 * threw `response.text()` verbatim.
 */

const PROFILE: GatewayProfile = {
  id: 'g1', name: 'Gate', url: 'http://gate.test:8760', kind: 'custom', token: 'k', createdAt: 0,
};

const IDENTITY: GatewayIdentity = {
  kind: 'custom',
  kindLabel: 'Custom — versutus-gate',
  auth: { schemes: ['bearer'], requiresToken: true, grantPath: '/.well-known/gateway/access' },
  manifest: {
    endpoints: { chat: '/v1/chat/completions' },
  },
} as unknown as GatewayIdentity;

function errorResponse(body: string, status = 500) {
  return {
    ok: false,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

afterEach(() => {
  resetStreamingFetchForTests();
});

test('a failed turn surfaces the cause, not the JSON envelope', async () => {
  const body = JSON.stringify({
    error: { message: 'hermes: 500 Internal Server Error\n\nServer got itself in trouble', code: 'backend_error' },
  });
  installStreamingFetch((async () => errorResponse(body)) as unknown as typeof globalThis.fetch);

  const client = new ManifestClient(PROFILE, IDENTITY, {});
  // NB: asserting only on the phrase would pass on the raw envelope too, since
  // the envelope contains it. The shape assertions below are the real check.
  const thrown = await client
    .streamChat([{ role: 'user', content: 'Test' }], () => undefined, { model: 'm' })
    .catch((e: unknown) => (e as Error).message);
  expect(thrown).not.toMatch(/\{"error"/);
  expect(thrown).not.toMatch(/backend_error/);
  // …and the human cause survives the unwrapping.
  expect(thrown).toMatch(/Server got itself in trouble/);
});

test('a body that is not JSON is still shown rather than swallowed', async () => {
  installStreamingFetch((async () => errorResponse('upstream exploded', 502)) as unknown as typeof globalThis.fetch);
  const client = new ManifestClient(PROFILE, IDENTITY, {});
  await expect(
    client.streamChat([{ role: 'user', content: 'Test' }], () => undefined, { model: 'm' }),
  ).rejects.toThrow(/upstream exploded/);
});

test('an empty body falls back to the status rather than an empty error', async () => {
  installStreamingFetch((async () => errorResponse('', 503)) as unknown as typeof globalThis.fetch);
  const client = new ManifestClient(PROFILE, IDENTITY, {});
  await expect(
    client.streamChat([{ role: 'user', content: 'Test' }], () => undefined, { model: 'm' }),
  ).rejects.toThrow(/503/);
});

test('a refused chat keeps its HTTP status, so an auth refusal is recognized by status', async () => {
  // The body's text carries no auth words, so only the status can say this was a
  // credential refusal. The unwrapped message still reaches the screen.
  const body = JSON.stringify({ error: { message: 'nope' } });
  installStreamingFetch((async () => errorResponse(body, 401)) as unknown as typeof globalThis.fetch);

  const client = new ManifestClient(PROFILE, IDENTITY, {});
  const thrown = await client
    .streamChat([{ role: 'user', content: 'Test' }], () => undefined, { model: 'm' })
    .catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(GatewayHttpError);
  expect((thrown as GatewayHttpError).status).toBe(401);
  expect(isAuthRejection(thrown)).toBe(true);
  expect((thrown as Error).message).toBe('nope');
});

test('a refusal carries the Gate error code forward alongside the status', async () => {
  const body = JSON.stringify({ error: { message: 'key not accepted', code: 'invalid_api_key' } });
  installStreamingFetch((async () => errorResponse(body, 403)) as unknown as typeof globalThis.fetch);

  const client = new ManifestClient(PROFILE, IDENTITY, {});
  const thrown = await client
    .streamChat([{ role: 'user', content: 'Test' }], () => undefined, { model: 'm' })
    .catch((e: unknown) => e);
  expect(thrown).toBeInstanceOf(GatewayHttpError);
  expect((thrown as GatewayHttpError).code).toBe('invalid_api_key');
  expect(isAuthRejection(thrown)).toBe(true);
});
