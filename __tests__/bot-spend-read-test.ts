import { ManifestClient } from '@/lib/gateway/manifest-client';
import {
  botSpendRowCopy,
  readBotSpend,
  SPEND_UNREAD_COPY,
  type BotSpendRosterEntry,
  type BotSpendSource,
} from '@/lib/gateway/spend-report';
import { SESSION_SPEND_LIST_LIMIT, type SessionUsageInput } from '@/lib/gateway/session-analytics';
import type { GatewayIdentity } from '@/lib/portal/identify';
import type { GatewayProfile } from '@/lib/gateway/types';

declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSource(...parts: string[]): string {
  return nodeFs
    .readFileSync([__dirname, '..', ...parts].join(SEP), 'utf8')
    .replace(/\r\n/g, '\n');
}

const PROFILE: GatewayProfile = {
  id: 'gate-1',
  name: 'Gate',
  url: 'http://gate.local:8760',
  token: 'tok',
  createdAt: 0,
};

/** A Gate whose manifest declares the routes a spend read needs. */
const IDENTITY = {
  kind: 'custom',
  kindLabel: 'Versutus Gate',
  source: 'manifest',
  identifiedAt: 0,
  auth: { schemes: ['bearer'], requiresToken: true },
  manifest: {
    manifest: 'versutus-gateway/v1',
    kind: 'versutus-gate',
    name: 'Gate',
    endpoints: {
      health: '/health',
      models: '/v1/models',
      chat: '/v1/chat/completions',
      sessions: '/v1/sessions',
      sessionMessages: '/v1/sessions/{id}/messages',
      backends: '/v1/backends',
    },
    capabilities: { chat: true, models: true, sessions: true, tools: true },
    backends: [
      { id: 'opencode-local', label: 'OpenCode', kind: 'environment', capabilities: ['sessions'] },
    ],
  },
} as unknown as GatewayIdentity;

/** The same Gate with no session route at all — the capability is absent. */
const NO_SESSIONS = {
  ...IDENTITY,
  manifest: { ...IDENTITY.manifest!, endpoints: { health: '/health' } },
} as unknown as GatewayIdentity;

function stub(responses: Record<string, unknown>) {
  const calls: { url: string; method: string }[] = [];
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    const key = Object.keys(responses).find((k) => String(url).includes(k));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(key ? responses[key] : {}),
      json: async () => (key ? responses[key] : {}),
    };
  });
  return calls;
}

const listEnvelope = (sessions: SessionUsageInput[]) => ({ object: 'list', data: sessions });

