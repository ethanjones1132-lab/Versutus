import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createHermesBackend } from '../core/cli-environments/backends/hermes.mjs';

/**
 * The Gate's routes are covered with stub backends, which means the actual
 * upstream URLs live only here. Getting one wrong is a 404 nothing else sees.
 */
function recordingFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return responder?.(url, init) ?? { ok: true, status: 200, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}

function backend(responder) {
  const { calls, fetchImpl } = recordingFetch(responder);
  return { calls, hermes: createHermesBackend({ baseUrl: 'http://h:8642', apiKey: 'k', fetchImpl }) };
}

test('the fronted read surfaces hit the paths Hermes actually serves', async () => {
  const { calls, hermes } = backend();
  await hermes.listSkills();
  await hermes.healthDetailed();
  await hermes.listJobs();
  await hermes.listToolsets();

  assert.deepEqual(calls.map((c) => c.url), [
    'http://h:8642/v1/skills',
    'http://h:8642/health/detailed',
    'http://h:8642/api/jobs',
    'http://h:8642/v1/toolsets',
  ]);
  for (const call of calls) {
    assert.equal(call.init.headers.Authorization, 'Bearer k');
  }
});

test('job actions address the job by id and distinguish pause from resume', async () => {
  const { calls, hermes } = backend();
  await hermes.runJob('nightly build');
  await hermes.setJobPaused('nightly build', true);
  await hermes.setJobPaused('nightly build', false);

  assert.deepEqual(calls.map((c) => c.url), [
    'http://h:8642/api/jobs/nightly%20build/run',
    'http://h:8642/api/jobs/nightly%20build/pause',
    'http://h:8642/api/jobs/nightly%20build/resume',
  ]);
  assert.ok(calls.every((c) => c.init.method === 'POST'));
});

test('a streamed turn is bound to its session and asks for OpenAI-shaped chunks', async () => {
  // The session header is what keeps a streamed turn in the same transcript
  // that the non-streaming sendMessage writes to.
  const { calls, hermes } = backend(() => ({ ok: true, status: 200, body: 'stream' }));
  const response = await hermes.sendMessageStreaming('ses_9', {
    text: 'hello',
    model: { providerId: 'openai', modelId: 'gpt-4o' },
  });

  assert.equal(calls[0].url, 'http://h:8642/v1/chat/completions');
  assert.equal(calls[0].init.headers['X-Hermes-Session-Id'], 'ses_9');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.equal(calls[0].body.stream, true);
  assert.equal(calls[0].body.model, 'gpt-4o');
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'hello' }]);
  // The raw response is handed back: the caller owns the framing.
  assert.equal(response.body, 'stream');
});

test('an abort signal is forwarded so a walk-away stops the upstream turn', async () => {
  const { calls, hermes } = backend(() => ({ ok: true, status: 200, body: null }));
  const controller = new AbortController();
  await hermes.sendMessageStreaming('ses_1', { text: 'hi' }, controller.signal);
  assert.equal(calls[0].init.signal, controller.signal);
});

test('a refused stream throws with the upstream detail, not a bare status', async () => {
  const { hermes } = backend(() => ({
    ok: false,
    status: 404,
    text: async () => 'no such session',
  }));
  await assert.rejects(
    () => hermes.sendMessageStreaming('ses_gone', { text: 'hi' }),
    (error) => error.status === 404 && /no such session/.test(error.message),
  );
});

test('session turns still refuse to fake a cancel', async () => {
  const { hermes } = backend();
  await assert.rejects(() => hermes.abort(), /cannot be aborted/);
});
