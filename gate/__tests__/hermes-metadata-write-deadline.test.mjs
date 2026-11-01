import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHermesBackend } from '../core/cli-environments/backends/hermes.mjs';

// QUALITY-SCAN-2026-10-11.md: Hermes metadata writes had no time bound.
//
// `readCall` has bounded metadata reads since 2026-08-26, when a 4.8 GB
// `state.db` made `GET /api/sessions?limit=200` take 9-12 minutes. The four
// writes on that same database — createSession, deleteSession, createJob,
// removeJob — still went through the bare `call`, so opening Bot Chat or
// creating/deleting a Routine could hang the request forever while
// `/health` kept answering 200.
//
// These cases prove the same ceiling now covers those four and only those
// four, that the abort reaches the in-flight request (headers AND body), that
// a timed-out write is reported as ambiguous rather than guessed, and that it
// is never resubmitted — a second create would duplicate a session or Routine
// and a second delete would hide the first one's refusal.

const BASE = 'http://127.0.0.1:8642';
// Deliberately tiny: fixtures must never look like a real credential.
const API_KEY = 'k';

function backendWith(fetchImpl, { readTimeoutMs = 40 } = {}) {
  return createHermesBackend({ baseUrl: BASE, apiKey: API_KEY, fetchImpl, readTimeoutMs });
}

/** Records every request the backend actually sends, in order. */
function recordingFetch(responder) {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const request = {
      path: String(url).replace(/^https?:\/\/[^/]+/, ''),
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      headers: { ...(init.headers ?? {}) },
      signal: init.signal,
    };
    requests.push(request);
    return responder(request);
  };
  return { requests, fetchImpl };
}

/**
 * Wait for a write's verdict, or report `pending` after `ms`.
 *
 * Without this, an unbounded write would hold the whole suite open instead of
 * failing it — and "hangs forever" is exactly the defect under test.
 */
function outcome(write, ms = 3_000) {
  return Promise.race([
    write().then(() => ({ state: 'resolved' }), (error) => ({ state: 'rejected', error })),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ state: 'pending' }), ms);
      timer.unref?.();
    }),
  ]);
}

/**
 * A request the host accepted and then never finished answering.
 *
 * `stage: 'headers'` models the state.db stall: no status line ever arrives.
 * `stage: 'body'` models headers already sent with a body that never ends —
 * the abort has to reach the body read as much as the request, or a metadata
 * write would still wait forever on `response.text()`.
 *
 * Both fail on the caller's signal exactly as undici does. The in-flight timer
 * is REF'd on purpose: `AbortSignal.timeout()` arms an unref'd timer, so with
 * no live handle the event loop could drain before the ceiling fired and these
 * cases would read as a backend that never times out.
 */
function stallingFetch(stage) {
  // recordingFetch invokes the responder with the recorded request, the same
  // shape the stalled-refusal case destructures. A (url, init) signature
  // would see an empty init and throw before the ceiling could fire.
  return async (request) => {
    assert.ok(request.signal, 'a metadata write must pass an abort signal to its request');
    if (stage === 'headers') return abortOnSignal(request.signal);
    return { ok: true, status: 200, text: () => abortOnSignal(request.signal) };
  };
}

