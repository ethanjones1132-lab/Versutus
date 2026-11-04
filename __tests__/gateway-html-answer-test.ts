import { GatewayHttpError } from '@/lib/gateway/errors';
import { HttpTransport } from '@/lib/gateway/http-transport';
import { pageSnippet } from '@/lib/gateway/http-error-body';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import type { GatewayProfile } from '@/lib/gateway/types';
import type { GatewayIdentity } from '@/lib/portal/identify';

/**
 * An agent-inventory (or any) request answered with HTML instead of JSON:
 * wrong base URL, an unauthenticated proxy login page, a 404 page or a
 * captive portal. The refusal must name the request, carry the status and a
 * sanitised slice of what came back, and give a next step — never a JSON
 * parser message — and the page must not count as the gateway being alive,
 * or the header keeps reading connected while nothing JSON-capable answers.
 */

// Assembled from pieces so no fixture line reads like a real credential,
// while the assertions below still prove the value cannot reach the caption.
const LEAKED = ['ses', '-', 'portal-', '4f3a', 'c0de', '19be'].join('');

function loginPage(): string {
  return [
    '<!doctype html>',
    '<html><head><title>Sign in</title>',
    `<script>window.__portal = { apiKey: "${LEAKED}" };</script>`,
    '</head><body>',
    '<h1>Sign in to continue</h1>',
    `<p>password: ${LEAKED}</p>`,
    `<input name="password" value="${LEAKED}">`,
    '</body></html>',
  ].join('');
}

function htmlResponse(
  status: number,
  body: string,
  contentType: string | null = 'text/html; charset=utf-8',
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

function answerWith(response: Response | Promise<Response>) {
  (globalThis as { fetch: unknown }).fetch = jest.fn(() => Promise.resolve(response));
}

const PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Portal gate',
  url: 'http://portal.test:8760',
  kind: 'custom',
  token: 'k',
  createdAt: 0,
};

const IDENTITY: GatewayIdentity = {
  kind: 'custom',
  kindLabel: 'Custom — versutus-gate',
  auth: { schemes: ['bearer'], requiresToken: true, grantPath: '/.well-known/gateway/access' },
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Portal Gate',
    auth: { schemes: ['bearer'], grantPath: '/.well-known/gateway/access' },
    transport: { primary: 'http' },
    endpoints: { health: '/health', bots: '/v1/bots' },
    capabilities: { chat: true },
  },
  source: 'manifest',
  identifiedAt: 0,
};

