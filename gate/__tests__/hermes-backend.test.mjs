import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHermesBackend } from '../core/cli-environments/backends/hermes.mjs';
import { removeModelPins } from '../core/cli-environments/hermes-config-edit.mjs';

/**
 * The Gate's routes are covered with stub backends, which means the actual
 * upstream URLs live only here. Getting one wrong is a 404 nothing else sees.
 */
function recordingFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return responder?.(url, init) ?? Response.json({});
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

for (const [method, path] of [['deleteSession', 'sessions'], ['removeJob', 'jobs']]) {
  for (const status of [200, 204, 205]) {
    test(`${method} accepts an empty HTTP ${status} success`, async () => {
      const { calls, hermes } = backend(() => new Response(null, { status }));
      assert.equal(await hermes[method]('nightly build'), undefined);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `http://h:8642/api/${path}/nightly%20build`);
      assert.equal(calls[0].init.method, 'DELETE');
    });
  }

  test(`${method} still accepts a JSON success`, async () => {
    const { hermes } = backend(() => Response.json({ deleted: true }));
    assert.equal(await hermes[method]('nightly build'), undefined);
  });

  for (const [status, body, message] of [
    [409, JSON.stringify({ error: { message: 'still running' } }), 'still running'],
    [503, 'temporarily unavailable', 'temporarily unavailable'],
    [404, '', 'HTTP 404'],
  ]) {
    test(`${method} preserves an HTTP ${status} refusal`, async () => {
      const { hermes } = backend(() => new Response(body, { status }));
      await assert.rejects(() => hermes[method]('nightly build'), (error) => {
        assert.equal(error.status, status);
        assert.equal(error.message, `hermes: ${message}`);
        return true;
      });
    });
  }

  test(`${method} does not hide malformed non-empty JSON`, async () => {
    const { hermes } = backend(() => new Response('{broken', { status: 200 }));
    await assert.rejects(() => hermes[method]('nightly build'), SyntaxError);
  });
}

