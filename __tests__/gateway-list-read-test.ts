import { HermesGatewayClient } from '@/lib/gateway/client';
import type { GatewayProfile } from '@/lib/gateway/types';

const PROFILE: GatewayProfile = {
  id: 'g1', name: 'Test gateway', url: 'http://gateway.test:8760',
  kind: 'hermes', token: 'k', createdAt: 0,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

const UNAUTHORIZED = { error: { message: 'Invalid API key', code: 'invalid_api_key' } };

describe('getSkills and getToolsets keep a failed read distinguishable', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('a real empty catalogue is a successful read with no items', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ object: 'list', data: [] })),
    );
    const client = new HermesGatewayClient(PROFILE);

    await expect(client.getSkills()).resolves.toEqual({ ok: true, items: [] });
    await expect(client.getToolsets()).resolves.toEqual({ ok: true, items: [] });
  });

  test('a refused read is not an empty catalogue', async () => {
    // The old code answered every 401 with [] — "this host has no skills",
    // a fact about the host invented out of a fact about the key.
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(jsonResponse(UNAUTHORIZED, 401)),
    );
    const client = new HermesGatewayClient(PROFILE);

    const skills = await client.getSkills();
    const toolsets = await client.getToolsets();
    expect(skills).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringMatching(/API key/i) }),
    );
    expect(toolsets).toEqual(
      expect.objectContaining({ ok: false, error: expect.stringMatching(/API key/i) }),
    );
  });

  test('an unreachable host is not an empty catalogue', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.reject(new TypeError('Network request failed')),
    );
    const client = new HermesGatewayClient(PROFILE);

    await expect(client.getSkills()).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    await expect(client.getToolsets()).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  test('a body with no list in it is a failed read, not an empty one', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ unexpected: 'envelope' })),
    );
    const client = new HermesGatewayClient(PROFILE);

    await expect(client.getSkills()).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    await expect(client.getToolsets()).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
  });
});
