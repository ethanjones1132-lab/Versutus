import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHermesBackend } from '../core/cli-environments/backends/hermes.mjs';

// Observed 2026-08-26 on Ethan's host: `state.db` had grown to 4.8 GB, and
// `GET /api/sessions?limit=200` took 9-12 MINUTES and returned zero bytes while
// `/health` still answered 200 instantly. The Gate passed no signal to fetch, so
// the phone waited forever on a gateway that looked connected and could not list
// one session. A metadata read now fails at 30s with a cause worth reading.

/**
 * A fetch that never settles, like the 4.8 GB host.
 *
 * The in-flight timer is load-bearing and must be REF'd. `AbortSignal.timeout()`
 * arms an UNREF'd timer, so it cannot by itself hold the process open: a real fetch
 * keeps the loop alive with its socket, but this fake holds no handle at all. Without
 * something ref'd here the loop drains before the ceiling is reached, the abort never
 * fires, and `node --test` reports every one of these as "Promise resolution is still
 * pending but the event loop has already resolved" -- which reads as a broken timeout
 * in the backend rather than a fake that does not model a live request.
 */
function hangingFetch() {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no signal => hangs forever, the old behaviour
      const fail = (name) =>
        reject(Object.assign(new Error('aborted'), { name }));
      if (signal.aborted) {
        fail('TimeoutError');
        return;
      }
      const inFlight = setTimeout(() => {}, 30_000);
      signal.addEventListener('abort', () => {
        clearTimeout(inFlight);
        fail(signal.reason?.name ?? 'TimeoutError');
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
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'job_1', paused: false }] }), { status: 200 }),
  });
  const body = await backend.listJobs();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].id, 'job_1');
});

test('a healthy transcript read still maps and filters', async () => {
  const backend = createHermesBackend({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'test-key',
    fetchImpl: async () => new Response(JSON.stringify({
        data: [
          { id: 'm1', role: 'assistant', content: 'answer', timestamp: 1 },
          { id: 'm2', role: 'assistant', content: '', timestamp: 2 },
        ],
      }), { status: 200 }),
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
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: 'sess_1', title: 'one' }] }), { status: 200 }),
  });
  const sessions = await backend.listSessions(5);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'sess_1');
});

test('a session listing given the long bound waits for it instead of failing', async () => {
  // Measured 2026-10-01: a cold `GET /api/sessions?limit=50` on the 6.2 GB host
  // took 38.5 s. Aborted at 30 s, it could never succeed at all — so the Gate's
  // own copy of the list refills with a bound that lets it finish.
  const slowFetch = async (_url, init) => {
    // A host that answers, but late: the signal is what decides whether the
    // answer is ever read, exactly as it is for a real fetch.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 120);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: init.signal.reason?.name ?? 'TimeoutError' }));
      });
    });
    return new Response(JSON.stringify({ data: [{ id: 'sess_1' }] }), { status: 200 });
  };
  const backend = createHermesBackend({
    baseUrl: 'http://127.0.0.1:8642',
    apiKey: 'k',
    fetchImpl: slowFetch,
    readTimeoutMs: 40,
  });

  const sessions = await backend.listSessions(5, { timeoutMs: 2_000 });
  assert.equal(sessions.length, 1, 'a read slower than the screen bound is still allowed to land');

  // The same read without that per-call bound is the failure it always was: the
  // screen bound is unchanged for every other caller.
  await assert.rejects(
    () => createHermesBackend({
      baseUrl: 'http://127.0.0.1:8642',
      apiKey: 'k',
      fetchImpl: slowFetch,
      readTimeoutMs: 40,
    }).listSessions(5),
    (error) => {
      assert.equal(error.code, 'backend_timeout');
      return true;
    },
  );
});

test('the read bound is 30 s by default, and only a caller may move it', async () => {
  // A fetch that refuses exactly as an expired AbortSignal.timeout() would, so
  // the ceiling can be read off the message without waiting for it.
  const fetchImpl = async (_url, init) => {
    assert.ok(init?.signal, 'a read must still pass a signal');
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  };
  const backend = createHermesBackend({ baseUrl: 'http://127.0.0.1:8642', apiKey: 'k', fetchImpl });

  await assert.rejects(
    () => backend.listSessions(200),
    (error) => {
      assert.equal(error.code, 'backend_timeout');
      assert.match(error.message, /within 30s/, 'the screen bound is unchanged');
      return true;
    },
  );
  await assert.rejects(
    () => backend.listSessions(200, { timeoutMs: 180_000 }),
    (error) => {
      // The refill's own bound is named, so a 3-minute wait is never mistaken
      // for a hung host.
      assert.match(error.message, /within 180s/);
      return true;
    },
  );
});
