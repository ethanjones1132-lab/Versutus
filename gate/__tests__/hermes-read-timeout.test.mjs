import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHermesBackend } from '../core/cli-environments/backends/hermes.mjs';

// Observed 2026-08-26 on Ethan's host: `state.db` had grown to 4.8 GB, and
// `GET /api/sessions?limit=200` took 9-12 MINUTES and returned zero bytes while
// `/health` still answered 200 instantly. The Gate passed no signal to fetch, so
// the phone waited forever on a gateway that looked connected and could not list
// one session. A metadata read now fails at 30s with a cause worth reading.

/** A fetch that never settles, like the 4.8 GB host. */
function hangingFetch() {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no signal => hangs forever, the old behaviour
      if (signal.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: signal.reason?.name ?? 'TimeoutError' }));
      });
    });
}

test('a hung session listing is bounded rather than waiting forever', async () => {
  const backend = createHermesBackend({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'k',
    fetchImpl: hangingFetch(),
    readTimeoutMs: 40,
  });

  const started = Date.now();
  await assert.rejects(
    () => backend.listSessions(200),
    (error) => {
      assert.equal(error.code, 'backend_timeout');
      // The operator has to learn something actionable from this line.
      assert.match(error.message, /did not answer/i);
      assert.match(error.message, /state database/i);
      return true;
    },
  );
  // Proves it aborted rather than hung; the ceiling is 30s.
  assert.ok(Date.now() - started < 5_000);
});

test('a hung cron job listing is bounded by the same read ceiling', async () => {
  const backend = createHermesBackend({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'test-key',
    fetchImpl: hangingFetch(),
    readTimeoutMs: 40,
  });

  const started = Date.now();
  await assert.rejects(
    () => backend.listJobs(),
    (error) => {
      assert.equal(error.code, 'backend_timeout');
      // The Activity tab blocks on cron.jobs; the verdict names the surface.
      assert.match(error.message, /list cron jobs/);
      assert.match(error.message, /state database/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5_000);
});

test('a hung transcript listing is bounded by the same read ceiling', async () => {
  const backend = createHermesBackend({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'test-key',
    fetchImpl: hangingFetch(),
    readTimeoutMs: 40,
  });

  const started = Date.now();
  await assert.rejects(
    () => backend.listMessages('sess_1'),
    (error) => {
      assert.equal(error.code, 'backend_timeout');
      // The Activity tab blocks on cron.transcript; the verdict names it.
      assert.match(error.message, /list messages/);
      assert.match(error.message, /state database/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5_000);
});

test('a healthy cron listing still returns its jobs', async () => {
  // Guard against the timeout wrapper breaking the normal path.
  const backend = createHermesBackend({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'job_1', paused: false }] }),
      text: async () => '',
    }),
  });
  const body = await backend.listJobs();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].id, 'job_1');
});

test('a healthy transcript read still maps and filters', async () => {
  const backend = createHermesBackend({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'm1', role: 'assistant', content: 'answer', timestamp: 1 },
          { id: 'm2', role: 'assistant', content: '', timestamp: 2 },
        ],
      }),
      text: async () => '',
    }),
  });
  const messages = await backend.listMessages('sess_1', 5);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'm1');
});

test('the timeout names the read that failed, not a bare abort', async () => {
  const backend = createHermesBackend({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'k',
    fetchImpl: hangingFetch(),
    readTimeoutMs: 40,
  });
  await assert.rejects(
    () => backend.listSessions(),
    (error) => {
      assert.match(error.message, /list sessions/);
      // "AbortError" alone reads like a client bug rather than a slow host.
      assert.doesNotMatch(error.message, /AbortError/);
      return true;
    },
  );
});

test('a real failure is passed through untouched', async () => {
  // Only the timeout is reworded. A 500 must keep saying what Hermes said, or
  // the rewording becomes its own kind of lie.
  const backend = createHermesBackend({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'k',
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: { message: 'database is locked' } }),
      json: async () => ({}),
    }),
  });
  await assert.rejects(
    () => backend.listSessions(10),
    (error) => {
      assert.match(error.message, /database is locked/);
      assert.notEqual(error.code, 'backend_timeout');
      return true;
    },
  );
});

test('a healthy read still returns its sessions', async () => {
  // Guard against the timeout wrapper breaking the normal path.
  const backend = createHermesBackend({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'k',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'sess_1', title: 'one' }] }),
      text: async () => '',
    }),
  });
  const sessions = await backend.listSessions(5);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'sess_1');
});
