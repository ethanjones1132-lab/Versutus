import { hasBotSessionScoping } from '@/lib/gateway/bots';
import { ManifestClient } from '@/lib/gateway/manifest-client';
import { SESSION_SPEND_LIST_LIMIT, type SessionUsageInput } from '@/lib/gateway/session-analytics';
import {
  botSpendCapCopy,
  botSpendRowCopy,
  botSpendSectionBasis,
  readBotSpend,
  SPEND_PER_BOT_DEGRADED_COPY,
  SPEND_UNREAD_COPY,
  type BotSpendRow,
} from '@/lib/gateway/spend-report';
import type { GatewayProfile } from '@/lib/gateway/types';
import type { GatewayIdentity } from '@/lib/portal/identify';

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

const section = () => readSource('src', 'components', 'gateway', 'spend-per-bot-section.tsx');
const spendScreen = () => readSource('src', 'app', 'gateway', 'spend.tsx');
const provider = () => readSource('src', 'context', 'gateway-provider.tsx');

/** One folded row, for the header and copy rules the section renders. */
function row(over: Partial<BotSpendRow>): BotSpendRow {
  return {
    botId: 'alpha',
    label: 'Alpha',
    basis: 'actual',
    tokens: 120,
    costUsd: 0.9,
    failed: false,
    ...over,
  };
}

const listEnvelope = (sessions: SessionUsageInput[]) => ({ object: 'list', data: sessions });

describe('the per-Bot section header is the basis every row agrees on', () => {
  test('every row actual reads as actual', () => {
    expect(botSpendSectionBasis([row({ botId: 'a' }), row({ botId: 'b' })])).toBe('actual');
  });

  test('every row estimated reads as estimated', () => {
    expect(
      botSpendSectionBasis([row({ botId: 'a', basis: 'estimated' }), row({ botId: 'b', basis: 'estimated' })]),
    ).toBe('estimated');
  });

  test('a roster whose reads answered with no cost fields reads as tokens-only', () => {
    expect(
      botSpendSectionBasis([
        row({ botId: 'a', basis: 'none', costUsd: null }),
        row({ botId: 'b', basis: 'none', costUsd: null }),
      ]),
    ).toBe('none');
  });

  test('one actual beside one estimated has no single honest header', () => {
    expect(
      botSpendSectionBasis([row({ botId: 'a' }), row({ botId: 'b', basis: 'estimated' })]),
    ).toBeNull();
  });

  test('one actual beside a read with no cost fields has none either', () => {
    expect(
      botSpendSectionBasis([row({ botId: 'a' }), row({ botId: 'b', basis: 'none', costUsd: null })]),
    ).toBeNull();
  });

  test('a failed row is not a basis — it is unknown, not none', () => {
    // An all-failed roster must never write a header at all: branching on
    // `basis` before `failed` would read a failed row's null as "no costs".
    expect(
      botSpendSectionBasis([
        row({ botId: 'a', basis: null, tokens: null, costUsd: null, failed: true }),
        row({ botId: 'b', basis: null, tokens: null, costUsd: null, failed: true }),
      ]),
    ).toBeNull();
  });

  test('a failed row does not spoil the header the costed rows share', () => {
    expect(
      botSpendSectionBasis([
        row({ botId: 'a' }),
        row({ botId: 'b', basis: null, tokens: null, costUsd: null, failed: true }),
      ]),
    ).toBe('actual');
  });

  test('no rows have no header', () => {
    expect(botSpendSectionBasis([])).toBeNull();
  });
});

