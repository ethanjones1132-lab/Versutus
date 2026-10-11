import { categorizeProbeError, probeGatewayUrl } from '@/lib/gateway/probe';

function statusResponse(status: number) {
  return { ok: status >= 200 && status < 300, status } as unknown as Response;
}

describe('a gateway that answered with an HTTP error', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('a 503 is reported as an answer from the gateway, not as a network failure', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() => Promise.resolve(statusResponse(503)));

    const result = await probeGatewayUrl('http://gate:8642', 2000);

    expect(result).toMatchObject({ ok: false, code: 'http-error', status: 503, error: 'Gateway returned HTTP 503' });
    const message = categorizeProbeError(result);
    expect(message).toBe(
      'The gateway answered with HTTP 503. It may still be starting, or the address points at something else.',
    );
    expect(message).not.toMatch(/network|Tailscale/i);
  });

  test('a 500 is named as the gateway answer too', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() => Promise.resolve(statusResponse(500)));

    const message = categorizeProbeError(await probeGatewayUrl('http://gate:8642', 2000));

    expect(message).toContain('HTTP 500');
    expect(message).not.toMatch(/network|Tailscale/i);
  });

  test('a 401 or 403 says the gateway refused this device, and points at the token', async () => {
    for (const status of [401, 403]) {
      (globalThis as { fetch: unknown }).fetch = jest.fn(() => Promise.resolve(statusResponse(status)));

      const message = categorizeProbeError(await probeGatewayUrl('http://gate:8642', 2000));

      expect(message).toBe(`The gateway refused this device (HTTP ${status}). Check the token.`);
    }
  });
});

describe('categorizeProbeError keeps the network wording for real connect failures', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('a request that never reached the host is still a network failure', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(() =>
      Promise.reject(new Error('Network request failed')),
    );

    const result = await probeGatewayUrl('http://gate:8642', 2000);

    expect(result).toMatchObject({ ok: false, code: 'connect-failed' });
    expect(categorizeProbeError(result)).toBe('Could not reach the gateway host. Check network/Tailscale.');
  });

  test('a timed-out probe still reads as a slow gateway', () => {
    expect(
      categorizeProbeError({
        ok: false,
        url: 'http://gate:8642',
        error: 'Timed out waiting for gateway',
        code: 'timeout',
      }),
    ).toBe('Gateway not responding in time. It may be starting up or blocked.');
  });

  test('no result, or a success, has no category', () => {
    expect(categorizeProbeError(null)).toBe('');
    expect(categorizeProbeError({ ok: true, url: 'http://gate:8642', latencyMs: 5 })).toBe('');
  });
});
