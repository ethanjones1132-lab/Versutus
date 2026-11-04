import { ManifestClient } from '@/lib/gateway/manifest-client';
import { GatewayHttpError } from '@/lib/gateway/errors';
import type { PublicBot } from '@/lib/gateway/bots';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

/**
 * A roster is a claim about Bots, and only a list of Bots may make it.
 *
 * The transport now refuses an HTML answer itself (naming the request, the
 * status and what the page said), so the shape guard below only ever sees a
 * body that was not a page — a JSON object where a roster was expected, or
 * plain text. Either way `listBots` must reject rather than answer `[]`: the
 * roster painted "No bots" and the remembered copy was overwritten with that
 * emptiness even though the Gate never said the roster was empty.
 */

const PROFILE: GatewayProfile = {
  id: 'g1',
  name: 'Test gate',
  url: 'http://gate.test:8760',
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
    name: 'Test Gate',
    auth: { schemes: ['bearer'], grantPath: '/.well-known/gateway/access' },
    transport: { primary: 'http' },
    endpoints: { health: '/health', bots: '/v1/bots' },
    capabilities: { chat: true },
  },
  source: 'manifest',
  identifiedAt: 0,
};

function client(endpoints: Record<string, string> = { health: '/health', bots: '/v1/bots' }) {
  const identity: GatewayIdentity = {
    ...IDENTITY,
    manifest: { ...IDENTITY.manifest!, endpoints },
  };
  return new ManifestClient(PROFILE, identity, {});
}

function respondWith(body: string) {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(body),
  });
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}

function jsonResponse(value: unknown) {
  return respondWith(JSON.stringify(value));
}

const ROWS: PublicBot[] = [
  { id: 'default', displayName: 'default', routable: true },
  { id: 'scribe', displayName: 'scribe', routable: false },
];

describe('ManifestClient bot roster shape', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('an HTML 200 is refused instead of read as an empty roster', async () => {
    respondWith('<!doctype html><html><body>Cannot GET /v1/bots</body></html>');
    const error = await client()
      .listBots()
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GatewayHttpError);
    const named = error as GatewayHttpError;
    // The transport refuses the page before any roster-shape reading, so the
    // refusal is its own: it names the request that was answered with markup.
    expect(named.code).toBe('html_answer');
    // The status is the one the gateway actually answered: it said OK.
    expect(named.status).toBe(200);
    // A neutral sentence: no markup and no parser text leaks to the banner.
    expect(named.message).not.toMatch(/[<>]/);
    expect(named.message).not.toMatch(/unexpected token/i);
    expect(named.message).toContain('GET /v1/bots');
  });

  test('a JSON body that is not a roster is refused, not read as zero Bots', async () => {
    jsonResponse({ object: 'list' });
    await expect(client().listBots()).rejects.toMatchObject({ code: 'bot_roster_unreadable' });
  });

  test('a { data } envelope whose data is not a list is refused', async () => {
    jsonResponse({ object: 'list', data: 'no bots here' });
    await expect(client().listBots()).rejects.toMatchObject({ code: 'bot_roster_unreadable' });
  });

  test('a list holding rows that do not name a Bot is refused whole', async () => {
    jsonResponse([{ id: 'default', displayName: 'default', routable: true }, { displayName: 'ghost' }]);
    await expect(client().listBots()).rejects.toMatchObject({ code: 'bot_roster_unreadable' });

    jsonResponse(['<!doctype html>']);
    await expect(client().listBots()).rejects.toMatchObject({ code: 'bot_roster_unreadable' });
  });

  test('a bare array of Bots is returned exactly as answered', async () => {
    jsonResponse(ROWS);
    await expect(client().listBots()).resolves.toEqual(ROWS);
  });

  test('the Gate envelope around the same rows reads the same', async () => {
    jsonResponse({ object: 'list', data: ROWS });
    await expect(client().listBots()).resolves.toEqual(ROWS);
  });

  test('an explicitly empty roster is still a believed answer', async () => {
    jsonResponse([]);
    await expect(client().listBots()).resolves.toEqual([]);
    jsonResponse({ object: 'list', data: [] });
    await expect(client().listBots()).resolves.toEqual([]);
  });

  test('a gate that advertises no bots endpoint still degrades to empty', async () => {
    const fetchMock = jest.fn();
    (globalThis as { fetch: unknown }).fetch = fetchMock;
    await expect(client({ health: '/health' }).listBots()).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
