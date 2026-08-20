import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('forBot prefixes /p/<id>/ and uses that profile listen key, not the default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await mkdir(join(home, 'profiles', 'researcher'), { recursive: true });
  await writeFile(join(home, 'profiles', 'researcher', '.env'), 'API_SERVER_KEY=res-listen\nOPENAI_API_KEY=sk-nope\n');

  const { calls, fetchImpl } = recordingFetch();
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl,
    profilesHome: home,
  });
  const scoped = await hermes.forBot('researcher');
  await scoped.listSessions();

  assert.equal(calls[0].url, 'http://h:8642/p/researcher/api/sessions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer res-listen');
});

test('forBot(default) still prefixes — omitted bot is the other door', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  const { calls, fetchImpl } = recordingFetch();
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl,
    profilesHome: home,
  });
  const scoped = await hermes.forBot('default');
  await scoped.listSessions();
  assert.equal(calls[0].url, 'http://h:8642/p/default/api/sessions');
});

test('forBot rejects unknown and unroutable bots', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await mkdir(join(home, 'profiles', 'silent'), { recursive: true });
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    profilesHome: home,
  });
  await assert.rejects(() => hermes.forBot('nope'), (err) => err.code === 'unknown_bot');
  await assert.rejects(() => hermes.forBot('silent'), (err) => err.code === 'bot_not_routable');
});

test('listBots returns every profile including default and never leaks listen keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-nope\n');
  await mkdir(join(home, 'profiles', 'researcher'), { recursive: true });
  await writeFile(join(home, 'profiles', 'researcher', '.env'), 'API_SERVER_KEY=res-listen\n');
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    profilesHome: home,
  });
  const body = await hermes.listBots();
  assert.equal(body.object, 'list');
  const ids = body.data.map((row) => row.id);
  assert.ok(ids.includes('default'));
  assert.ok(ids.includes('researcher'));
  assert.equal(body.data.find((row) => row.id === 'researcher').routable, true);
  assert.equal(JSON.stringify(body).includes('res-listen'), false);
  assert.equal(JSON.stringify(body).includes('sk-nope'), false);
});