test('a non-empty Hermes success still returns its JSON to the caller', async () => {
  const body = { data: [{ id: 'nightly', paused: false }] };
  const { hermes } = backend(() => Response.json(body));
  assert.deepEqual(await hermes.listJobs(), body);
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
    fetchImpl: async () => Response.json({}),
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
    fetchImpl: async () => Response.json({}),
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

for (const [label, result] of [
  ['nonzero exit', { code: 1, stdout: '', stderr: '' }],
  ['credential diagnostics', {
    code: 2,
    stdout: 'provider credential: test-provider-credential',
    stderr: 'API_SERVER_KEY=test-listen-key',
  }],
  ['terminated command', { code: null, stdout: '', stderr: '' }],
]) {
  test(`createBot refuses a failed provider pin: ${label}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
    const argvLog = [];
    const hermes = createHermesBackend({
      baseUrl: 'http://h:8642',
      profilesHome: home,
      executablePath: 'hermes',
      runCliImpl: async (_exe, args, options) => {
        argvLog.push({ args, options });
        return args.includes('model.provider') ? result : { code: 0, stdout: '', stderr: '' };
      },
    });

    await assert.rejects(
      () => hermes.createBot({ name: 'coder', modelId: 'test-model', providerId: 'test-provider' }),
      (error) => {
        assert.equal(error.code, 'bot_create_failed');
        assert.equal(error.status, 502);
        assert.equal(error.message, 'failed to pin provider');
        assert.doesNotMatch(error.stack, /test-provider-credential|test-listen-key/);
        assert.doesNotMatch(JSON.stringify(error), /test-provider-credential|test-listen-key/);
        return true;
      },
    );
    assert.deepEqual(argvLog, [
      { args: ['profile', 'create', 'coder', '--no-alias'], options: { timeoutMs: 60_000 } },
      { args: ['-p', 'coder', 'config', 'set', 'model.default', 'test-model'], options: { timeoutMs: 15_000 } },
      { args: ['-p', 'coder', 'config', 'set', 'model.provider', 'test-provider'], options: { timeoutMs: 15_000 } },
    ]);
  });
}

for (const [label, result] of [
  ['nonzero exit', { code: 1, stdout: '', stderr: '' }],
  ['credential diagnostics', {
    code: 2,
    stdout: 'provider credential: test-provider-credential',
    stderr: 'API_SERVER_KEY=test-listen-key',
  }],
  ['terminated command', { code: null, stdout: '', stderr: '' }],
]) {
  test(`createBot refuses a failed profile create with safe diagnostics: ${label}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
    const argvLog = [];
    const hermes = createHermesBackend({
      baseUrl: 'http://h:8642',
      profilesHome: home,
      executablePath: 'hermes',
      runCliImpl: async (_exe, args) => {
        argvLog.push(args);
        return args[0] === 'profile' ? result : { code: 0, stdout: '', stderr: '' };
      },
    });

    await assert.rejects(
      () => hermes.createBot({ name: 'coder' }),
      (error) => {
        assert.equal(error.code, 'bot_create_failed');
        assert.equal(error.status, 502);
        assert.equal(error.message, 'failed to create profile');
        assert.doesNotMatch(error.stack, /test-provider-credential|test-listen-key/);
        assert.doesNotMatch(JSON.stringify(error), /test-provider-credential|test-listen-key/);
        return true;
      },
    );
    assert.deepEqual(argvLog, [['profile', 'create', 'coder', '--no-alias']]);
  });
}

test('createBot refuses a failed model pin without forwarding CLI output', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    profilesHome: home,
    executablePath: 'hermes',
    runCliImpl: async (_exe, args) =>
      args.includes('model.default')
        ? {
            code: 1,
            stdout: 'provider credential: test-provider-credential',
            stderr: 'API_SERVER_KEY=test-listen-key',
          }
        : { code: 0, stdout: '', stderr: '' },
  });

  await assert.rejects(
    () => hermes.createBot({ name: 'coder', modelId: 'test-model' }),
    (error) => {
      assert.equal(error.code, 'bot_create_failed');
      assert.equal(error.status, 502);
      assert.equal(error.message, 'failed to pin model');
      assert.doesNotMatch(error.stack, /test-provider-credential|test-listen-key/);
      assert.doesNotMatch(JSON.stringify(error), /test-provider-credential|test-listen-key/);
      return true;
    },
  );
});

for (const [stage, message] of [
  [0, 'failed to create profile'],
  [1, 'failed to pin model'],
  [2, 'failed to pin provider'],
]) {
  for (const outcome of ['undefined', 'null', 'terminated', 'rejected']) {
    test(`createBot reports a safe refusal at command ${stage} when ${outcome}`, async () => {
      const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
      const argvLog = [];
      const commands = [
        { args: ['profile', 'create', 'coder', '--no-alias'], options: { timeoutMs: 60_000 } },
        { args: ['-p', 'coder', 'config', 'set', 'model.default', 'test-model'], options: { timeoutMs: 15_000 } },
        { args: ['-p', 'coder', 'config', 'set', 'model.provider', 'test-provider'], options: { timeoutMs: 15_000 } },
      ];
      const hermes = createHermesBackend({
        baseUrl: 'http://h:8642',
        profilesHome: home,
        executablePath: 'hermes',
        runCliImpl: async (_exe, args, options) => {
          argvLog.push({ args, options });
          if (argvLog.length - 1 !== stage) return { code: 0, stdout: '', stderr: '' };
          if (outcome === 'rejected') throw new Error('transport failed: API_SERVER_KEY=test-listen-key');
          if (outcome === 'terminated') return { code: null, stdout: '', stderr: '' };
          return outcome === 'null' ? null : undefined;
        },
      });

      await assert.rejects(
        () => hermes.createBot({
          name: 'coder', soul: 'A focused Bot.', modelId: 'test-model', providerId: 'test-provider',
        }),
        (error) => {
          assert.equal(error.code, 'bot_create_failed');
          assert.equal(error.status, 502);
          assert.equal(error.message, message);
          assert.doesNotMatch(error.stack, /test-listen-key|transport failed/);
          assert.doesNotMatch(JSON.stringify(error), /test-listen-key|transport failed/);
          return true;
        },
      );
      assert.deepEqual(argvLog, commands.slice(0, stage + 1));
    });
  }
}

