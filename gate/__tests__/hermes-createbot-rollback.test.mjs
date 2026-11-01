import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHermesBackend } from '../core/cli-environments/backends/hermes.mjs';

/**
 * A failed step after the Hermes CLI create used to leave the new profile
 * directory behind. The next attempt then hit the pre-create existence check
 * and was refused with bot_exists, so the Bot could never be created. These
 * cases pin both sides: the rollback, and the success path it must not touch.
 */

const CLI_OUTPUT = 'cli-output-marker';

/** A Hermes home with a default profile and no `coder` profile yet. */
async function profilesHome() {
  const home = await mkdtemp(join(tmpdir(), 'hermes-create-rollback-'));
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-keep\n');
  return home;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stands in for the real CLI. A profile create lays down what the CLI would
 * have created (the directory and a .env cloned from default); every other
 * command succeeds unless `failWhen` says otherwise.
 */
function stubCli(home, { failWhen = () => false } = {}) {
  return async (_executable, args) => {
    if (args[0] === 'profile' && args[1] === 'create') {
      const botHome = join(home, 'profiles', args[2]);
      await mkdir(botHome, { recursive: true });
      await writeFile(join(botHome, '.env'), 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-keep\n');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (failWhen(args)) return { code: 1, stdout: CLI_OUTPUT, stderr: CLI_OUTPUT };
    return { code: 0, stdout: '', stderr: '' };
  };
}

function backend(home, runCliImpl) {
  return createHermesBackend({
    baseUrl: 'http://127.0.0.1:8642',
    profilesHome: home,
    executablePath: 'hermes',
    runCliImpl,
  });
}

test('createBot removes the new profile when a later pin fails', async () => {
  const home = await profilesHome();
  // A neighbour proves the rollback is scoped to the id this call created.
  const keeperHome = join(home, 'profiles', 'keeper');
  await mkdir(keeperHome, { recursive: true });
  await writeFile(join(keeperHome, '.env'), 'API_SERVER_KEY=keeper-listen\n');

  const coderHome = join(home, 'profiles', 'coder');
  const hermes = backend(home, stubCli(home, {
    failWhen: (args) => args.includes('model.provider'),
  }));

  await assert.rejects(
    () => hermes.createBot({ name: 'coder', modelId: 'test-model', providerId: 'test-provider' }),
    (error) => {
      assert.equal(error.code, 'bot_create_failed');
      assert.equal(error.status, 502);
      assert.equal(error.message, 'failed to pin provider');
      // The fixed client-facing message carries no CLI output.
      assert.doesNotMatch(error.message, /cli-output-marker/);
      assert.doesNotMatch(JSON.stringify(error), /cli-output-marker/);
      return true;
    },
  );

  assert.equal(await exists(coderHome), false, 'a failed pin must not leave the new profile behind');
  assert.equal(await exists(keeperHome), true, 'another Bot profile must not be removed');

  // The retry reaches the create command again instead of being refused by the
  // existence pre-check with bot_exists.
  const created = await backend(home, stubCli(home)).createBot({ name: 'coder' });
  assert.equal(created.id, 'coder');
  assert.equal(await exists(coderHome), true, 'the retry must be able to create the profile');
});

test('createBot keeps the profile when the create and every pin succeed', async () => {
  const home = await profilesHome();
  const coderHome = join(home, 'profiles', 'coder');
  const argvLog = [];
  const success = stubCli(home);

  const hermes = backend(home, async (executable, args, options) => {
    argvLog.push({ args, timeoutMs: options?.timeoutMs });
    return success(executable, args, options);
  });

  const created = await hermes.createBot({
    name: 'coder',
    modelId: 'test-model',
    providerId: 'test-provider',
  });

  assert.equal(created.id, 'coder');
  assert.equal(await exists(coderHome), true, 'a successful create plus pins must leave the profile in place');
  assert.deepEqual(argvLog, [
    { args: ['profile', 'create', 'coder', '--no-alias'], timeoutMs: 60_000 },
    { args: ['-p', 'coder', 'config', 'set', 'model.default', 'test-model'], timeoutMs: 15_000 },
    { args: ['-p', 'coder', 'config', 'set', 'model.provider', 'test-provider'], timeoutMs: 15_000 },
  ]);
});