describe('the four states the section is asked to render', () => {
  test('a gateway with no scoped read degrades, and the roster is never asked', async () => {
    const listBots = jest.fn(async () => [{ id: 'alpha', displayName: 'Alpha' }]);
    const report = await readBotSpend({ listBots });
    expect(report).toEqual({ rows: [], degraded: true });
    expect(listBots).not.toHaveBeenCalled();
    expect(section()).toContain('{SPEND_PER_BOT_DEGRADED_COPY}');
    expect(SPEND_PER_BOT_DEGRADED_COPY).not.toMatch(/[0-9$]/);
  });

  test('an empty roster is a missing section, not an empty list of Bots', async () => {
    const readBotSessions = jest.fn(async () => listEnvelope([]));
    const report = await readBotSpend({ listBots: async () => [], readBotSessions });
    expect(report).toEqual({ rows: [], degraded: false });
    expect(section()).toContain('if (report.rows.length === 0) return null;');
  });

  test('rows the scoped read returned are rendered one per Bot', async () => {
    const report = await readBotSpend({
      listBots: async () => [
        { id: 'alpha', displayName: 'Alpha' },
        { id: 'beta', displayName: 'Beta' },
      ],
      readBotSessions: async (botId: string) =>
        listEnvelope(
          botId === 'alpha'
            ? [{ id: 'a1', input_tokens: 100, output_tokens: 20, actual_cost_usd: 0.9 }]
            : [{ id: 'b1', input_tokens: 10, output_tokens: 1, actual_cost_usd: 0.1 }],
        ),
    });
    expect(report.rows.map((entry) => entry.label)).toEqual(['Alpha', 'Beta']);
    expect(botSpendSectionBasis(report.rows)).toBe('actual');
    // The label is the section's own line; the row copy carries the number and
    // the basis that number is claimed on.
    const top = botSpendRowCopy(report.rows[0]);
    expect(top).toContain('tokens');
    expect(top).toContain('(actual)');
  });

  test('a Bot whose read failed stays a named row with no number, and no header for it', async () => {
    const report = await readBotSpend({
      listBots: async () => [
        { id: 'alpha', displayName: 'Alpha' },
        { id: 'beta', displayName: 'Beta' },
      ],
      readBotSessions: async (botId: string) => {
        if (botId === 'beta') throw new Error('503');
        return listEnvelope([{ id: 'a1', input_tokens: 5, actual_cost_usd: 0.2 }]);
      },
    });
    const beta = report.rows.find((entry) => entry.botId === 'beta');
    expect(beta?.label).toBe('Beta');
    expect(botSpendRowCopy(beta!)).toBe(SPEND_UNREAD_COPY);
    expect(botSpendRowCopy(beta!)).not.toMatch(/[0-9$]/);
    // The surviving actual row still earns the header — a failed read does not
    // turn the whole section into an unlabelled one.
    expect(botSpendSectionBasis(report.rows)).toBe('actual');
  });
});