test('createBot returns a Bot after a successful provider-only pin', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  const argvLog = [];
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    profilesHome: home,
    executablePath: 'hermes',
    runCliImpl: async (_exe, args, options) => {
      argvLog.push({ args, options });
      if (args.includes('model.provider')) {
        await writeFile(join(home, 'profiles', 'coder', 'config.yaml'), 'model:\n  provider: test-provider\n');
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  const bot = await hermes.createBot({ name: 'coder', providerId: 'test-provider' });
  assert.equal(bot.id, 'coder');
  assert.deepEqual(bot.model, { default: null, provider: 'test-provider' });
  assert.equal(bot.routable, true);
  assert.deepEqual(argvLog, [
    { args: ['profile', 'create', 'coder', '--no-alias'], options: { timeoutMs: 60_000 } },
    { args: ['-p', 'coder', 'config', 'set', 'model.provider', 'test-provider'], options: { timeoutMs: 15_000 } },
  ]);
});

test('listBots returns every profile including default and never leaks listen keys', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-nope\n');
  await mkdir(join(home, 'profiles', 'researcher'), { recursive: true });
  await writeFile(join(home, 'profiles', 'researcher', '.env'), 'API_SERVER_KEY=res-listen\n');
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl: async () => Response.json({}),
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
    fetchImpl: async () => Response.json({}),
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
    fetchImpl: async () => Response.json({}),
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
    fetchImpl: async () => Response.json({}),
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

for (const failure of ['model', 'provider', 'throw', 'clear']) {
  test(`updateBot rolls back the whole patch after a ${failure} pin failure`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
    const botHome = join(home, 'profiles', 'coder');
    await mkdir(botHome, { recursive: true });
    const originals = {
      'profile.yaml': 'display_name: coder\r\ndescription: Original\r\n',
      'SOUL.md': 'Original Soul\r\n',
      'config.yaml': 'model:\r\n  default: old-model\r\n  provider: old-provider\r\nproviders:\r\n  saved:\r\n    api_key: test-provider-credential\r\n',
      '.env': 'API_SERVER_KEY=test-listen-key\nPROVIDER_KEY=test-provider-credential\n',
    };
    for (const [name, text] of Object.entries(originals)) await writeFile(join(botHome, name), text);
    const calls = [];
    const hermes = createHermesBackend({
      baseUrl: 'http://h:8642', profilesHome: home, executablePath: 'hermes',
      runCliImpl: async (_exe, args) => {
        calls.push(args[4]);
        const configPath = join(botHome, 'config.yaml');
        const text = await readFile(configPath, 'utf8');
        await writeFile(configPath, text.replace('old-model', 'new-model'));
        if (failure === 'throw') throw new Error('CLI transport failed');
        const refused = failure === 'model' || args[4] === 'model.provider';
        return { code: refused ? 1 : 0, stdout: '', stderr: 'pin refused' };
      },
    });

    await assert.rejects(() => hermes.updateBot({
      id: 'coder', description: 'Changed', soul: 'Changed Soul',
      modelId: failure === 'clear' ? null : 'new-model', providerId: 'new-provider',
    }), failure === 'throw' ? /CLI transport failed/ : { code: 'bot_update_failed', status: 502 });
    for (const [name, text] of Object.entries(originals)) {
      assert.equal(await readFile(join(botHome, name), 'utf8'), text, `${name} is restored byte-for-byte`);
    }
    assert.deepEqual(calls, failure === 'model' || failure === 'throw'
      ? ['model.default'] : failure === 'clear' ? ['model.provider'] : ['model.default', 'model.provider']);
  });
}

test('updateBot removes newly created edit files when the pin fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  const botHome = join(home, 'profiles', 'coder');
  await mkdir(botHome, { recursive: true });
  await writeFile(join(botHome, '.env'), 'API_SERVER_KEY=test-listen-key\n');
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642', profilesHome: home, executablePath: 'hermes',
    runCliImpl: async () => {
      await writeFile(join(botHome, 'config.yaml'), 'model:\n  default: new-model\n');
      return { code: 1, stdout: '', stderr: 'pin refused' };
    },
  });
  await assert.rejects(() => hermes.updateBot({
    id: 'coder', description: 'Changed', soul: 'Changed Soul', modelId: 'new-model',
  }), { code: 'bot_update_failed' });
  for (const name of ['profile.yaml', 'SOUL.md', 'config.yaml']) {
    await assert.rejects(() => readFile(join(botHome, name)), { code: 'ENOENT' });
  }
  assert.equal(await readFile(join(botHome, '.env'), 'utf8'), 'API_SERVER_KEY=test-listen-key\n');
});

