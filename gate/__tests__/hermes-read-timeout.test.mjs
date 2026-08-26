import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHermesBackend } from '../core/cli-environments/backends/hermes.mjs';

// Observed 2026-08-26 on Ethan's host: `state.db` had grown to 4.8 GB, and
// `GET /api/sessions?limit=200` took 9-12 MINUTES and returned zero bytes while
// `/health` still answered 200 instantly. The Gate passed no signal to fetch, so
// the phone waited forever on a gateway that looked connected and could not list
// one session. A metadata read now fails at 25s with a cause worth reading.

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
  // Proves it aborted rather than hung; the ceiling is 25s.
  assert.ok(Date.now() - started < 5_000);
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
