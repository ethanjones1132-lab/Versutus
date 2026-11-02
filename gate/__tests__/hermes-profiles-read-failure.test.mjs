import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listHermesBots, toPublicBot } from '../core/cli-environments/hermes-profiles.mjs';
import { createHermesBackend } from '../core/cli-environments/backends/hermes.mjs';

// `listHermesBots` answered with the default Bot alone for ANY `readdir`
// failure under `profiles/`, with no log and no error. So a locked, shadowed or
// non-directory profiles directory looked exactly like a host with no named
// Bots: the roster claimed to be complete while hiding every one of them.
// Absent is honestly one Bot; unreadable is a failed read and must say so.

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempHome(prefix) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  roots.push(home);
  return home;
}

test('a profiles directory that cannot be listed fails the roster instead of hiding every Bot', async () => {
  const home = await tempHome('hermes-roster-read-');
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-key\n', 'utf8');
  // A file where the directory belongs: `readdir` refuses with ENOTDIR, the
  // same shape a locked or network-backed home produces. The default profile is
  // still readable, which is exactly what made the old answer look healthy.
  await writeFile(join(home, 'profiles'), 'not a directory', 'utf8');

  await assert.rejects(() => listHermesBots(home), (error) => {
    assert.equal(error.code, 'hermes_profiles_unreadable');
    assert.match(error.message, /ENOTDIR/);
    return true;
  });
});

test('the Hermes roster reports the unreadable directory rather than an empty roster', async () => {
  const home = await tempHome('hermes-roster-backend-');
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-key\n', 'utf8');
  await writeFile(join(home, 'profiles'), 'not a directory', 'utf8');

  const hermes = createHermesBackend({
    baseUrl: 'http://hermes.invalid:8642',
    apiKey: 'default-key',
    profilesHome: home,
    fetchImpl: async () => {
      throw new Error('a roster read must not reach the network');
    },
  });

  await assert.rejects(() => hermes.listBots(), (error) => {
    assert.equal(error.code, 'hermes_profiles_unreadable');
    // The roster route's envelope keeps a 5xx, so the phone can tell a failed
    // read from an empty roster instead of painting "No bots".
    assert.equal(error.status, 503);
    return true;
  });
});

test('a host with no profiles directory is the default Bot alone', async () => {
  const home = await tempHome('hermes-roster-absent-');
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-key\n', 'utf8');

  const bots = await listHermesBots(home);

  assert.deepEqual(bots.map((bot) => bot.id), ['default']);
  assert.equal(bots[0].listenKey, 'default-key');
});

test('a healthy host still lists default first and a profile with no .env as keyless', async () => {
  const home = await tempHome('hermes-roster-healthy-');
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-key\n', 'utf8');
  await mkdir(join(home, 'profiles', 'researcher'), { recursive: true });
  await writeFile(join(home, 'profiles', 'researcher', '.env'), 'API_SERVER_KEY=res-key\n', 'utf8');
  await mkdir(join(home, 'profiles', 'quiet'), { recursive: true });

  const bots = await listHermesBots(home);

  assert.equal(bots[0].id, 'default');
  assert.deepEqual(
    bots.slice(1).map((bot) => bot.id).sort(),
    ['quiet', 'researcher'],
    'the failing read must not drop the rows a healthy host does return',
  );
  const quiet = bots.find((bot) => bot.id === 'quiet');
  // A missing .env is a missing key, not a failed roster read.
  assert.deepEqual(toPublicBot(quiet), {
    id: 'quiet',
    displayName: 'quiet',
    routable: false,
    routingIssue: 'listen_key_missing',
    description: null,
    model: null,
  });
  assert.equal(bots.find((bot) => bot.id === 'researcher').listenKey, 'res-key');
});