for (const which of ['model', 'provider']) {
  test(`updateBot reports bot_update_failed when a ${which} pin resolves with no result`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
    const botHome = join(home, 'profiles', 'coder');
    await mkdir(botHome, { recursive: true });
    const originals = {
      'profile.yaml': 'display_name: coder\r\ndescription: Original\r\n',
      'SOUL.md': 'Original Soul\r\n',
      'config.yaml': 'model:\r\n  default: old-model\r\n  provider: old-provider\r\nproviders:\r\n  saved:\r\n    api_key: test-provider-credential\r\n',
      '.env': 'API_SERVER_KEY=test-listen-key\nPROVIDER_KEY=test-provider-credential\n',
    };
    for (const [name, text] of Object.entries(originals)) await writeFile(join(botHome, name), text);
    const calls = [];
    const hermes = createHermesBackend({
      baseUrl: 'http://h:8642', profilesHome: home, executablePath: 'hermes',
      runCliImpl: async (_exe, args) => {
        calls.push(args[4]);
        // Simulate a partial config write followed by a missing CLI result.
        const configPath = join(botHome, 'config.yaml');
        const text = await readFile(configPath, 'utf8');
        await writeFile(configPath, text.replace('old-model', 'new-model'));
        const terminated = args[4] === (which === 'model' ? 'model.default' : 'model.provider');

        return terminated ? undefined : { code: 0, stdout: '', stderr: '' };
      },
    });

    await assert.rejects(() => hermes.updateBot({
      id: 'coder', description: 'Changed', soul: 'Changed Soul',
      modelId: 'new-model', providerId: 'new-provider',
    }), (error) => {
      assert.equal(error.code, 'bot_update_failed');
      assert.equal(error.status, 502);
      assert.equal(error.message, which === 'model' ? 'failed to pin model' : 'failed to pin provider');
      return true;
    });
    for (const [name, text] of Object.entries(originals)) {
      assert.equal(await readFile(join(botHome, name), 'utf8'), text, `${name} is restored byte-for-byte`);
    }
    assert.deepEqual(calls, which === 'model'
      ? ['model.default']
      : ['model.default', 'model.provider']);
  });
}

test('updateBot reports bot_update_failed when a terminated pin closes without an exit code', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  const botHome = join(home, 'profiles', 'coder');
  await mkdir(botHome, { recursive: true });
  await writeFile(join(botHome, '.env'), 'API_SERVER_KEY=test-listen-key\n');
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642', profilesHome: home, executablePath: 'hermes',
    // A signal-killed CLI closes without an exit code.
    runCliImpl: async () => ({ code: null, stdout: '', stderr: 'terminated' }),
  });
  await assert.rejects(() => hermes.updateBot({
    id: 'coder', description: 'Changed', soul: 'Changed Soul', modelId: 'new-model',
  }), { code: 'bot_update_failed', status: 502 });
  for (const name of ['profile.yaml', 'SOUL.md', 'config.yaml']) {
    await assert.rejects(() => readFile(join(botHome, name)), { code: 'ENOENT' });
  }
  assert.equal(await readFile(join(botHome, '.env'), 'utf8'), 'API_SERVER_KEY=test-listen-key\n');
});