describe('ManifestClient.listBotSessionCatalogue', () => {
  test('names the Bot in the query and leaves the stored scope where it was', async () => {
    const calls = stub({ '/v1/sessions': listEnvelope([{ id: 'ses_1' }]) });
    const client = new ManifestClient(PROFILE, IDENTITY);
    client.setBotId('keeper');
    const read = await client.listBotSessionCatalogue('other', 10);
    expect(read.map((session) => session.id)).toEqual(['ses_1']);
    expect(calls[0].url).toContain('bot=other');
    expect(calls[0].url).not.toContain('bot=keeper');
    // The app's own scope is a selection the Bot Chat is pinned to: reading
    // another Bot's catalogue must not move it.
    expect(client.botId).toBe('keeper');
  });

  test('carries the limit it was given, and no backend pin', async () => {
    const calls = stub({ '/v1/sessions': listEnvelope([]) });
    const client = new ManifestClient(PROFILE, IDENTITY);
    client.setBackendId('opencode-local');
    await client.listBotSessionCatalogue('other', SESSION_SPEND_LIST_LIMIT);
    expect(calls[0].url).toContain(`limit=${SESSION_SPEND_LIST_LIMIT}`);
    // A Bot names its own environment; pinning the thread's backend overrides
    // that on the Gate, so this read never carries one.
    expect(calls[0].url).not.toContain('backendId=');
  });

  test('appends with & when the advertised path already carries a query', async () => {
    const calls = stub({ '/v1/sessions': listEnvelope([]) });
    const client = new ManifestClient(PROFILE, {
      ...IDENTITY,
      manifest: {
        ...IDENTITY.manifest!,
        endpoints: { ...IDENTITY.manifest!.endpoints, sessions: '/v1/sessions?scope=all' },
      },
    } as unknown as GatewayIdentity);
    await client.listBotSessionCatalogue('other', 10);
    expect(calls[0].url).toContain('/v1/sessions?scope=all&bot=other');
    expect(calls[0].url).toContain('limit=10');
  });

  test('unwraps the Gate list envelope; a raw array is a list too', async () => {
    stub({ '/v1/sessions': listEnvelope([{ id: 'ses_1' }]) });
    const enveloped = new ManifestClient(PROFILE, IDENTITY);
    expect(await enveloped.listBotSessionCatalogue('other', 10)).toEqual([{ id: 'ses_1' }]);

    stub({ '/v1/sessions': [{ id: 'ses_2' }] });
    const raw = new ManifestClient(PROFILE, IDENTITY);
    expect(await raw.listBotSessionCatalogue('other', 10)).toEqual([{ id: 'ses_2' }]);
  });

  test('refuses with the same named capability error getSessions throws', async () => {
    const client = new ManifestClient(PROFILE, NO_SESSIONS);
    await expect(client.listBotSessionCatalogue('other', 10)).rejects.toThrow(
      /does not advertise session management/,
    );
  });

  test('leaves getSessions scoped exactly as it was — the thread glance still reads that read', async () => {
    const calls = stub({ '/v1/sessions': listEnvelope([{ id: 'ses_1' }]) });
    const client = new ManifestClient(PROFILE, IDENTITY);
    client.setBackendId('opencode-local');
    await client.getSessions(10);
    expect(calls[0].url).toContain('backendId=opencode-local');
    expect(calls[0].url).not.toContain('bot=');
  });
});

