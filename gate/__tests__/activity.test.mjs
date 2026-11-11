import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectActivity, parseActivitySince, readActivitySessions } from '../core/activity.mjs';

const now = Date.parse('2026-11-10T12:00:00.000Z');

test('a session item carries the Bot the backend proved, and omits it otherwise', async () => {
  const result = await collectActivity({
    since: '2026-11-10T00:00:00.000Z',
    now,
    backends: [{
      id: 'one',
      label: 'One',
      listRuns: () => [],
      listSessions: () => [
        { id: 'tagged', started_at: now - 2000, last_active: now - 2000, bot: 'builder' },
        { id: 'untagged', started_at: now - 1000, last_active: now - 1000 },
        { id: 'empty-bot', started_at: now - 500, last_active: now - 500, bot: '' },
      ],
    }],
  });
  const byId = Object.fromEntries(result.items.map((item) => [item.sessionId, item]));
  assert.equal(byId.tagged.botId, 'builder');
  assert.equal(Object.hasOwn(byId.untagged, 'botId'), false);
  assert.equal(Object.hasOwn(byId['empty-bot'], 'botId'), false);
});

test('an empty title falls back to the preview, then to a readable default', async () => {
  const result = await collectActivity({
    since: '2026-11-10T00:00:00.000Z',
    now,
    backends: [{
      id: 'one',
      label: 'One',
      listRuns: () => [],
      listSessions: () => [
        { id: 'previewed', started_at: now - 2000, last_active: now - 2000, title: '', preview: 'From the preview' },
        { id: 'blank', started_at: now - 1000, last_active: now - 1000, title: '' },
      ],
    }],
  });
  const byId = Object.fromEntries(result.items.map((item) => [item.sessionId, item]));
  assert.equal(byId.previewed.title, 'From the preview');
  assert.equal(byId.blank.title, 'Session');
});

test('a cold start is bounded separately, so a slow start still yields its item', async () => {
  const result = await collectActivity({
    since: '2026-11-10T00:00:00.000Z',
    now,
    backends: [{
      id: 'one',
      label: 'One',
      listRuns: () => [],
      // The start outlasts the read bound; the list itself answers immediately.
      listSessions: () => readActivitySessions({
        start: () => new Promise((resolve) => setTimeout(
          () => resolve({ listSessions: async () => [{ id: 'cold', started_at: now - 1000, last_active: now - 1000 }] }),
          80,
        )),
        startTimeoutMs: 1_000,
        readTimeoutMs: 20,
      }),
    }],
  });
  assert.deepEqual(result.items.map((item) => item.sessionId), ['cold']);
});

test('a start that never finishes is still capped', async () => {
  await assert.rejects(
    readActivitySessions({ start: () => new Promise(() => {}), startTimeoutMs: 20 }),
    /start timed out/,
  );
});

test('since must be an explicit valid ISO instant', () => {
  assert.match(parseActivitySince(null).error, /since is required/);
  assert.match(parseActivitySince('yesterday').error, /valid ISO instant/);
  assert.equal(parseActivitySince('2026-11-10T00:00:00Z').timestamp, Date.parse('2026-11-10T00:00:00Z'));
});

test('the activity window is capped at seven days and the response says it was truncated', async () => {
  const oldSince = '2026-10-01T00:00:00.000Z';
  const result = await collectActivity({
    since: oldSince,
    now,
    backends: [{
      id: 'one',
      label: 'One',
      listRuns: () => [],
      listSessions: () => [{ id: 'within-window', started_at: now - 1000, last_active: now - 1000 }],
    }],
  });
  assert.equal(result.since, oldSince);
  assert.deepEqual(result.truncated, { window: true });
  assert.deepEqual(result.items.map((item) => item.sessionId), ['within-window']);
});

test('the item response is capped at 500 and marks truncation', async () => {
  const sessions = Array.from({ length: 501 }, (_, index) => ({
    id: `session-${index}`,
    started_at: now - index,
    last_active: now - index,
  }));
  const result = await collectActivity({
    since: '2026-11-10T00:00:00.000Z',
    now,
    backends: [{ id: 'one', label: 'One', listRuns: () => [], listSessions: () => sessions }],
  });
  assert.equal(result.items.length, 500);
  assert.deepEqual(result.truncated, { items: true });
});

test('a run that began before since but finished after it is in the window', async () => {
  const result = await collectActivity({
    since: '2026-11-10T00:00:00.000Z',
    now,
    backends: [{
      id: 'one',
      label: 'One',
      listRuns: () => [
        { runId: 'overnight', startedAt: '2026-11-09T23:00:00.000Z', endedAt: '2026-11-10T01:00:00.000Z', state: 'completed' },
        { runId: 'yesterday', startedAt: '2026-11-09T20:00:00.000Z', endedAt: '2026-11-09T21:00:00.000Z', state: 'completed' },
      ],
      listSessions: () => [],
    }],
  });
  assert.deepEqual(result.items.map((item) => item.id), ['one:run:overnight']);
});

test('backend status: failed only when every read failed, partial when some did', async () => {
  const boom = () => { throw new Error('offline'); };
  const result = await collectActivity({
    since: '2026-11-10T00:00:00.000Z',
    now,
    backends: [
      { id: 'all-failed', label: 'A', listRuns: boom, listSessions: boom },
      { id: 'half-failed', label: 'B', listRuns: () => [], listSessions: boom },
      { id: 'sessions-only', label: 'C', listSessions: () => [] },
      { id: 'nothing', label: 'D' },
      { id: 'healthy', label: 'E', listRuns: () => [], listSessions: () => [] },
    ],
  });
  const status = Object.fromEntries(result.backends.map((backend) => [backend.id, backend.status]));
  assert.deepEqual(status, {
    'all-failed': 'failed', 'half-failed': 'partial', 'sessions-only': 'partial', nothing: 'unavailable', healthy: 'complete',
  });
});

test('backends are read in parallel, not one after another', async () => {
  const slow = (ms) => () => new Promise((resolve) => setTimeout(() => resolve([]), ms));
  const started = Date.now();
  await collectActivity({
    since: '2026-11-10T00:00:00.000Z',
    now,
    backends: [1, 2, 3, 4].map((n) => ({ id: `b${n}`, label: `B${n}`, listRuns: slow(150), listSessions: slow(150) })),
  });
  assert.ok(Date.now() - started < 450, 'four 150 ms backends should finish well under 600 ms');
});