test('updateBot applies a successful patch and preserves unrelated config and credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  const botHome = join(home, 'profiles', 'coder');
  await mkdir(botHome, { recursive: true });
  const credentials = 'API_SERVER_KEY=test-listen-key\nPROVIDER_KEY=test-provider-credential\n';
  await writeFile(join(botHome, '.env'), credentials);
  const unrelated = 'providers:\n  saved:\n    api_key: test-provider-credential\n';
  await writeFile(join(botHome, 'config.yaml'), `model:\n  default: old-model\n  provider: old-provider\n${unrelated}`);
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642', profilesHome: home, executablePath: 'hermes',
    runCliImpl: async (_exe, args) => {
      assert.deepEqual(args, ['-p', 'coder', 'config', 'set', 'model.provider', 'new-provider']);
      const configPath = join(botHome, 'config.yaml');
      await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('old-provider', 'new-provider'));
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const bot = await hermes.updateBot({
    id: 'coder', description: 'Changed', soul: '', modelId: null, providerId: 'new-provider',
  });
  assert.equal(bot.description, 'Changed');
  assert.equal(await readFile(join(botHome, 'SOUL.md'), 'utf8'), '');
  assert.equal(await readFile(join(botHome, 'config.yaml'), 'utf8'), `model:\n  provider: new-provider\n${unrelated}`);
  assert.equal(await readFile(join(botHome, '.env'), 'utf8'), credentials);
});

test('removeModelPins removes only the model defaults and provider, preserving the rest of the config', () => {
  const source = 'model:\r\n  default: anthropic/claude\r\n  provider: kilo\r\n  temperature: 0.2\r\nproviders:\r\n  kilo:\r\n    api_key: sk-keep\r\n';
  assert.equal(
    removeModelPins(source),
    'model:\r\n  temperature: 0.2\r\nproviders:\r\n  kilo:\r\n    api_key: sk-keep\r\n',
  );
});

test('removeModelPins removes an empty model block without touching adjacent config', () => {
  const source = 'name: coder\nmodel:\n  default: one\n  provider: two\nproviders:\n  one:\n    api_key: keep\n';
  assert.equal(
    removeModelPins(source),
    'name: coder\nproviders:\n  one:\n    api_key: keep\n',
  );
});

test('removeModelPins is a no-op when no model pin exists', () => {
  const source = 'model:\n  temperature: 0.2\nproviders:\n  one:\n    api_key: keep\n';
  assert.equal(removeModelPins(source), source);
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
    fetchImpl: async () => Response.json({}),
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

test('updateBot clears explicit null model fields and preserves provider credentials', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await mkdir(join(home, 'profiles', 'coder'), { recursive: true });
  await writeFile(join(home, 'profiles', 'coder', '.env'), 'API_SERVER_KEY=own-key\n');
  await writeFile(
    join(home, 'profiles', 'coder', 'config.yaml'),
    'model:\n  default: old-model\n  provider: old-provider\nproviders:\n  old-provider:\n    api_key: sk-keep\n',
  );
  const argvLog = [];
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'k',
    fetchImpl: async () => Response.json({}),
    profilesHome: home,
    executablePath: 'hermes',
    runCliImpl: async (_exe, args) => {
      argvLog.push(args);
      return { code: 0, stdout: '', stderr: '' };
    },
  });

  await hermes.updateBot({ id: 'coder', modelId: null, providerId: null });

  assert.deepEqual(argvLog, []);
  assert.equal(
    await readFile(join(home, 'profiles', 'coder', 'config.yaml'), 'utf8'),
    'providers:\n  old-provider:\n    api_key: sk-keep\n',
  );
});

test('updateBot refuses default, invalid and unknown bots before touching disk', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await mkdir(join(home, 'profiles', 'real'), { recursive: true });
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'k',
    fetchImpl: async () => Response.json({}),
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
    return Response.json({ session: existing });
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
    return Response.json({});
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
      return new Response(JSON.stringify({
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
        }), { status: 200 });
    }
    return Response.json({});
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
      return new Response(JSON.stringify({
          message: { id: 'm1', role: 'assistant', content: 'ok' },
          runtime: {
            provider: 'opencode-go',
            model: 'longcat-2.0',
            requested: { provider: 'opencode-go', model: 'longcat-2.0' },
          },
        }), { status: 200 });
    }
    return Response.json({});
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
    fetchImpl: async () => Response.json({}),
    profilesHome: home,
  });

  const bot = await hermes.getBot({ id: 'researcher' });
  assert.equal(bot.id, 'researcher');
  assert.equal(bot.soul, 'You are precise.\n');
  assert.equal(JSON.stringify(bot).includes('res-listen'), false);
  assert.equal(JSON.stringify(bot).includes('sk-nope'), false);
});

