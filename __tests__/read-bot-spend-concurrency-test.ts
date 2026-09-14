import {
  READ_BOT_SPEND_CONCURRENCY,
  readBotSpend,
  type BotSpendSource,
} from '@/lib/gateway/spend-report';
import type { SessionUsageInput } from '@/lib/gateway/session-analytics';

const catalogued = (id: string) => [
  { id, input_tokens: 10, actual_cost_usd: 0.5 } as unknown as SessionUsageInput,
];

function deferred(): { resolve: (value: unknown) => void; promise: Promise<unknown> } {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

/** A source with deferred reads so the runner's concurrency can be observed. */
function deferredSource(callLog: { log: string[] }) {
  const pending = new Map<string, { resolve: (value: unknown) => void }>();
  return {
    source: {
      listBots: async () =>
        [
          { id: 'a' },
          { id: 'b' },
          { id: 'c' },
          { id: 'd' },
          { id: 'e' },
        ] as { id: string; displayName?: string }[],
      readBotSessions: (botId: string) => {
        callLog.log.push(botId);
        const gate = deferred();
        pending.set(botId, gate);
        return gate.promise;
      },
    } satisfies BotSpendSource,
    settle: (botId: string) => pending.get(botId)?.resolve(catalogued(botId)),
  };
}

describe('readBotSpend runs the roster bounded-concurrent', () => {
  test('macro: starts READ_BOT_SPEND_CONCURRENCY at a time, not one and not all', async () => {
    const log: string[] = [];
    const { source, settle } = deferredSource({ log });
    let report: Awaited<ReturnType<typeof readBotSpend>> | undefined;
    const done = readBotSpend(source).then((r) => {
      report = r;
    });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    // burst 1: exactly 2 outstanding, in roster order
    await tick();
    expect(log).toEqual(['a', 'b']);
    // a finishes → exactly one slot frees, the pool advances to the next Bot
    settle('a');
    await tick();
    expect(log).toEqual(['a', 'b', 'c']);
    settle('b');
    await tick();
    expect(log).toEqual(['a', 'b', 'c', 'd']);
    settle('c');
    await tick();
    expect(log).toEqual(['a', 'b', 'c', 'd', 'e']);
    settle('d');
    settle('e');
    await done;
    expect(log).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(report?.rows.map((row) => row.botId)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('micro: never more than READ_BOT_SPEND_CONCURRENCY in flight; a list refusal is not a retry', async () => {
    const calls: string[] = [];
    let inflight = 0;
    let peak = 0;
    const source: BotSpendSource = {
      listBots: async () =>
        Array.from({ length: 10 }, (_, i) => ({ id: `bot-${i}`, displayName: `Bot ${i}` })),
      readBotSessions: async (botId: string) => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        calls.push(botId);
        await new Promise((r) => setTimeout(r, 2));
        inflight -= 1;
        if (botId === 'bot-3') throw new Error('refused');
        return catalogued(botId);
      },
    };
    const report = await readBotSpend(source);
    expect(peak).toBe(READ_BOT_SPEND_CONCURRENCY);
    expect(calls).toHaveLength(10);
    const refused = report.rows.find((row) => row.botId === 'bot-3');
    expect(refused?.failed).toBe(true);
    // one read attempt per Bot — the fold never multiplies the load
    expect(calls.filter((id) => id === 'bot-3')).toHaveLength(1);
  });

  test('an empty or single-Bot roster still folds one read', async () => {
    const calls: string[] = [];
    const source: BotSpendSource = {
      listBots: async () => [{ id: 'solo', displayName: 'Solo' }],
      readBotSessions: async (botId: string) => {
        calls.push(botId);
        return catalogued(botId);
      },
    };
    const report = await readBotSpend(source);
    expect(calls).toEqual(['solo']);
    expect(report).toEqual({
      degraded: false,
      rows: [
        { botId: 'solo', label: 'Solo', basis: 'actual', tokens: 10, costUsd: 0.5, failed: false },
      ],
    });
  });
});

describe('readBotSpend still answers as it always has', () => {
  test('no per-Bot capability stays degraded with no rows', async () => {
    const source: BotSpendSource = { listBots: async () => [{ id: 'a' }] };
    expect(await readBotSpend(source)).toEqual({ rows: [], degraded: true });
  });

  test('confirming the shipped wall-time premise: the row shape is untouched', async () => {
    const source: BotSpendSource = {
      listBots: async () => [
        { id: 'big', displayName: 'Big' },
        { id: 'broken', displayName: 'Broken' },
      ],
      readBotSessions: async (botId: string) => {
        if (botId === 'broken') throw new Error('no');
        return catalogued(botId);
      },
    };
    const report = await readBotSpend(source);
    expect(report.degraded).toBe(false);
    expect(report.rows.map((row) => row.label)).toEqual(['Big', 'Broken']);
    expect(report.rows[0]).toEqual({
      botId: 'big',
      label: 'Big',
      basis: 'actual',
      tokens: 10,
      costUsd: 0.5,
      failed: false,
    });
    expect(report.rows[1].failed).toBe(true);
  });
});
