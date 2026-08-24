import { HttpTransport } from '@/lib/gateway/http-transport';
import { GatewayHttpError } from '@/lib/gateway/errors';
import { messageFromHttpErrorBody } from '@/lib/gateway/http-error-body';

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

  test('frames arriving on an SSE stream count as contact', async () => {
    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });
    expect(transport.lastContactAt).toBe(0);

    const frames = [
      new TextEncoder().encode('data: {"delta":"he"}\n\n'),
      new TextEncoder().encode('data: [DONE]\n\n'),
    ];
    const response = {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            Promise.resolve(
              frames.length ? { done: false, value: frames.shift() } : { done: true },
            ),
          cancel: () => undefined,
        }),
      },
    } as unknown as Response;

    await transport.streamSSE(response, () => undefined);

    // A frame landing is the gateway answering us — direct liveness evidence
    // for the connection monitor during long chat / run-event streams.
    expect(transport.lastContactAt).toBeGreaterThan(0);
  });

  test('a stream that opens but never delivers bytes is not contact', async () => {
    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });

    const response = {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => Promise.resolve({ done: true }),
          cancel: () => undefined,
        }),
      },
    } as unknown as Response;

    await transport.streamSSE(response, () => undefined);

    // Opening a body proves nothing; only delivered bytes do.
    expect(transport.lastContactAt).toBe(0);
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

  test('prefers JSON message when error is the generic HTTP phrase', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(
        jsonResponse(
          { error: 'Internal Server Error', message: 'hermes: boom' },
          500,
        ),
      ),
    );

    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });
    await expect(transport.request('GET', '/v1/sessions')).rejects.toMatchObject({
      message: 'hermes: boom',
      status: 500,
    });
  });
});

describe('messageFromHttpErrorBody', () => {
  test('prefers JSON message when error is the generic HTTP phrase', () => {
    expect(
      messageFromHttpErrorBody(
        JSON.stringify({
          error: 'Internal Server Error',
          message: 'hermes: An internal server error has occurred',
        }),
        500,
      ),
    ).toBe('hermes: An internal server error has occurred');
  });

  test('still reads nested error.message', () => {
    expect(
      messageFromHttpErrorBody(JSON.stringify({ error: { message: 'Invalid API key' } }), 401),
    ).toBe('Invalid API key');
  });

  test('falls back to a string error when message is absent', () => {
    expect(messageFromHttpErrorBody(JSON.stringify({ error: 'nope' }), 404)).toBe('nope');
  });

  test('non-JSON bodies stay as text', () => {
    expect(messageFromHttpErrorBody('An internal server error has occurred', 500)).toBe(
      'An internal server error has occurred',
    );
  });
});