test('getBotMemory returns one Bot memory and never a non-whitelisted file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await mkdir(join(home, 'profiles', 'researcher', 'memories'), { recursive: true });
  await writeFile(join(home, 'profiles', 'researcher', 'memories', 'MEMORY.md'), '- cites sources\n');
  await writeFile(join(home, 'profiles', 'researcher', 'memories', 'SECRET.md'), 'sk-never-return\n');
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl: async () => Response.json({}),
    profilesHome: home,
  });

  const memory = await hermes.getBotMemory({ id: 'researcher' });
  assert.deepEqual(memory.files, [{ name: 'MEMORY.md', text: '- cites sources\n' }]);
  assert.equal(JSON.stringify(memory).includes('sk-never-return'), false);
  await assert.rejects(() => hermes.getBotMemory({ id: 'nobody' }), (error) => error.code === 'unknown_bot');

  await hermes.setBotMemory({ id: 'researcher', name: 'MEMORY.md', text: '- cites primary sources\n' });
  assert.equal(
    await readFile(join(home, 'profiles', 'researcher', 'memories', 'MEMORY.md'), 'utf8'),
    '- cites primary sources\n',
  );
  await assert.rejects(
    () => hermes.setBotMemory({ id: 'researcher', name: 'SECRET.md', text: 'x' }),
    (error) => error.code === 'invalid_memory_file',
  );
  await assert.rejects(
    () => hermes.setBotMemory({ id: 'nobody', name: 'MEMORY.md', text: 'x' }),
    (error) => error.code === 'unknown_bot',
  );
});

test('getBot on an unknown Bot is refused, not an empty Bot', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-bots-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl: async () => Response.json({}),
    profilesHome: home,
  });

  await assert.rejects(() => hermes.getBot({ id: 'nobody' }), (error) => error.code === 'unknown_bot');
});

test('listModels reads /api/model/options and does not mark unsigned-in providers available', async () => {
  const { calls, hermes } = backend(() => new Response(JSON.stringify({
      providers: [
        { slug: 'nous', name: 'Nous Portal', authenticated: true, models: ['poolside/laguna-xs-2.1:free'] },
        { slug: 'qwen-oauth', name: 'Qwen', authenticated: false, models: ['qwen3'] },
      ],
    }), { status: 200 }));
  const models = await hermes.listModels();
  assert.equal(calls[0].url, 'http://h:8642/api/model/options');
  const laguna = models.find((m) => m.modelId === 'poolside/laguna-xs-2.1:free');
  assert.equal(laguna.id, 'nous/poolside/laguna-xs-2.1:free');
  assert.equal(laguna.available, true);
  const qwen = models.find((m) => m.modelId === 'qwen3');
  assert.equal(qwen.available, false);
});

for (const shape of ['array', 'object']) {
  test(`listModels keeps valid rows in a ${shape} catalog containing malformed providers`, async () => {
    const rows = [
      { slug: 'nous', name: 'Nous Portal', authenticated: true, models: ['poolside/laguna-xs-2.1:free'] },
      null, false, 42, 'invalid', [], {},
      { slug: 42, models: ['invalid'] },
      { slug: {}, models: ['invalid'] },
      { slug: ' ', models: ['invalid'] },
      { slug: 'broken', models: { id: 'invalid' } },
      { slug: 'broken', models: 42 },
      { slug: 'broken', models: 'not-a-list' },
      { slug: 'empty', models: null },
      { id: 'qwen-oauth', name: 'Qwen', authenticated: false, models: ['qwen3'] },
      { name: 'local', models: ['local/model'] },
    ];
    const providers = shape === 'array' ? rows : Object.fromEntries(rows.map((row, index) => [index, row]));
    const { calls, hermes } = backend(() => Response.json({ providers }));
    assert.deepEqual(await hermes.listModels(), [
      { id: 'nous/poolside/laguna-xs-2.1:free', providerId: 'nous', modelId: 'poolside/laguna-xs-2.1:free', provider: 'Nous Portal', label: 'Nous Portal · poolside/laguna-xs-2.1:free', available: true },
      { id: 'qwen-oauth/qwen3', providerId: 'qwen-oauth', modelId: 'qwen3', provider: 'Qwen', label: 'Qwen · qwen3', available: false },
      { id: 'local/local/model', providerId: 'local', modelId: 'local/model', provider: 'local', label: 'local · local/model', available: true },
    ]);
    assert.equal(calls[0].url, 'http://h:8642/api/model/options');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  });
}

