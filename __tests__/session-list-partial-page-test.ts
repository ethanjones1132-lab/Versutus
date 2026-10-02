import { ManifestClient } from '@/lib/gateway/manifest-client';
import {
  readSessionPage,
  sessionListMayHaveOlder,
  SESSION_LIST_MAX,
  SESSION_LIST_PAGE_SIZE,
} from '@/lib/gateway/session-list';
import type { GatewayProfile, HermesSession } from '@/lib/gateway/types';
import type { GatewayIdentity } from '@/lib/portal/identify';

declare const __dirname: string;

// CONN-3. The Gate answers a session-list read it could not finish with the rows
// its own copy holds and `partial: true` — the one signal that says "this is not
// the whole catalogue". The client kept `data` and dropped the flag, and the
// app judged completeness from the row count alone, which is exactly the
// comparison a deliberately short page is built to fail: 20 rows for a 200 ask
// read as "nothing older exists", so "Load older" disappeared when the network
// was worst and the older threads became unreachable.

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
    endpoints: { health: '/health', sessions: '/v1/sessions' },
    capabilities: { chat: true, models: true },
  },
  source: 'manifest',
  identifiedAt: 0,
};

/** The body a Gate answers a truncated read with (readIndexedSessions). */
function partialBody(rows: number) {
  return {
    object: 'list',
    data: Array.from({ length: rows }, (_, index) => ({
      id: `ses_${index + 1}`,
      source: 'api_server',
      title: `Session ${index + 1}`,
    })),
    partial: true,
    index: { refreshedAt: 1, stale: true },
  };
}

describe('a page the gateway marked partial still has older rows', () => {
  test('a short page that says so keeps "Load older" on screen', () => {
    // 20 rows for a 40 ask: the count says the catalogue ended, the gateway says
    // it did not get that far.
    expect(sessionListMayHaveOlder(20, 40, true)).toBe(true);
    expect(sessionListMayHaveOlder(20, 40)).toBe(false);
    expect(sessionListMayHaveOlder(20, 40, false)).toBe(false);
  });

  test('a page the gateway says is whole still ends the catalogue', () => {
    // `partial: false` only means "this page is not short" — a FULL page may
    // still hide older rows behind the limit, which is what the count decides.
    expect(sessionListMayHaveOlder(20, SESSION_LIST_PAGE_SIZE, false)).toBe(true);
    expect(sessionListMayHaveOlder(20, SESSION_LIST_PAGE_SIZE)).toBe(true);
    expect(sessionListMayHaveOlder(40, 40)).toBe(true);
    expect(sessionListMayHaveOlder(19, 20, false)).toBe(false);
  });

  test('at the cap there is nothing wider to ask for, partial or not', () => {
    // `limit=200` is the catalogue ceiling, so a short page at that ask cannot be
    // widened: offering "Load older" there would be offering a dead control.
    expect(sessionListMayHaveOlder(20, SESSION_LIST_MAX, true)).toBe(false);
    expect(sessionListMayHaveOlder(SESSION_LIST_MAX, SESSION_LIST_MAX)).toBe(false);
  });
});

describe('reading a page keeps the gateway\'s verdict', () => {
  test('a client that reports a short page has its verdict carried', async () => {
    const getSessionPage = jest.fn().mockResolvedValue({ sessions: [{ id: 'ses_1' }], partial: true });
    const getSessions = jest.fn().mockResolvedValue([{ id: 'ses_1' }]);

    const page = await readSessionPage({ getSessions, getSessionPage }, 200);

    expect(page.partial).toBe(true);
    expect(getSessionPage).toHaveBeenCalledWith(200);
    expect(getSessions).not.toHaveBeenCalled();
  });

  test('a client that cannot report one is read exactly as before', async () => {
    // A direct Hermes and an older Gate answer rows only. They must keep working
    // on the count, and must not be asked for a method they do not have.
    const getSessions = jest.fn().mockResolvedValue([{ id: 'ses_1' }]);

    const page = await readSessionPage({ getSessions }, 200);

    expect(page).toEqual({ sessions: [{ id: 'ses_1' }] });
    expect(page.partial).toBeUndefined();
    expect(getSessions).toHaveBeenCalledWith(200);
  });
});

describe('ManifestClient carries partial off the wire', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: unknown }).fetch = realFetch;
  });

  test('the flag the Gate set reaches the caller, not just the rows', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(partialBody(20)),
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    const page = await client.getSessionPage(200);

    expect(page.sessions).toHaveLength(20);
    expect(page.partial).toBe(true);
  });

  test('a complete read is not partial', async () => {
    const full = partialBody(200);
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ ...full, partial: undefined }),
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    const page = await client.getSessionPage(200);

    expect(page.sessions).toHaveLength(200);
    expect(page.partial).toBeUndefined();
  });

  test('getSessions still answers rows and nothing else', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify(partialBody(20)),
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    const sessions = await client.getSessions(200);

    expect(sessions).toHaveLength(20);
    // A bare array, as every caller of getSessions expects.
    expect(Array.isArray(sessions)).toBe(true);
  });

  test('a gateway that answers a bare array is still read', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify([{ id: 'ses_1', source: 'api_server' } as HermesSession]),
    });

    const client = new ManifestClient(PROFILE, IDENTITY, {});
    const page = await client.getSessionPage(20);

    expect(page.sessions.map((row) => row.id)).toEqual(['ses_1']);
    expect(page.partial).toBeUndefined();
  });
});

describe('the thread sheet judges the window on the gateway\'s word', () => {
  const nodeFs = jest.requireActual('fs') as {
    readFileSync(path: string, encoding: string): string;
  };
  const SEP = __dirname.includes('\\') ? '\\' : '/';

  test('both session-list reads pass the verdict through to may-have-older', () => {
    const src = nodeFs
      .readFileSync([__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP), 'utf8')
      .replace(/\r\n/g, '\n');
    // Two call sites: the sheet's first page and "Load older".
    const calls = src.match(/sessionListMayHaveOlder\([^)]*partial/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(src).toContain('readSessionPage(client, SESSION_LIST_PAGE_SIZE)');
    expect(src).toContain('readSessionPage(client, nextLimit)');
  });
});
