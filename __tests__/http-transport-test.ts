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

/** Fail loudly instead of hanging when streamSSE never settles. */
function settlesWithin<T>(promise: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`streamSSE did not settle within ${ms}ms`)), ms),
    ),
  ]);
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

  test('preserves the Gate’s machine-readable error code', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(
        jsonResponse({ error: { message: 'The PC voice models are not installed.', code: 'no_engine' } }, 409),
      ),
    );

    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });
    await expect(transport.request('POST', '/v1/capabilities/rpc')).rejects.toMatchObject({
      name: 'GatewayHttpError',
      status: 409,
      code: 'no_engine',
      message: 'The PC voice models are not installed.',
    });
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

    await expect(transport.streamSSE(response, () => undefined)).resolves.toBe(true);

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

    await expect(transport.streamSSE(response, () => undefined)).resolves.toBe(false);

    // Opening a body proves nothing; only delivered bytes do.
    expect(transport.lastContactAt).toBe(0);
  });

  test('recognizes a terminal marker split across chunks without a final newline', async () => {
    const frames = [
      new TextEncoder().encode('data: {"delta":"hi"}\r\n\r\ndata: [DO'),
      new TextEncoder().encode('NE]'),
    ];
    const response = {
      body: {
        getReader: () => ({
          read: () => Promise.resolve(frames.length
            ? { done: false, value: frames.shift() }
            : { done: true }),
          cancel: () => undefined,
        }),
      },
    } as unknown as Response;
    const chunks: string[] = [];
    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });

    await expect(transport.streamSSE(response, (chunk) => chunks.push(chunk))).resolves.toBe(true);
    expect(chunks).toEqual(['{"delta":"hi"}']);
  });

  test('an abort settles even when the reader ignores read and cancel', async () => {
    const controller = new AbortController();
    const response = {
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}),
          cancel: () => new Promise(() => {}),
        }),
      },
    } as unknown as Response;
    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });

    const pending = transport.streamSSE(response, () => undefined, controller.signal);
    controller.abort();

    await expect(settlesWithin(pending)).resolves.toBe(false);
  });

  test('no onChunk fires after the caller aborts, even mid-batch', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const frames = [new TextEncoder().encode('data: one\n\ndata: two\n\ndata: three\n\n')];
    const response = {
      body: {
        getReader: () => ({
          read: () =>
            frames.length
              ? Promise.resolve({ done: false, value: frames.shift() })
              : new Promise(() => {}),
          cancel: () => {
            cancelled = true;
            return new Promise(() => {});
          },
        }),
      },
    } as unknown as Response;
    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });
    const chunks: string[] = [];

    const pending = transport.streamSSE(
      response,
      (chunk) => {
        chunks.push(chunk);
        controller.abort();
      },
      controller.signal,
    );

    await expect(settlesWithin(pending)).resolves.toBe(false);
    expect(chunks).toEqual(['one']);
    expect(cancelled).toBe(true);
  });

  test('a read landing after abort delivers no callback', async () => {
    const controller = new AbortController();
    let releaseRead: (() => void) | undefined;
    const response = {
      body: {
        getReader: () => ({
          read: () =>
            new Promise((resolve) => {
              releaseRead = () =>
                resolve({ done: false, value: new TextEncoder().encode('data: late\n\n') });
            }),
          cancel: () => Promise.resolve(),
        }),
      },
    } as unknown as Response;
    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });
    const chunks: string[] = [];

    const pending = transport.streamSSE(response, (chunk) => chunks.push(chunk), controller.signal);
    controller.abort();
    await expect(settlesWithin(pending)).resolves.toBe(false);

    releaseRead?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chunks).toEqual([]);
  });

  test('an already-aborted signal returns false without reading', async () => {
    let readCalled = false;
    const response = {
      body: {
        getReader: () => ({
          read: () => {
            readCalled = true;
            return new Promise(() => {});
          },
          cancel: () => Promise.resolve(),
        }),
      },
    } as unknown as Response;
    const controller = new AbortController();
    controller.abort();
    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });

    await expect(
      settlesWithin(transport.streamSSE(response, () => undefined, controller.signal)),
    ).resolves.toBe(false);
    expect(readCalled).toBe(false);
  });

  test('a DONE marker returns true even when cancel never settles', async () => {
    const frames = [
      new TextEncoder().encode('data: {"delta":"hi"}\n\n'),
      new TextEncoder().encode('data: [DONE]\n\n'),
    ];
    const response = {
      body: {
        getReader: () => ({
          read: () =>
            Promise.resolve(
              frames.length ? { done: false, value: frames.shift() } : { done: true },
            ),
          cancel: () => new Promise(() => {}),
        }),
      },
    } as unknown as Response;
    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });
    const chunks: string[] = [];

    await expect(
      settlesWithin(transport.streamSSE(response, (chunk) => chunks.push(chunk))),
    ).resolves.toBe(true);
    expect(chunks).toEqual(['{"delta":"hi"}']);
  });

  test('an EOF returns false even when cancel never settles', async () => {
    const response = {
      body: {
        getReader: () => ({
          read: () => Promise.resolve({ done: true }),
          cancel: () => new Promise(() => {}),
        }),
      },
    } as unknown as Response;
    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });

    await expect(settlesWithin(transport.streamSSE(response, () => undefined))).resolves.toBe(false);
    expect(transport.lastContactAt).toBe(0);
  });

  test('an abort landing in the same tick as a read delivers no callback or contact', async () => {
    const controller = new AbortController();
    const response = {
      body: {
        getReader: () => ({
          read: () => {
            controller.abort();
            return Promise.resolve({ done: false, value: new TextEncoder().encode('data: hi\n\n') });
          },
          cancel: () => Promise.resolve(),
        }),
      },
    } as unknown as Response;
    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8642' });
    const chunks: string[] = [];

    await expect(
      settlesWithin(transport.streamSSE(response, (chunk) => chunks.push(chunk), controller.signal)),
    ).resolves.toBe(false);
    expect(chunks).toEqual([]);
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

  test('a MagicDNS miss retries the advertised IPv4 on http', async () => {
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((url: unknown) => {
      calls.push(String(url));
      if (String(url).includes('ethanspc.tail3a1a8a.ts.net')) {
        return Promise.reject(
          new Error(
            'fetch failed: java.net.UnknownHostException: Unable to resolve host "ethanspc.tail3a1a8a.ts.net"',
          ),
        );
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    const transport = new HttpTransport({
      baseUrl: 'http://ethanspc.tail3a1a8a.ts.net:8760',
      alternateIpv4: ['100.95.137.83'],
    });
    await expect(transport.request('GET', '/v1/runs')).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      'http://ethanspc.tail3a1a8a.ts.net:8760/v1/runs',
      'http://100.95.137.83:8760/v1/runs',
    ]);
  });

  test('does not rewrite an https URL onto an IP', async () => {
    const calls: string[] = [];
    (globalThis as { fetch: unknown }).fetch = jest.fn((url: unknown) => {
      calls.push(String(url));
      return Promise.reject(
        new Error(
          'fetch failed: java.net.UnknownHostException: Unable to resolve host "ethanspc.tail3a1a8a.ts.net"',
        ),
      );
    });

    const transport = new HttpTransport({
      baseUrl: 'https://ethanspc.tail3a1a8a.ts.net:8760',
      alternateIpv4: ['100.95.137.83'],
    });
    await expect(transport.request('GET', '/v1/runs')).rejects.toMatchObject({
      name: 'HostLookupError',
    });
    expect(calls).toEqual(['https://ethanspc.tail3a1a8a.ts.net:8760/v1/runs']);
  });

  test('a lookup failure without an IPv4 fallback is a HostLookupError, not the Java exception', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.reject(
        new Error(
          'fetch failed: java.net.UnknownHostException: Unable to resolve host "ethanspc.tail3a1a8a.ts.net"',
        ),
      ),
    );
    const transport = new HttpTransport({ baseUrl: 'http://ethanspc.tail3a1a8a.ts.net:8760' });
    await expect(transport.request('GET', '/v1/runs')).rejects.toMatchObject({
      name: 'HostLookupError',
      message: expect.stringMatching(/could not look up your PC's address/i),
    });
  });

  test('a refused token is not retried as a DNS miss', async () => {
    const fetchMock = jest.fn(() => Promise.resolve(jsonResponse({ error: { message: 'Invalid API key' } }, 401)));
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    const transport = new HttpTransport({
      baseUrl: 'http://ethanspc.tail3a1a8a.ts.net:8760',
      alternateIpv4: ['100.95.137.83'],
    });
    await expect(transport.request('GET', '/v1/runs')).rejects.toBeInstanceOf(GatewayHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
