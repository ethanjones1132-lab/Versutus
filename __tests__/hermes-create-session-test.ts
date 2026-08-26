import { HermesGatewayClient } from '@/lib/gateway/client';
import type { GatewayProfile } from '@/lib/gateway/types';

const PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Test gateway',
  url: 'http://gateway.test:8642',
  kind: 'hermes',
  token: 'k',
  createdAt: 0,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('HermesGatewayClient createSession', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('a session opened with a model posts that model as a string', async () => {
    // Native Hermes POST /api/sessions takes `model` as a string. The Gate
    // remaps `{ modelId }` onto that field; this client talks to Hermes
    // directly, so the string has to go on the wire or the session is born
    // on the host default for good.
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({ session: { id: 'api_new', title: 'scratch', model: 'opencode-zen/laguna-s-2.1-free' } }),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = new HermesGatewayClient(PROFILE, {});
    const created = await client.createSession('scratch', 'opencode-zen/laguna-s-2.1-free');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/sessions');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.title).toBe('scratch');
    expect(body.model).toBe('opencode-zen/laguna-s-2.1-free');
    expect(created.id).toBe('api_new');
    expect(client.sessionId).toBe('api_new');
    client.disconnect();
  });

  test('a session opened without a model still sends a title so the body is not empty', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({ session: { id: 'api_bare', title: '' } }),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = new HermesGatewayClient(PROFILE, {});
    await client.createSession();

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ title: '' });
    expect(body).not.toHaveProperty('model');
    client.disconnect();
  });
});