function abortOnSignal(signal) {
  return new Promise((_resolve, reject) => {
    const inFlight = setTimeout(() => {}, 30_000);
    const fail = () => {
      clearTimeout(inFlight);
      reject(Object.assign(new Error('aborted'), { name: signal.reason?.name ?? 'AbortError' }));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener('abort', fail, { once: true });
  });
}

/**
 * The four metadata writes the ceiling must cover, each with the exact request
 * it is supposed to send and the result a healthy host is supposed to yield.
 */
const WRITES = [
  {
    name: 'createSession',
    what: 'create a session',
    request: { method: 'POST', path: '/api/sessions', body: { title: 'Bot Chat', model: 'hermes-3' } },
    run: (backend) => backend.createSession({ title: 'Bot Chat', model: { modelId: 'hermes-3' } }),
    reply: () => Response.json({
      object: 'session',
      session: { id: 'ses_new', title: 'Bot Chat', model: 'hermes-3', started_at: 1_700_000_000 },
    }),
    assertResult(result) {
      // Create answers `{object, session}`; the caller still gets one session.
      assert.equal(result.id, 'ses_new');
      assert.equal(result.title, 'Bot Chat');
      assert.equal(result.model, 'hermes-3');
    },
  },
  {
    name: 'deleteSession',
    what: 'delete a session',
    request: { method: 'DELETE', path: '/api/sessions/nightly%20build', body: undefined },
    run: (backend) => backend.deleteSession('nightly build'),
    // Empty success body: the delete must resolve, not fail parsing nothing.
    reply: () => new Response(null, { status: 204 }),
    assertResult(result) {
      assert.equal(result, undefined);
    },
  },
  {
    name: 'createJob',
    what: 'create a cron job',
    request: { method: 'POST', path: '/api/jobs', body: { name: 'Nightly', schedule: '0 3 * * *' } },
    run: (backend) => backend.createJob({ name: 'Nightly', schedule: '0 3 * * *' }),
    reply: () => Response.json({ id: 'job_new', name: 'Nightly' }),
    assertResult(result) {
      assert.deepEqual(result, { id: 'job_new', name: 'Nightly' });
    },
  },
  {
    name: 'removeJob',
    what: 'delete a cron job',
    request: { method: 'DELETE', path: '/api/jobs/nightly%20build', body: undefined },
    run: (backend) => backend.removeJob('nightly build'),
    reply: () => new Response(null, { status: 204 }),
    assertResult(result) {
      assert.equal(result, undefined);
    },
  },
];

function assertRequest(request, expected) {
  assert.equal(request.method, expected.method);
  assert.equal(request.path, expected.path, 'the route and its encoded id are unchanged');
  assert.deepEqual(request.body, expected.body);
  assert.equal(request.headers.Authorization, `Bearer ${API_KEY}`, 'the write is still authenticated');
  if (expected.body === undefined) {
    assert.equal(request.headers['Content-Type'], undefined, 'a delete carries no body, so no JSON content type');
  } else {
    assert.equal(request.headers['Content-Type'], 'application/json');
  }
}

for (const write of WRITES) {
  test(`a stalled ${write.name} is aborted and fails as backend_timeout`, async () => {
    const { requests, fetchImpl } = recordingFetch(stallingFetch('headers'));
    const backend = backendWith(fetchImpl);

    const settled = await outcome(() => write.run(backend));

    assert.equal(settled.state, 'rejected', 'an unbounded write would stay pending, as it did before this bound');
    assert.equal(settled.error.code, 'backend_timeout');
    // The operator has to be able to tell which metadata write stalled.
    assert.ok(
      settled.error.message.includes(`"${write.what}"`),
      `the failure names the operation that did not answer: ${settled.error.message}`,
    );
    assert.match(settled.error.message, /did not answer/);
    assert.match(settled.error.message, /within/);
    assert.match(settled.error.message, /state database/);
    // A write may already have landed upstream, so the verdict must not claim
    // it did not, and must not read like a client bug.
    assert.match(settled.error.message, /may or may not have been applied/);
    assert.doesNotMatch(settled.error.message, /AbortError/);

    assert.equal(requests.length, 1, 'a timed-out write is never resubmitted');
    assertRequest(requests[0], write.request);
    assert.equal(requests[0].signal.aborted, true, 'the actual request was aborted, not merely raced');
  });

  test(`a ${write.name} whose response body stalls is still bounded and aborted`, async () => {
    // Headers are already in: the failure is a body that never ends. This is
    // the case a bare Promise.race would "fix" while leaving the socket open.
    const { requests, fetchImpl } = recordingFetch(stallingFetch('body'));
    const backend = backendWith(fetchImpl);

    const settled = await outcome(() => write.run(backend));

    assert.equal(settled.state, 'rejected');
    assert.equal(settled.error.code, 'backend_timeout');
    assert.ok(settled.error.message.includes(`"${write.what}"`));
    assert.equal(requests.length, 1, 'the timed-out write is not sent again while its body is unread');
    assert.equal(requests[0].signal.aborted, true, 'the abort reaches the stalled response body');
  });

  test(`a ${write.name} refusal whose error body stalls is still a timeout`, async () => {
    // `call` tolerates an unreadable refusal body with `.catch(() => '')`. A
    // body that never ends must not turn the ceiling into a bare "HTTP 503":
    // the write is still in flight, and its outcome is still unknown.
    const { requests, fetchImpl } = recordingFetch(({ signal }) => {
      assert.ok(signal, 'a metadata write must pass an abort signal to its request');
      return { ok: false, status: 503, text: () => abortOnSignal(signal) };
    });
    const backend = backendWith(fetchImpl);

    const settled = await outcome(() => write.run(backend));

    assert.equal(settled.state, 'rejected');
    assert.equal(settled.error.code, 'backend_timeout');
    assert.ok(settled.error.message.includes(`"${write.what}"`));
    assert.notEqual(settled.error.status, 503, 'a stalled refusal is not reported as a status Hermes never finished saying');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, true);
  });

  test(`a successful ${write.name} keeps its route, auth, body and result`, async () => {
    const { requests, fetchImpl } = recordingFetch(() => write.reply());
    const backend = backendWith(fetchImpl);

    const result = await write.run(backend);

    assert.equal(requests.length, 1);
    assertRequest(requests[0], write.request);
    write.assertResult(result);
  });

  test(`a non-timeout ${write.name} refusal keeps its status and message`, async () => {
    const { requests, fetchImpl } = recordingFetch(() => new Response('temporarily unavailable', { status: 503 }));
    const backend = backendWith(fetchImpl);

    await assert.rejects(() => write.run(backend), (error) => {
      assert.equal(error.status, 503, 'the refusal status is not rewritten as a timeout');
      assert.equal(error.message, 'hermes: temporarily unavailable', 'the host still says what it said');
      assert.notEqual(error.code, 'backend_timeout');
      return true;
    });
    assert.equal(requests.length, 1, 'a refusal is reported, never retried');
  });
}

