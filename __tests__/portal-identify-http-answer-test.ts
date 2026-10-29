// ─── An unknown identity records whether HTTP answered at all ───────────────
// probeHttpAlive reported `response.ok`, so a living server that refused
// /health with 401/403/404/500 was recorded exactly like an address where
// nothing listened: no transport hint, and no way for a caller to tell a
// credential question from a dead path. An unknown identity now carries
// `reachability`: 'answered' for any response at all, 'no-answer' only when
// the fetch threw, timed out or aborted.

import { resetHostLookupMemoryForTests } from '@/lib/gateway/host-lookup';
import { identifyGateway } from '@/lib/portal/identify';

/** A response with the given status and a body that is neither manifest nor Hermes. */
function statusResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve('{}'),
    json: () => Promise.resolve({}),
  } as unknown as Response;
}

function connectionRefused(): Error {
  return new TypeError('fetch failed', {
    cause: { code: 'ECONNREFUSED', syscall: 'connect', hostname: '127.0.0.1', port: 9 },
  });
}

const realFetch = globalThis.fetch;
const realWebSocket: unknown = globalThis.WebSocket;
beforeEach(() => {
  resetHostLookupMemoryForTests();
});
afterEach(() => {
  (globalThis as { fetch: unknown }).fetch = realFetch;
  (globalThis as { WebSocket?: unknown }).WebSocket = realWebSocket;
  resetHostLookupMemoryForTests();
});

function withoutWebSocket() {
  (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
}

describe.each([401, 403, 404, 500])(
  'an unknown gateway whose /health answers %i',
  (status) => {
    test('is recorded as answered with an http transport hint, not as a dead path', async () => {
      withoutWebSocket();
      const calls: string[] = [];
      (globalThis as { fetch: unknown }).fetch = jest.fn((input: unknown) => {
        const url = String(input);
        calls.push(url);
        return Promise.resolve(statusResponse(status));
      });

      const identity = await identifyGateway({ baseUrl: 'http://127.0.0.1:9' });

      expect(identity.kind).toBe('unknown');
      expect(identity.source).toBe('unknown');
      // A refusal is an answer: something is listening on that address.
      expect(identity.reachability).toBe('answered');
      expect(identity.transportHint).toBe('http');
      // The reachability read is the /health probe itself, not a by-product.
      expect(calls).toContain('http://127.0.0.1:9/health');
    });
  },
);

describe('an unknown gateway whose /health answers 200 with no fingerprint', () => {
  test('is still recorded as answered — any response counts', async () => {
    withoutWebSocket();
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.resolve(statusResponse(200)),
    );

    const identity = await identifyGateway({ baseUrl: 'http://127.0.0.1:9' });

    expect(identity.kind).toBe('unknown');
    expect(identity.reachability).toBe('answered');
    expect(identity.transportHint).toBe('http');
  });
});

describe('an unknown gateway where nothing answered', () => {
  test('is recorded as no-answer with no transport hint, and never as a token prompt', async () => {
    withoutWebSocket();
    (globalThis as { fetch: unknown }).fetch = jest.fn(() => {
      throw connectionRefused();
    });

    const identity = await identifyGateway({ baseUrl: 'http://127.0.0.1:9' });

    expect(identity.kind).toBe('unknown');
    expect(identity.source).toBe('unknown');
    expect(identity.reachability).toBe('no-answer');
    expect(identity.transportHint).toBeUndefined();
  });

  test('a name that will not resolve is the same no-answer verdict', async () => {
    withoutWebSocket();
    (globalThis as { fetch: unknown }).fetch = jest.fn(() => {
      throw new TypeError('fetch failed', {
        cause: { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'gate.test' },
      });
    });

    const identity = await identifyGateway({ baseUrl: 'http://gate.test' });

    expect(identity.kind).toBe('unknown');
    expect(identity.reachability).toBe('no-answer');
    expect(identity.transportHint).toBeUndefined();
  });
});
