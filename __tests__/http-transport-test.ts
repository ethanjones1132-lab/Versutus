import { HttpTransport } from '@/lib/gateway/http-transport';
import { GatewayHttpError } from '@/lib/gateway/errors';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

describe('HttpTransport', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('strips non-printable characters from header values', async () => {
    const calls: RequestInit[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((_url: unknown, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const transport = new HttpTransport({
      baseUrl: 'http://gateway.test:8642',
      token: '  abc-123\n',
    });
    await transport.request('GET', '/health');

    const headers = calls[0].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer abc-123');
  });

  test('records contact even when the gateway rejects the request', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ error: { message: 'Invalid API key' } }, 401)),
    );

    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });
    await expect(transport.request('GET', '/v1/models')).rejects.toBeInstanceOf(GatewayHttpError);

    // A 401 proves the gateway is alive, which is what liveness depends on.
    expect(transport.lastContactAt).toBeGreaterThan(0);
  });

  test('surfaces the HTTP status on the error', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(jsonResponse({ error: { message: 'nope' } }, 404)),
    );

    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });
    await expect(transport.request('GET', '/nothing')).rejects.toMatchObject({ status: 404 });
  });

  test('reports the host for operator-facing messages', () => {
    const transport = new HttpTransport({ baseUrl: 'https://ethanspc.tail3a1a8a.ts.net' });
    expect(transport.displayHost).toBe('ethanspc.tail3a1a8a.ts.net');
  });
});
