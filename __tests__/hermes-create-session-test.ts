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
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'not found', code: 'not_found' } }, 404))
      .mockResolvedValueOnce(
        jsonResponse({ session: { id: 'api_new', title: 'scratch', model: 'opencode-zen/laguna-s-2.1-free' } }),
      );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = new HermesGatewayClient(PROFILE, {});
    const created = await client.createSession('scratch', 'opencode-zen/laguna-s-2.1-free');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/sessions');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/api/sessions');
    expect(fetchMock.mock.calls[1][1].method).toBe('POST');
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
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

  test('a Gate answers the create first with a direct session envelope', async () => {
    // The Gate serves only /v1/* and returns the session directly, while
    // Hermes-native POST /api/sessions wraps it as { session }.
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({ id: 'v1_new', title: 'scratch', model: 'opencode-zen/laguna-s-2.1-free' }),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = new HermesGatewayClient(PROFILE, {});
    const created = await client.createSession('scratch', 'opencode-zen/laguna-s-2.1-free');

    expect(String(fetchMock.mock.calls[0][0])).toContain('/v1/sessions');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.title).toBe('scratch');
    expect(body.model).toEqual({ modelId: 'opencode-zen/laguna-s-2.1-free' });
    expect(created.id).toBe('v1_new');
    expect(client.sessionId).toBe('v1_new');
    client.disconnect();
  });

  test('a Gate refusal surfaces instead of retrying another dialect', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({ error: { message: 'Title already in use', code: 'session_create_failed' } }, 502),
    );
    (globalThis as { fetch: unknown }).fetch = fetchMock;

    const client = new HermesGatewayClient(PROFILE, {});
    await expect(client.createSession('scratch')).rejects.toThrow('Title already in use');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.sessionId).toBeUndefined();
    client.disconnect();
  });
});