test('a taken session title still recovers, with one create and no resubmission', async () => {
  // Compatibility: createSession's title recovery predates this bound. A 409
  // that names the existing session must still resolve through bounded reads
  // (existing hermes-read-timeout coverage) and must not become a second POST.
  const { requests, fetchImpl } = recordingFetch((request) => {
    if (request.method === 'POST') {
      return new Response(
        JSON.stringify({ error: { message: 'title already in use by session ses_held' } }),
        { status: 409 },
      );
    }
    return Response.json({ session: { id: 'ses_held', title: 'Bot Chat', started_at: 1_700_000_000 } });
  });
  const backend = backendWith(fetchImpl);

  const session = await backend.createSession({ title: 'Bot Chat' });

  assert.equal(session.id, 'ses_held');
  assert.equal(session.title, 'Bot Chat');
  assert.deepEqual(
    requests.map((request) => `${request.method} ${request.path}`),
    ['POST /api/sessions', 'GET /api/sessions/ses_held'],
    'the refusal is recovered by reading the holder, never by creating again',
  );
});

test('chat, runs and job actions keep their own bounds, not the metadata ceiling', async () => {
  // Scope guard: the defect was the four metadata writes. A chat turn and a
  // run legitimately take minutes, and a pause/resume must not gain a ceiling
  // that this brief did not ask for.
  const { requests, fetchImpl } = recordingFetch((request) => {
    if (request.path.endsWith('/chat')) {
      return Response.json({ message: { id: 'm1', role: 'assistant', content: 'ok' } });
    }
    return Response.json({ ok: true });
  });
  const backend = backendWith(fetchImpl);

  await backend.sendMessage('ses_1', { text: 'hi' });
  await backend.startRun('do it');
  await backend.runJob('job_1');
  await backend.setJobPaused('job_1', true);

  assert.deepEqual(requests.map((request) => request.path), [
    '/api/sessions/ses_1/chat',
    '/v1/runs',
    '/api/jobs/job_1/run',
    '/api/jobs/job_1/pause',
  ]);
  assert.ok(
    requests.every((request) => request.signal === undefined),
    'these are not metadata writes and must not be aborted by the metadata ceiling',
  );
});
