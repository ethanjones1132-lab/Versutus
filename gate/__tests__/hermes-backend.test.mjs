import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  assert.equal(calls[0].body.provider, 'openai');
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

test('createBot runs bounded profile create, rotates listen key, writes soul', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-keep\n');
  const argvLog = [];
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    profilesHome: home,
    executablePath: 'hermes',
    runCliImpl: async (_exe, args) => {
      argvLog.push(args);
      if (args[0] === 'profile' && args[1] === 'create') {
        const id = args[2];
        await mkdir(join(home, 'profiles', id), { recursive: true });
        await writeFile(join(home, 'profiles', id, '.env'), 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-keep\n');
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const bot = await hermes.createBot({
    name: 'coder',
    inheritKeys: true,
    soul: 'You are a focused coding assistant.',
    modelId: 'anthropic/claude-sonnet-4',
  });
  assert.equal(bot.id, 'coder');
  assert.equal(bot.routable, true);
  assert.deepEqual(argvLog[0], ['profile', 'create', 'coder', '--no-alias', '--clone-from', 'default']);
  assert.ok(argvLog.some((a) => a.includes('model.default')));
  const env = await (await import('node:fs/promises')).readFile(join(home, 'profiles', 'coder', '.env'), 'utf8');
  assert.match(env, /OPENAI_API_KEY=sk-keep/);
  assert.doesNotMatch(env, /API_SERVER_KEY=default-listen/);
  const soul = await (await import('node:fs/promises')).readFile(join(home, 'profiles', 'coder', 'SOUL.md'), 'utf8');
  assert.match(soul, /focused coding assistant/);
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

test('a bot holding the default listen key is refused with the fix named', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await mkdir(join(home, 'profiles', 'echo'), { recursive: true });
  await writeFile(join(home, 'profiles', 'echo', '.env'), 'API_SERVER_KEY=default-listen\n');
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'gate-key',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    profilesHome: home,
  });
  await assert.rejects(
    () => hermes.forBot('echo'),
    (err) =>
      err.code === 'bot_not_routable'
      && err.status === 409
      && /default listen key/.test(err.message)
      && /API_SERVER_KEY/.test(err.message),
  );
});

test('listBots reports a default-key copy as unroutable without leaking keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await mkdir(join(home, 'profiles', 'echo'), { recursive: true });
  await writeFile(join(home, 'profiles', 'echo', '.env'), 'API_SERVER_KEY=default-listen\n');
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'gate-key',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    profilesHome: home,
  });
  const body = await hermes.listBots();
  const echo = body.data.find((row) => row.id === 'echo');
  assert.equal(echo.routable, false);
  assert.equal(echo.routingIssue, 'default_key_refused');
  assert.equal(body.data.find((row) => row.id === 'default').routingIssue, null);
  assert.equal(JSON.stringify(body).includes('default-listen'), false);
});

test('updateBot rewrites only what the request carries, on the CLI writer\'s own terms', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await mkdir(join(home, 'profiles', 'coder'), { recursive: true });
  await writeFile(join(home, 'profiles', 'coder', '.env'), 'API_SERVER_KEY=own-key\n');
  // The CLI writes CRLF profiles and may fold the description across lines.
  await writeFile(
    join(home, 'profiles', 'coder', 'profile.yaml'),
    'display_name: coder\r\ndescription: one\r\n  two.\r\ncreated: 2026-08-22\r\n',
  );

  const argvLog = [];
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'k',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    profilesHome: home,
    executablePath: 'hermes',
    runCliImpl: async (_exe, args) => {
      argvLog.push(args);
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  const bot = await hermes.updateBot({
    id: 'coder',
    description: 'Ships reviews',
    soul: 'You are terse.',
    modelId: 'opencode-go/deepseek-v4-flash',
  });

  assert.equal(bot.id, 'coder');
  assert.equal(bot.description, 'Ships reviews');

  const yaml = await readFile(join(home, 'profiles', 'coder', 'profile.yaml'), 'utf8');
  // The folded continuation is gone; every untouched line keeps its CRLF bytes.
  assert.equal(yaml, 'display_name: coder\r\ndescription: Ships reviews\r\ncreated: 2026-08-22\r\n');
  const soul = await readFile(join(home, 'profiles', 'coder', 'SOUL.md'), 'utf8');
  assert.equal(soul, 'You are terse.');
  assert.deepEqual(argvLog, [
    ['-p', 'coder', 'config', 'set', 'model.default', 'opencode-go/deepseek-v4-flash'],
  ]);
});

test('updateBot with no editable field changes nothing at all', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await mkdir(join(home, 'profiles', 'coder'), { recursive: true });
  await writeFile(join(home, 'profiles', 'coder', '.env'), 'API_SERVER_KEY=own-key\n');
  await writeFile(join(home, 'profiles', 'coder', 'profile.yaml'), 'display_name: coder\n');
  const argvLog = [];
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'k',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    profilesHome: home,
    executablePath: 'hermes',
    runCliImpl: async (_exe, args) => {
      argvLog.push(args);
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  const bot = await hermes.updateBot({ id: 'coder' });

  assert.equal(bot.id, 'coder');
  assert.deepEqual(argvLog, []);
  const yaml = await readFile(join(home, 'profiles', 'coder', 'profile.yaml'), 'utf8');
  assert.equal(yaml, 'display_name: coder\n');
  await assert.rejects(
    () => readFile(join(home, 'profiles', 'coder', 'SOUL.md'), 'utf8'),
    /ENOENT/,
  );
});