describe('the per-Bot rows name the cap every one of them was read at', () => {
  test('the caption names the list cap the scoped reads stopped at', () => {
    expect(SESSION_SPEND_LIST_LIMIT).toBe(200);
    expect(botSpendCapCopy(SESSION_SPEND_LIST_LIMIT)).toContain('newest 200 sessions');
  });

  test('the caption carries the cap it was handed, so it cannot go stale', () => {
    expect(botSpendCapCopy(50)).toContain('newest 50 sessions');
    expect(botSpendCapCopy(50)).not.toContain('200');
  });

  test('the cap is the only number the caption prints — never a result count', () => {
    for (const limit of [1, 200, 500]) {
      const copy = botSpendCapCopy(limit);
      expect(copy.match(/\d+/g)).toEqual([String(limit)]);
      expect(copy).not.toMatch(/7 days|last 7/i);
    }
  });

  test('the section renders the caption exactly once, under the rows', () => {
    const src = section();
    const rows = src.indexOf('{botSpendRowCopy(row)}');
    const cap = src.indexOf('botSpendCapCopy(');
    expect(src.match(/botSpendCapCopy\(/g)).toHaveLength(1);
    expect(rows).toBeGreaterThanOrEqual(0);
    expect(cap).toBeGreaterThan(rows);
  });

  test('the degraded line reads no rows, so it names no cap', () => {
    const src = section();
    const degraded = src.indexOf('if (report.degraded)');
    const empty = src.indexOf('if (report.rows.length === 0) return null;');
    expect(degraded).toBeGreaterThanOrEqual(0);
    expect(empty).toBeGreaterThan(degraded);
    expect(src.slice(degraded, empty)).not.toContain('botSpendCapCopy');
  });

  test('the cap is not in place of the basis header', () => {
    const src = section();
    const header = src.indexOf('{spendBasisCopy(shared)}');
    const cap = src.indexOf('botSpendCapCopy(');
    expect(header).toBeGreaterThanOrEqual(0);
    expect(cap).toBeGreaterThan(header);
  });

  test('the row line keeps the tokens, the cost and the basis it printed before', () => {
    const copy = botSpendRowCopy(row({}));
    expect(copy).toContain('tokens');
    expect(copy).toContain('$0.90');
    expect(copy).toContain('(actual)');
  });

  test('a failed Bot still reads as the shipped unread copy, with no number', () => {
    const failed = botSpendRowCopy(row({ failed: true, basis: null, tokens: null, costUsd: null }));
    expect(failed).toBe(SPEND_UNREAD_COPY);
    expect(failed).not.toMatch(/[0-9$]/);
  });
});

describe('the section paints the shipped folds and aggregates nothing itself', () => {
  test('every string on it comes from the module that decided it', () => {
    const src = section();
    expect(src).toContain("from '@/lib/gateway/spend-report'");
    expect(src).toContain('{botSpendRowCopy(row)}');
    expect(src).toContain('botSpendSectionBasis(report.rows)');
    expect(src).toContain('{spendBasisCopy(shared)}');
    expect(src).toContain('{SPEND_PER_BOT_DEGRADED_COPY}');
  });

  test('no number is computed on the section', () => {
    const src = section();
    expect(src).not.toContain('totalUsage');
    expect(src).not.toContain('formatCost');
    expect(src).not.toContain('formatTokenCount');
  });

  test('the degraded and empty-roster cases short-circuit before any row renders', () => {
    const src = section();
    const degraded = src.indexOf('if (report.degraded)');
    const empty = src.indexOf('if (report.rows.length === 0) return null;');
    const rows = src.indexOf('{botSpendRowCopy(row)}');
    expect(degraded).toBeGreaterThanOrEqual(0);
    expect(degraded).toBeLessThan(empty);
    expect(empty).toBeLessThan(rows);
  });

  test('the header renders only when the rows agree, and the rows carry their own basis regardless', () => {
    const src = section();
    const header = src.indexOf('{spendBasisCopy(shared)}');
    const guard = src.indexOf('{shared ? (');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(header).toBeGreaterThan(guard);
  });
});

describe('the Spend screen wires the per-Bot read without re-reading the gateway total', () => {
  test('the total stays the one catalogue read this screen makes', () => {
    const src = spendScreen();
    expect(src.match(/gatewayRequest\('sessions\.list'/g)).toHaveLength(1);
    expect(src).toContain("gatewayRequest('sessions.list', { limit: SESSION_SPEND_LIST_LIMIT })");
    expect(src).toContain('{sessionSpendCopy(spend)}');
  });

  test('the per-Bot rows come from readBotSpend over the provider reads', () => {
    const src = spendScreen();
    expect(src).toContain('readBotSpend(');
    expect(src).toContain('listBots, readBotSessions');
    expect(src).toContain('<SpendPerBotSection');
  });

  test('the scoped read is offered only when the gateway advertises it', () => {
    const src = spendScreen();
    expect(src).toContain('canReadBotSessions ? { listBots, readBotSessions } : { listBots }');
  });

  test('the screen never authors a degraded verdict of its own', () => {
    const src = spendScreen();
    // `degraded` is readBotSpend's own finding — the source carried no scoped
    // read. A thrown roster read must not borrow that line, which claims a
    // capability the gateway may well have; its failure branch claims no rows
    // and no verdict, and does not report a fact it did not observe.
    const readAt = src.indexOf('readBotSpend(');
    const catchAt = src.indexOf('.catch(() => {', readAt);
    const failureBranch = src.slice(catchAt, src.indexOf('});', catchAt));
    expect(catchAt).toBeGreaterThan(readAt);
    expect(failureBranch).toContain('setBotReport(null);');
    expect(failureBranch).not.toContain('rows:');
  });
});

describe('the capability gate is decided before a request that could only be refused', () => {
  const PROFILE: GatewayProfile = {
    id: 'gate-1',
    name: 'Gate',
    url: 'http://gate.local:8760',
    token: 'tok',
    createdAt: 0,
  };

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
      },
      capabilities: { chat: true, models: true, sessions: true },
    },
  } as unknown as GatewayIdentity;

  const NO_SESSIONS = {
    ...IDENTITY,
    manifest: { ...IDENTITY.manifest!, endpoints: { health: '/health' } },
  } as unknown as GatewayIdentity;

  test('no client at all cannot scope', () => {
    expect(hasBotSessionScoping(null)).toBe(false);
    expect(hasBotSessionScoping(undefined)).toBe(false);
  });

  test('a client with the catalogue read but no scoped form cannot', () => {
    expect(hasBotSessionScoping({ getSessions: () => [] })).toBe(false);
  });

  test('a manifest client whose document declares no sessions route cannot', () => {
    expect(hasBotSessionScoping(new ManifestClient(PROFILE, NO_SESSIONS))).toBe(false);
  });

  test('the Gate client that shipped the scoped read can', () => {
    expect(hasBotSessionScoping(new ManifestClient(PROFILE, IDENTITY))).toBe(true);
  });

  test('the provider decides it at client install and exposes the scoped read', () => {
    const src = provider();
    expect(src).toContain('setCanReadBotSessions(probeBotSessionScoping(client))');
    expect(src).toContain('canReadBotSessions: boolean;');
    expect(src).toContain('setCanReadBotSessions(false);');
    expect(src).toContain('readBotSessions: (botId: string, limit: number) => Promise<unknown>;');
    expect(src).toContain('client.listBotSessionCatalogue(botId, limit)');
  });
});

describe('what must keep working', () => {
  test("the total's bound line and the basis header are still the shipped copy", () => {
    const src = spendScreen();
    expect(src).toContain('spendTotalBoundCopy(state.rowCount)');
    expect(src).toContain('spendCostBasis(state.sessions)');
    expect(src).toContain('spendBasisCopy(basis)');
  });

  test('the shared cap still travels with the per-Bot read', () => {
    const src = readSource('src', 'lib', 'gateway', 'spend-report.ts');
    expect(src).toContain('SESSION_SPEND_LIST_LIMIT');
    expect(SESSION_SPEND_LIST_LIMIT).toBe(200);
  });
});