describe('a gateway request answered with a web page', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('a 200 HTML login page is refused with the endpoint, status and a next step', async () => {
    const troubles: string[] = [];
    answerWith(htmlResponse(200, loginPage()));

    const transport = new HttpTransport({
      baseUrl: 'http://gateway.test:8760',
      onNetworkTrouble: (reason) => troubles.push(reason),
    });
    const error = await transport
      .request('GET', '/v1/bots')
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayHttpError);
    const named = error as GatewayHttpError;
    // The status the page answered with, and the request it answered.
    expect(named.status).toBe(200);
    expect(named.code).toBe('html_answer');
    expect(named.message).toContain('GET /v1/bots');
    expect(named.message).toContain('200');
    expect(named.message).toMatch(/web page instead of JSON/i);
    expect(named.message).toMatch(/Check the gateway address/i);
    // The sanitised excerpt is carried on the error, and quotes real text.
    expect(named.bodySnippet).toBeDefined();
    expect(named.bodySnippet).toContain('Sign in');
    // No markup, no parser text, and none of the planted credential — from
    // the script, the input attribute, or the visible password line.
    expect(named.message).not.toMatch(/[<>]/);
    expect(named.message).not.toMatch(/unexpected token/i);
    expect(named.message).not.toContain(LEAKED);
    expect(named.bodySnippet).not.toContain(LEAKED);
    // The network-trouble seam is fed so the monitor re-verifies now…
    expect(troubles).toEqual(['GET /v1/bots answered HTTP 200 with a web page instead of JSON']);
    // …and the page earns no liveness credit that would forgive its probes.
    expect(transport.lastContactAt).toBe(0);
  });

  test('a 502 HTML body names the request instead of only the status', async () => {
    const troubles: string[] = [];
    answerWith(htmlResponse(502, '<html><body><h1>502 Bad Gateway</h1></body></html>'));

    const transport = new HttpTransport({
      baseUrl: 'http://gateway.test:8760',
      onNetworkTrouble: (reason) => troubles.push(reason),
    });
    const error = await transport
      .request('GET', '/v1/bots')
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayHttpError);
    const named = error as GatewayHttpError;
    expect(named.status).toBe(502);
    expect(named.message).toContain('GET /v1/bots');
    expect(named.message).toContain('502');
    expect(named.message).toMatch(/Check the gateway address/i);
    expect(named.message).not.toMatch(/[<>]/);
    expect(named.message).not.toMatch(/unexpected token/i);
    expect(troubles).toEqual(['GET /v1/bots answered HTTP 502 with a web page instead of JSON']);
    expect(transport.lastContactAt).toBe(0);
  });

  test('markup at the top of the body is refused even when no content type is set', async () => {
    answerWith({
      ok: true,
      status: 200,
      text: () => Promise.resolve('<!doctype html><html><body>Cannot GET /v1/bots</body></html>'),
    } as unknown as Response);

    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8760' });
    await expect(transport.request('GET', '/v1/bots')).rejects.toMatchObject({
      name: 'GatewayHttpError',
      status: 200,
      code: 'html_answer',
    });
  });

  test('a page with no readable text omits the quote rather than printing nothing', async () => {
    answerWith(
      htmlResponse(200, '<html><head><style>body{background:#000}</style></head><body></body></html>'),
    );

    const transport = new HttpTransport({ baseUrl: 'http://gateway.test:8760' });
    const error = await transport
      .request('GET', '/health')
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayHttpError);
    const named = error as GatewayHttpError;
    expect(named.message).toContain('GET /health');
    expect(named.message).not.toContain('The page said');
    expect(named.bodySnippet).toBeUndefined();
    expect(named.message).not.toMatch(/[<>]/);
  });

  test('a gateway answered by a web page never reads as connected', async () => {
    answerWith(htmlResponse(200, loginPage()));
    const said: string[] = [];
    const client = new ManifestClient(PROFILE, IDENTITY, {
      onError: (message) => said.push(message),
    });
    try {
      await client.connect();
      // The health answer was a page, so the connect never earns `connected`
      // and the operator's error names the request and the next step.
      expect(client.connectionStatus).not.toBe('connected');
      expect(said.join(' ')).toContain('GET /health');
      expect(said.join(' ')).toMatch(/Check the gateway address/i);
      expect(said.join(' ')).not.toMatch(/unexpected token/i);
    } finally {
      client.disconnect();
    }
  });
});

describe('the transport contract either side of an HTML answer', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('a real JSON answer still parses and still counts as contact', async () => {
    const troubles: string[] = [];
    answerWith(
      htmlResponse(200, '{"ok":true}', 'application/json; charset=utf-8'),
    );

    const transport = new HttpTransport({
      baseUrl: 'http://gateway.test:8760',
      onNetworkTrouble: (reason) => troubles.push(reason),
    });
    await expect(transport.request('GET', '/health')).resolves.toEqual({ ok: true });
    expect(transport.lastContactAt).toBeGreaterThan(0);
    expect(troubles).toEqual([]);
  });

  test('a refused JSON answer keeps its contact credit and feeds no trouble seam', async () => {
    const troubles: string[] = [];
    answerWith(
      htmlResponse(
        401,
        JSON.stringify({ error: { message: 'Invalid API key' } }),
        'application/json',
      ),
    );

    const transport = new HttpTransport({
      baseUrl: 'http://gateway.test:8760',
      onNetworkTrouble: (reason) => troubles.push(reason),
    });
    await expect(transport.request('GET', '/v1/bots')).rejects.toMatchObject({
      name: 'GatewayHttpError',
      status: 401,
      message: 'Invalid API key',
    });
    // A real gateway refusal is still liveness evidence — only pages are not.
    expect(transport.lastContactAt).toBeGreaterThan(0);
    expect(troubles).toEqual([]);
  });

  test('the quoted page is bounded and redacted, never a dump', () => {
    const snippet = pageSnippet(
      `<html><body>${'filler '.repeat(400)}<p>password: ${LEAKED}</p></body></html>`,
    );

    expect(snippet.length).toBeLessThanOrEqual(121);
    expect(snippet).not.toContain(LEAKED);
    expect(snippet).not.toMatch(/[<>]/);
  });
});