test('updateBot refuses default, invalid and unknown bots before touching disk', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await mkdir(join(home, 'profiles', 'real'), { recursive: true });
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'k',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    profilesHome: home,
    executablePath: 'hermes',
    runCliImpl: async () => ({ code: 0, stdout: '', stderr: '' }),
  });

  // "default" is not a bot (ADR 0011) and must never be editable here.
  await assert.rejects(
    () => hermes.updateBot({ id: 'default', soul: 'x' }),
    (error) => error.code === 'invalid_bot_name' && error.status === 400,
  );
  await assert.rejects(
    () => hermes.updateBot({ id: '../etc', soul: 'x' }),
    (error) => error.code === 'invalid_bot_name',
  );
  await assert.rejects(
    () => hermes.updateBot({ id: 'ghost', description: 'x' }),
    (error) => error.code === 'unknown_bot' && error.status === 404,
  );
  await assert.rejects(() => readFile(join(home, 'SOUL.md'), 'utf8'), /ENOENT/);
});

test('updateBot without an executable or home is an honest 501', async () => {
  const { hermes } = backend();
  await assert.rejects(
    () => hermes.updateBot({ id: 'coder', description: 'x' }),
    (error) => error.code === 'backend_unsupported' && error.status === 501,
  );
});

test('a session limit travels to Hermes instead of being silently capped', async () => {
  const { calls, hermes } = backend();
  await hermes.listSessions(200);
  assert.equal(calls[0].url, 'http://h:8642/api/sessions?limit=200');

  const plain = backend();
  await plain.hermes.listSessions();
  assert.equal(plain.calls[0].url, 'http://h:8642/api/sessions');
});

test('a title Hermes already holds resolves to that session, not a failure', async () => {
  // Hermes keeps session titles unique. Bot Chat is a Bot's one canonical,
  // permanent conversation, so a refused title means "you already have it" —
  // and once a Bot has more sessions than one page holds, recovering the id
  // from the refusal is the only way back to it. Failing instead made tapping
  // that agent bounce straight back to the roster.
  const existing = { id: 'api_1787256183_54a46d4a', title: 'Bot Chat', started_at: 1, last_active: 1 };
  const { calls, hermes } = backend((url, init) => {
    if (init.method === 'POST') {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ detail: 'Title already in use by session api_1787256183_54a46d4a' }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ session: existing }) };
  });

  const session = await hermes.createSession({ title: 'Bot Chat' });
  assert.equal(session.id, 'api_1787256183_54a46d4a');
  assert.equal(session.title, 'Bot Chat');
  assert.equal(calls[1].url, 'http://h:8642/api/sessions/api_1787256183_54a46d4a');
});

test('a refusal that is not a title collision still fails', async () => {
  const { hermes } = backend((url, init) => {
    if (init.method === 'POST') {
      return { ok: false, status: 400, text: async () => JSON.stringify({ detail: 'model unavailable' }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  await assert.rejects(() => hermes.createSession({ title: 'Bot Chat' }), /model unavailable/);
});

test('a turn reports which model actually ran, not just which was asked for', async () => {
  // Hermes substitutes silently: ask for longcat-2.0 on a session with history
  // and `fallback_providers` answers as deepseek-v4-flash instead. It says so
  // in runtime.model vs runtime.requested — but the Gate used to drop that on
  // the floor, so the app showed the model the operator picked forever and the
  // swap was invisible.
  const { hermes } = backend((url, init) => {
    if (init.method === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { id: 'm1', role: 'assistant', content: 'ok' },
          usage: {
            input_tokens: 10,
            runtime: {
              provider: 'opencode-go',
              model: 'deepseek-v4-flash',
              route_source: 'raw_request',
              requested: { provider: 'opencode-go', model: 'longcat-2.0' },
            },
          },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const result = await hermes.sendMessage('ses_1', {
    text: 'hi',
    model: { providerId: 'opencode-go', modelId: 'longcat-2.0' },
  });

  assert.equal(result.runtime?.model, 'deepseek-v4-flash');
  assert.equal(result.runtime?.requested?.model, 'longcat-2.0');
});

test('a turn that was not substituted reports the model it ran', async () => {
  const { hermes } = backend((url, init) => {
    if (init.method === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          message: { id: 'm1', role: 'assistant', content: 'ok' },
          runtime: {
            provider: 'opencode-go',
            model: 'longcat-2.0',
            requested: { provider: 'opencode-go', model: 'longcat-2.0' },
          },
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });

  const result = await hermes.sendMessage('ses_1', {
    text: 'hi',
    model: { providerId: 'opencode-go', modelId: 'longcat-2.0' },
  });
  assert.equal(result.runtime?.model, 'longcat-2.0');
});

test('getBot returns one Bot with its soul and still never leaks listen keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-nope\n');
  await mkdir(join(home, 'profiles', 'researcher'), { recursive: true });
  await writeFile(join(home, 'profiles', 'researcher', '.env'), 'API_SERVER_KEY=res-listen\n');
  await writeFile(join(home, 'profiles', 'researcher', 'SOUL.md'), 'You are precise.\n');
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    profilesHome: home,
  });

  const bot = await hermes.getBot({ id: 'researcher' });
  assert.equal(bot.id, 'researcher');
  assert.equal(bot.soul, 'You are precise.\n');
  assert.equal(JSON.stringify(bot).includes('res-listen'), false);
  assert.equal(JSON.stringify(bot).includes('sk-nope'), false);
});

test('getBot on an unknown Bot is refused, not an empty Bot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    profilesHome: home,
  });

  await assert.rejects(() => hermes.getBot({ id: 'nobody' }), (error) => error.code === 'unknown_bot');
});
