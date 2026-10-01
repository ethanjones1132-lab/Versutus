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

// A caller that walks away must stop the app issuing more of the fan-out, and
// must stop the lane it left behind from growing another attempt: `signal`
// reaches the reader itself, which is where the retry ladder lives. What no
// signal can do is recall the request already on the wire, so the pool refuses
// to start the next Bot and discards the lane that was in flight — a half-read
// roster must never be returned as if it were the whole thing.
describe('readBotSpend honours an abort', () => {
  /**
   * The wave's outcome, observed rather than awaited at the point of failure:
   * an unhandled rejection here would be reported as a Node warning and hide
   * the assertion that matters.
   */
  function watch(promise: Promise<unknown>): { settled: () => Promise<{ ok: boolean; value: unknown }> } {
    const outcome = promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, value: error }),
    );
    return { settled: () => outcome };
  }

  test('an abort mid-roster starts no further Bot read and rejects the wave', async () => {
    const log: string[] = [];
    const { source, settle } = deferredSource({ log });
    const controller = new AbortController();
    const wave = watch(readBotSpend(source, { signal: controller.signal }));

    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['a', 'b']);

    controller.abort();
    settle('a');
    settle('b');
    await new Promise((r) => setTimeout(r, 0));

    // a and b answered into an aborted wave: c must never be started.
    expect(log).toEqual(['a', 'b']);
    const outcome = await wave.settled();
    expect(outcome.ok).toBe(false);
    expect(String(outcome.value)).toMatch(/stopped before it finished/i);
  });

  test('a lane that answers after the abort cannot fill a row', async () => {
    const log: string[] = [];
    const { source, settle } = deferredSource({ log });
    const controller = new AbortController();
    const wave = watch(readBotSpend(source, { signal: controller.signal }));

    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    // The abort lands first; the answers follow, as they would from a Gate
    // already mid-read.
    settle('a');
    settle('b');

    expect((await wave.settled()).ok).toBe(false);
  });

  test('a signal already aborted never asks for the roster', async () => {
    const calls: string[] = [];
    const source: BotSpendSource = {
      listBots: async () => {
        calls.push('listBots');
        return [{ id: 'a' }];
      },
      readBotSessions: async () => {
        calls.push('read');
        return catalogued('a');
      },
    };
    const controller = new AbortController();
    controller.abort();

    await expect(readBotSpend(source, { signal: controller.signal })).rejects.toThrow(
      /stopped before it finished/i,
    );
    expect(calls).toEqual([]);
  });

  test('an aborted wave is never mistaken for a Bot that could not be read', async () => {
    // The aborted rejection is a walk-away, not a failure row: `degraded` and
    // `{ ok: false }` both make claims about the gateway, and an abandoned read
    // has observed neither.
    const log: string[] = [];
    const { source, settle } = deferredSource({ log });
    const controller = new AbortController();
    const done = readBotSpend(source, { signal: controller.signal }).catch((error) => error);

    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    settle('a');
    settle('b');

    const outcome = await done;
    expect(outcome).not.toHaveProperty('rows');
    expect(String(outcome)).not.toMatch(/degraded/);
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
