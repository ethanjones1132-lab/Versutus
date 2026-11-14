import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readBotScopedRows } from '../core/bot-scoped-read.mjs';
import { collectActivity } from '../core/activity.mjs';
import { collectRoutines } from '../core/routines.mjs';

const now = Date.parse('2026-11-14T15:00:00Z');
const since = '2026-11-14T05:00:00Z';
const session = (id, extras = {}) => ({ id, started_at: now - 1000, last_active: now, ...extras });

function hermes(method, root, scopes) {
  return {
    [method]: async () => root,
    listBots: async () => ({ data: [{ id: 'default' }, ...Object.keys(scopes).map((id) => ({ id }))] }),
    forBot: async (botId) => ({
      [method]: async () => {
        const value = scopes[botId];
        if (value instanceof Error) throw value;
        return value;
      },
    }),
  };
}

test('Today includes named Bot homes, deduplicates scope identity, and keeps equal session IDs distinct', async () => {
  const backend = hermes('listSessions', [session('same')], {
    scout: [session('same'), session('same')],
    writer: [session('same')],
  });
  const result = await collectActivity({ since, now, backends: [{
    id: 'hermes', label: 'Hermes', listRuns: () => [],
    listSessions: () => readBotScopedRows({ backend, method: 'listSessions' }),
  }] });
  assert.equal(result.backends[0].status, 'complete');
  assert.equal(result.items.length, 3);
  assert.equal(new Set(result.items.map((item) => item.id)).size, 3);
  assert.deepEqual(result.items.map((item) => item.botId ?? null).sort(), [null, 'scout', 'writer'].sort());
});

test('a broken Bot keeps healthy Today rows and makes coverage partial', async () => {
  const backend = hermes('listSessions', [session('root')], {
    scout: [session('named')], offline: new Error('Bot listener refused'),
  });
  const result = await collectActivity({ since, now, backends: [{
    id: 'hermes', label: 'Hermes', listRuns: () => [],
    listSessions: () => readBotScopedRows({ backend, method: 'listSessions' }),
  }] });
  assert.equal(result.backends[0].status, 'partial');
  assert.match(result.backends[0].error, /offline/);
  assert.deepEqual(result.items.map((item) => item.sessionId).sort(), ['named', 'root']);
});

test('Routines preserves real storage scope separately from the title owner', async () => {
  const job = (name) => ({ id: 'equal', name, schedule: '0 9 * * *', schedule_display: 'At 09:00 (America/New_York)' });
  const backend = hermes('listJobs', [job('[bot:scout] Root record')], {
    scout: [job('Bot record')], offline: new Error('not reachable'),
  });
  const result = await collectRoutines({ backends: [{
    id: 'hermes', label: 'Hermes',
    listJobs: () => readBotScopedRows({ backend, method: 'listJobs' }),
  }] });
  assert.equal(result.backends[0].status, 'partial');
  assert.equal(result.routines.length, 2);
  assert.deepEqual(result.routines.map((row) => [row.botId, row.scopeBotId]), [['scout', null], ['scout', 'scout']]);
  assert.equal(result.routines[0].scheduleDisplay, 'At 09:00 (America/New_York)');
});

test('a session active today never presents lifetime counts from yesterday as today totals', async () => {
  const result = await collectActivity({ since, now, backends: [{
    id: 'one', label: 'One', listRuns: () => [], listSessions: () => [
      session('old', { started_at: Date.parse(since) - 1, message_count: 99, tool_call_count: 42, input_tokens: 1000, actual_cost_usd: 3 }),
      session('new', { message_count: 2, tool_call_count: 1 }),
    ],
  }] });
  assert.deepEqual(result.items.find((item) => item.sessionId === 'old').metrics, {});
  assert.equal(result.items.find((item) => item.sessionId === 'old').lastActiveAt, new Date(now).toISOString());
  assert.deepEqual(result.items.find((item) => item.sessionId === 'new').metrics, { turns: 2, tools: 1 });
});

test('an unreadable Bot roster is partial rather than an apparently complete default-only day', async () => {
  const result = await readBotScopedRows({ backend: {
    listSessions: async () => [session('root')],
    listBots: async () => { throw new Error('roster unreadable'); },
    forBot: async () => { throw new Error('must not guess a Bot'); },
  }, method: 'listSessions' });
  assert.equal(result.rows.length, 1);
  assert.match(result.errors.join(' '), /roster/);
});

test('a hung default home does not delay reads of healthy named Bots', async () => {
  let finishDefault;
  let namedStarted;
  const sawNamed = new Promise((resolve) => { namedStarted = resolve; });
  const pending = readBotScopedRows({ backend: {
    listSessions: () => new Promise((resolve) => { finishDefault = resolve; }),
    listBots: async () => [{ id: 'scout' }],
    forBot: async () => {
      namedStarted();
      return { listSessions: async () => [session('named')] };
    },
  }, method: 'listSessions', timeoutMs: 1000 });
  let guard;
  const started = await Promise.race([sawNamed.then(() => true), new Promise((resolve) => {
    guard = setTimeout(() => resolve(false), 50);
  })]);
  clearTimeout(guard);
  finishDefault([]);
  await pending;
  assert.equal(started, true, 'the independent named-home read must start before the default read settles');
});

test('the shared deadline stops opening new Bot reads after a timed-out batch', async () => {
  const opened = [];
  const backend = hermes('listSessions', [], Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((id) => [id, []])));
  backend.forBot = async (id) => {
    opened.push(id);
    return { listSessions: () => new Promise(() => {}) };
  };
  const guard = setTimeout(() => {}, 1000);
  try {
    const result = await readBotScopedRows({ backend, method: 'listSessions', timeoutMs: 20 });
    assert.deepEqual(opened, ['a', 'b', 'c', 'd']);
    assert.match(result.errors.join(' '), /Bot e/);
  } finally { clearTimeout(guard); }
});