test('listModels discards invalid model ids without changing valid qualified ids', async () => {
  const { hermes } = backend(() => Response.json({ providers: [
    { slug: 'nous', models: ['before', null, false, 42, {}, [], '', '  ', 'vendor/model:free'] },
    { slug: 'local', name: {}, models: ['after'] },
  ] }));
  assert.deepEqual(await hermes.listModels(), [
    { id: 'nous/before', providerId: 'nous', modelId: 'before', provider: 'nous', label: 'nous · before', available: true },
    { id: 'nous/vendor/model:free', providerId: 'nous', modelId: 'vendor/model:free', provider: 'nous', label: 'nous · vendor/model:free', available: true },
    { id: 'local/after', providerId: 'local', modelId: 'after', provider: 'local', label: 'local · after', available: true },
  ]);
});

test('listModels returns an empty list when no provider catalog is present', async () => {
  for (const body of [null, {}, { providers: null }, { providers: false }, { providers: 42 }, { providers: 'invalid' }]) {
    const { hermes } = backend(() => Response.json(body));
    assert.deepEqual(await hermes.listModels(), []);
  }
  const { hermes } = backend(() => new Response(null, { status: 204 }));
  assert.deepEqual(await hermes.listModels(), []);
});

test('a run pinned to a provider-qualified model reaches Hermes with the provider split out', async () => {
  // Hermes' runs handler honours `provider` + `model` exactly as chat does
  // (api_server_runs.py, _request_agent_overrides). The Gate used to forward the
  // qualified string whole, so Hermes saw no provider, treated
  // "opencode-go/omen-alpha" as a bare model, routed it to a custom OpenRouter
  // endpoint and failed "not a valid model ID" (2026-09-16, POST /v1/runs).
  const { calls, hermes } = backend(() => Response.json({ run_id: 'run_1', status: 'started' }, { status: 202 }));
  await hermes.startRun('hello', { model: 'opencode-go-session/deepseek-v4-flash' });
  assert.equal(calls[0].url, 'http://h:8642/v1/runs');
  assert.equal(calls[0].body.model, 'deepseek-v4-flash');
  assert.equal(calls[0].body.provider, 'opencode-go-session');
});

test('a run with a bare model id or a split model object is passed through as it is', async () => {
  const { calls, hermes } = backend(() => Response.json({ run_id: 'run_2', status: 'started' }, { status: 202 }));
  await hermes.startRun('hello', { model: 'deepseek-v4-flash' });
  assert.equal(calls[0].body.model, 'deepseek-v4-flash');
  assert.equal(calls[0].body.provider, undefined);
  await hermes.startRun('hello', { model: { modelId: 'glm-5.3', providerId: 'kilo' } });
  assert.equal(calls[1].body.model, 'glm-5.3');
  assert.equal(calls[1].body.provider, 'kilo');
});

test('a run with no model names none, so Hermes keeps its own default', async () => {
  const { calls, hermes } = backend(() => Response.json({ run_id: 'run_3', status: 'started' }, { status: 202 }));
  await hermes.startRun('hello', { sessionId: 'ses_1' });
  assert.equal(calls[0].body.model, undefined);
  assert.equal(calls[0].body.provider, undefined);
  assert.equal(calls[0].body.session_id, 'ses_1');
});