describe('readBotSpend', () => {
  const roster: BotSpendRosterEntry[] = [
    { id: 'alpha', displayName: 'Alpha' },
    { id: 'beta', displayName: 'Beta' },
  ];

  test('folds one scoped read per roster Bot into one row each', async () => {
    const readBotSessions = jest.fn(async (botId: string) =>
      listEnvelope(
        botId === 'alpha'
          ? [{ id: 'a1', input_tokens: 100, output_tokens: 20, actual_cost_usd: 0.9 }]
          : [{ id: 'b1', input_tokens: 10, output_tokens: 1, actual_cost_usd: 0.1 }],
      ),
    );
    const report = await readBotSpend({ listBots: async () => roster, readBotSessions });
    expect(report.degraded).toBe(false);
    expect(report.rows.map((row) => [row.botId, row.label, row.tokens, row.costUsd])).toEqual([
      ['alpha', 'Alpha', 120, 0.9],
      ['beta', 'Beta', 11, 0.1],
    ]);
  });

  test('asks each Bot for its own catalogue, one at a time, with the shared cap', async () => {
    const calls: [string, number][] = [];
    const readBotSessions = jest.fn(async (botId: string, limit: number) => {
      calls.push([botId, limit]);
      return listEnvelope([]);
    });
    await readBotSpend({ listBots: async () => roster, readBotSessions });
    expect(calls).toEqual([
      ['alpha', SESSION_SPEND_LIST_LIMIT],
      ['beta', SESSION_SPEND_LIST_LIMIT],
    ]);
  });

  test('keeps a Bot whose read was refused as a named, digit-free row', async () => {
    const readBotSessions = jest.fn(async (botId: string) => {
      if (botId === 'beta') throw new Error('503');
      return listEnvelope([{ id: 'a1', input_tokens: 5, actual_cost_usd: 0.2 }]);
    });
    const report = await readBotSpend({ listBots: async () => roster, readBotSessions });
    const failed = report.rows.find((row) => row.botId === 'beta');
    expect(failed).toMatchObject({ label: 'Beta', failed: true, basis: null, tokens: null, costUsd: null });
    expect(report.rows.find((row) => row.botId === 'alpha')?.failed).toBe(false);
  });

  test('a Bot whose answer is not a session list is the same named failure', async () => {
    const readBotSessions = jest.fn(async (botId: string) =>
      botId === 'beta' ? { nope: true } : listEnvelope([]),
    );
    const report = await readBotSpend({ listBots: async () => roster, readBotSessions });
    const unread = report.rows.filter((row) => row.failed);
    expect(unread.map((row) => row.label)).toEqual(['Beta']);
  });

  test('degrades to the gateway total alone when the gateway has no scoped read', async () => {
    const listBots = jest.fn(async () => roster);
    const source: BotSpendSource = { listBots };
    const report = await readBotSpend(source);
    expect(report).toEqual({ rows: [], degraded: true });
    // The capability is known before a request that could only be refused.
    expect(listBots).not.toHaveBeenCalled();
  });

  test('an empty roster is not degraded, and nothing is read', async () => {
    const readBotSessions = jest.fn(async () => listEnvelope([]));
    const report = await readBotSpend({ listBots: async () => [], readBotSessions });
    expect(report).toEqual({ rows: [], degraded: false });
    expect(readBotSessions).not.toHaveBeenCalled();
  });

  test('labels a row by the roster name, falling back to the id, and carries the basis', async () => {
    const readBotSessions = jest.fn(async (botId: string) =>
      botId === 'alpha'
        ? listEnvelope([{ id: 'a1', estimated_cost_usd: 0.5 }])
        : listEnvelope([{ id: 'b1', input_tokens: 3 }]),
    );
    const report = await readBotSpend({
      listBots: async () => [{ id: 'alpha' }, { id: 'beta', displayName: '   ' }],
      readBotSessions,
    });
    const alpha = report.rows.find((row) => row.botId === 'alpha');
    const beta = report.rows.find((row) => row.botId === 'beta');
    expect(alpha).toMatchObject({ label: 'alpha', basis: 'estimated' });
    expect(beta).toMatchObject({ label: 'beta', basis: 'none' });
  });

  test('a failed row never prints a number — no zero, no price', async () => {
    const readBotSessions = jest.fn(async () => {
      throw new Error('offline');
    });
    const report = await readBotSpend({ listBots: async () => roster, readBotSessions });
    for (const row of report.rows) {
      const copy = botSpendRowCopy(row);
      expect(copy).toBe(SPEND_UNREAD_COPY);
      expect(copy).not.toMatch(/[0-9$]/);
    }
    expect(report.rows).toHaveLength(2);
  });

  test('orders costed rows biggest first and leaves the cost-less ones below', async () => {
    const readBotSessions = jest.fn(async (botId: string) => {
      if (botId === 'alpha') return listEnvelope([{ id: 'a1', actual_cost_usd: 0.2 }]);
      return listEnvelope([{ id: 'b1', input_tokens: 9 }]);
    });
    const report = await readBotSpend({ listBots: async () => roster, readBotSessions });
    expect(report.rows.map((row) => row.botId)).toEqual(['alpha', 'beta']);
  });

  test('the orchestration reuses the shipped folds rather than re-adding tokens', () => {
    const source = readSource('src', 'lib', 'gateway', 'spend-report.ts');
    expect(source).toContain('sessionSpendReadFromUnknown');
    expect(source).toContain('totalUsage');
    expect(source).toContain('botSpendRows');
  });
});

describe('the read the per-Bot report consumes is the client method, not a second transport', () => {
  test('ManifestClient exposes the scoped catalogue read the source expects', () => {
    const client = new ManifestClient(PROFILE, IDENTITY);
    expect(typeof client.listBotSessionCatalogue).toBe('function');
  });

  test('the client method is declared optional on PortalClient so other adapters degrade', () => {
    const source = readSource('src', 'lib', 'portal', 'adapters.ts');
    expect(source).toContain('listBotSessionCatalogue?(botId: string, limit?: number)');
  });
});
