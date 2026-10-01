import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { chmod, mkdir, mkdtemp, readdir, stat as fixtureStat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createHermesBackend } from '../core/cli-environments/backends/hermes.mjs';
import { getHermesBot, parseDescription, parseListenKey, parseModelPin } from '../core/cli-environments/hermes-profiles.mjs';

// Captured before any test patches it: a stub CLI creating the profile the real
// CLI would have created is fixture setup, and must not count as a write by the
// code under test.
const fixtureWrite = fsPromises.writeFile;
const fixtureRead = fsPromises.readFile;

async function hermesHome(names = ['worker-1', 'alpha', 'beta', 'gamma']) {
  const home = await mkdtemp(join(tmpdir(), 'hermes-lookup-'));
  await fixtureWrite(join(home, '.env'), 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-keep\n');
  await fixtureWrite(join(home, 'profile.yaml'), 'display_name: Harumesu\n');
  await fixtureWrite(join(home, 'config.yaml'), 'gateway:\n  multiplex_profiles: true\n');
  for (const name of names) {
    const botHome = join(home, 'profiles', name);
    await mkdir(botHome, { recursive: true });
    await fixtureWrite(join(botHome, '.env'), `API_SERVER_KEY=${name}-listen\nOPENAI_API_KEY=sk-keep\n`);
    await fixtureWrite(join(botHome, 'profile.yaml'), `display_name: ${name}\ndescription: ${name} work\n`);
    await fixtureWrite(join(botHome, 'config.yaml'), 'model:\n  default: some/model\n  provider: kilo\n');
  }
  return home;
}

/**
 * Records the paths a module passes to `node:fs/promises`. The Gate's ESM named
 * imports are snapshots of the CommonJS export object, so patching that object
 * and re-syncing is the only way to watch a read or a write without touching
 * the code under test.
 */
function recordFsCalls(method) {
  const original = fsPromises[method];
  const paths = [];
  fsPromises[method] = async (path, ...rest) => {
    paths.push(String(path));
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
  return {
    paths,
    restore() {
      fsPromises[method] = original;
      syncBuiltinESMExports();
    },
  };
}

/** The name writeFileAtomic gives the temp sibling it renames over the record. */
function isTempSiblingOf(recordPath, writtenPath) {
  return /^\.\d+\.[0-9a-f]{12}\.tmp$/.test(writtenPath.slice(recordPath.length));
}

/** Like `recordFsCalls`, but keeps the options a write was given — its mode. */
function recordFsWrites(method) {
  const original = fsPromises[method];
  const writes = [];
  fsPromises[method] = async (path, ...rest) => {
    // writeFile(path, data) or writeFile(path, data, options): the options are
    // the LAST argument, never the first — rest[0] is the data.
    writes.push({ path: String(path), options: rest.length > 1 ? rest[rest.length - 1] : undefined });
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
  return {
    writes,
    restore() {
      fsPromises[method] = original;
      syncBuiltinESMExports();
    },
  };
}

/**
 * Makes the filesystem refuse to replace a file in place: read-only file,
 * read-only directory. Windows refuses the rename (EPERM), POSIX refuses
 * creating the temp (EACCES) — either way the live file is left as it was. The
 * returned undo puts the modes back: a `0o555` directory cannot be unlinked
 * out of on POSIX, and these homes live in the OS temp directory.
 */
async function lockAgainstReplacement(path) {
  await chmod(path, 0o444);
  await chmod(dirname(path), 0o555);
  return async () => {
    await chmod(dirname(path), 0o755);
    await chmod(path, 0o644);
  };
}

// ─── one Bot, one profile ──────────────────────────────────────────────────

test('getHermesBot reads only the profile it was asked for', async () => {
  // The named lookup used to walk the whole roster: every profile on the host,
  // three files each, for every Bot of every group turn. Only the one profile
  // the id addresses can hold the answer.
  const home = await hermesHome();
  const reads = [];

  const record = await getHermesBot(home, 'worker-1', {
    readFile: (path, encoding) => { reads.push(String(path)); return fixtureRead(path, encoding); },
  });

  assert.equal(record.id, 'worker-1');
  assert.equal(record.listenKey, 'worker-1-listen');
  assert.equal(record.displayName, 'worker-1');
  assert.equal(record.description, 'worker-1 work');
  assert.deepEqual(record.model, { default: 'some/model', provider: 'kilo' });
  assert.equal(reads.length, 3, `expected three file reads, got: ${reads.join(', ')}`);
  assert.deepEqual([...new Set(reads.map((path) => dirname(path)))], [join(home, 'profiles', 'worker-1')]);
});

test('getHermesBot(default) still reads only the Hermes home', async () => {
  const home = await hermesHome();
  const reads = [];

  const record = await getHermesBot(home, 'default', {
    readFile: (path, encoding) => { reads.push(String(path)); return fixtureRead(path, encoding); },
  });

  assert.equal(record.id, 'default');
  assert.equal(record.listenKey, 'default-listen');
  assert.equal(record.home, home);
  assert.deepEqual([...new Set(reads.map((path) => dirname(path)))], [home]);
});

test('a Bot id that is not a profile directory is unknown, not a path to walk', async () => {
  const home = await hermesHome();
  // A file under profiles/ is not a Bot either — listHermesBots skipped
  // everything that is not a directory, so this must stay an unknown id.
  await fixtureWrite(join(home, 'profiles', 'notes.txt'), 'not a profile\n');

  for (const id of ['../x', 'a/b', 'a\\b', '.hidden', '..', 'nope', 'notes.txt', '']) {
    assert.equal(await getHermesBot(home, id), null, `"${id}" must not resolve to a Bot`);
  }
  assert.deepEqual((await readdir(join(home, 'profiles'))).sort(), ['alpha', 'beta', 'gamma', 'notes.txt', 'worker-1']);
});

test('a differently cased Bot id is unknown, whatever the filesystem resolves it to', async () => {
  // `stat` is case-insensitive on NTFS and APFS, so a lookup that trusted it
  // answered `Worker-1` with the worker-1 profile — and the roster walk, which
  // compared the readdir name, said unknown. Nothing else on the Gate spells a
  // Bot id with a case the directory does not have.
  const home = await hermesHome(['worker-1']);

  assert.equal(await getHermesBot(home, 'Worker-1'), null);
  assert.equal(await getHermesBot(home, 'WORKER-1'), null);
  assert.equal((await getHermesBot(home, 'worker-1'))?.id, 'worker-1');
});

test('the id is matched against the directory name, not resolved through the filesystem', async () => {
  // The rule above has to hold on a case-sensitive filesystem too, so it is
  // asserted against the entry names themselves: whatever `stat` would make of
  // `Worker-1`, the id is compared to what readdir reports.
  const home = await hermesHome(['worker-1']);
  const listing = async () => [{ name: 'worker-1', isDirectory: () => true }];

  assert.equal(await getHermesBot(home, 'Worker-1', { readdir: listing }), null);
  // Parens matter: `await f()?.k` parses as `await (f()?.k)`, so it would await
  // `undefined` off the promise instead of the resolved record.
  assert.equal((await getHermesBot(home, 'worker-1', { readdir: listing }))?.listenKey, 'worker-1-listen');
});

test('forBot reads the named profile once and the default profile once', async () => {
  // One group turn calls forBot per speaker. Each call used to re-enumerate
  // every profile, then read the default profile's key a second time.
  const home = await hermesHome();
  const hermes = createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl: async () => Response.json({}),
    profilesHome: home,
  });

  const recorder = recordFsCalls('readFile');
  let scoped;
  try {
    scoped = await hermes.forBot('worker-1');
  } finally {
    recorder.restore();
  }

  assert.ok(scoped);
  const fromProfiles = recorder.paths.filter((path) => path.startsWith(join(home, 'profiles')));
  const fromHome = recorder.paths.filter((path) => dirname(path) === home);
  assert.deepEqual([...new Set(fromProfiles.map((path) => dirname(path)))], [join(home, 'profiles', 'worker-1')]);
  assert.deepEqual([...new Set(fromHome.map((path) => dirname(path)))], [home]);
  assert.equal(recorder.paths.length, 6, `expected six reads, got: ${recorder.paths.join(', ')}`);
});

// ─── a Bot's own files are replaced by a rename, never truncated ───────────

function stubbedBackend(home, { onCreate } = {}) {
  return createHermesBackend({
    baseUrl: 'http://h:8642',
    apiKey: 'default-listen',
    fetchImpl: async () => Response.json({}),
    profilesHome: home,
    executablePath: 'hermes',
    runCliImpl: async (_executable, args) => {
      if (args[0] === 'profile' && args[1] === 'create') {
        const id = args[2];
        await mkdir(join(home, 'profiles', id), { recursive: true });
        await fixtureWrite(
          join(home, 'profiles', id, '.env'),
          'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-keep\n',
        );
        await onCreate?.(id);
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
}

test('createBot writes .env and SOUL.md to temp siblings and renames them in', async () => {
  const home = await mkdtemp(join(tmpdir(), 'hermes-lookup-'));
  await fixtureWrite(join(home, '.env'), 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-keep\n');
  await fixtureWrite(join(home, 'config.yaml'), 'gateway:\n  multiplex_profiles: true\n');

  const recorder = recordFsCalls('writeFile');
  let bot;
  try {
    bot = await stubbedBackend(home).createBot({ name: 'worker-1', soul: 'Be precise.' });
  } finally {
    recorder.restore();
  }

  assert.equal(bot.id, 'worker-1');
  assert.equal(bot.routable, true);
  const botHome = join(home, 'profiles', 'worker-1');
  // A truncating write names the live file; an atomic one only ever names a
  // sibling of it. The listen key exists nowhere else, so a half-written .env
  // is a Bot that can never be addressed again.
  assert.equal(recorder.paths.length, 2, `unexpected writes: ${recorder.paths.join(', ')}`);
  for (const [written, name] of [[0, '.env'], [1, 'SOUL.md']]) {
    assert.ok(
      isTempSiblingOf(join(botHome, name), recorder.paths[written]),
      `${name} was written in place: ${recorder.paths[written]}`,
    );
  }
  const env = await fixtureRead(join(botHome, '.env'), 'utf8');
  assert.match(env, /OPENAI_API_KEY=sk-keep/, 'inherited provider keys must survive');
  assert.doesNotMatch(env, /API_SERVER_KEY=default-listen/);
  assert.equal(parseListenKey(env).length, 64);
  assert.equal(await fixtureRead(join(botHome, 'SOUL.md'), 'utf8'), 'Be precise.');
  assert.deepEqual((await readdir(botHome)).sort(), ['.env', 'SOUL.md']);
});

test('the .env holding the listen key is written 0600, not left world-readable', async () => {
  // The rename lands a fresh temp file, so the mode of the file the CLI created
  // is not inherited — it has to be stated. Every other secret file in the Gate
  // states 0600 too (tokens.mjs, pairing.mjs, device-tokens.mjs).
  const home = await mkdtemp(join(tmpdir(), 'hermes-lookup-'));
  await fixtureWrite(join(home, '.env'), 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-keep\n');
  await fixtureWrite(join(home, 'config.yaml'), 'gateway:\n  multiplex_profiles: true\n');

  const recorder = recordFsWrites('writeFile');
  try {
    await stubbedBackend(home).createBot({ name: 'worker-1' });
  } finally {
    recorder.restore();
  }

  const botHome = join(home, 'profiles', 'worker-1');
  const envWrite = recorder.writes.find((write) => isTempSiblingOf(join(botHome, '.env'), write.path));
  assert.ok(envWrite, `the .env was not written to a temp sibling: ${recorder.writes.map((w) => w.path).join(', ')}`);
  assert.equal(envWrite.options.mode, 0o600, 'the .env write did not ask for 0600');
  // Windows has no POSIX modes, so only the request is checkable there.
  if (process.platform !== 'win32') {
    const mode = (await fixtureStat(join(botHome, '.env'))).mode & 0o777;
    assert.equal(mode, 0o600, `the .env on disk is ${mode.toString(8)}`);
  }
});

test('a refused .env write leaves the key the profile already had in place', async () => {
  // The listen key exists in exactly one place, so a rotation that truncates
  // the file it is rotating leaves the Bot with no key and nothing to restore
  // from. Here the file the CLI wrote cannot be replaced at all: the rotation
  // has to refuse rather than damage it.
  const home = await mkdtemp(join(tmpdir(), 'hermes-lookup-'));
  await fixtureWrite(join(home, '.env'), 'API_SERVER_KEY=default-listen\n');
  await fixtureWrite(join(home, 'config.yaml'), 'gateway:\n  multiplex_profiles: true\n');
  const before = 'API_SERVER_KEY=default-listen\nOPENAI_API_KEY=sk-keep\n';

  let unlock = null;
  const hermes = stubbedBackend(home, {
    onCreate: async (id) => {
      const env = join(home, 'profiles', id, '.env');
      assert.equal(await fixtureRead(env, 'utf8'), before);
      unlock = await lockAgainstReplacement(env);
    },
  });

  try {
    await assert.rejects(() => hermes.createBot({ name: 'worker-1' }), /EPERM|EACCES|denied/i);
  } finally {
    await unlock?.();
  }

  const botHome = join(home, 'profiles', 'worker-1');
  assert.equal(await fixtureRead(join(botHome, '.env'), 'utf8'), before, 'the live .env was damaged');
  assert.equal(parseListenKey(await fixtureRead(join(botHome, '.env'), 'utf8')), 'default-listen');
  assert.deepEqual(await readdir(botHome), ['.env'], 'a temp copy of the listen key was left behind');
});
test('updateBot writes profile.yaml, SOUL.md and config.yaml to temp siblings', async () => {
  const home = await hermesHome(['worker-1']);
  const botHome = join(home, 'profiles', 'worker-1');

  const recorder = recordFsCalls('writeFile');
  try {
    await stubbedBackend(home).updateBot({
      id: 'worker-1',
      description: 'Now reviews patches',
      soul: 'New soul.',
      modelId: null,
      providerId: null,
    });
  } finally {
    recorder.restore();
  }

  const edited = ['profile.yaml', 'SOUL.md', 'config.yaml'];
  assert.equal(recorder.paths.length, edited.length, `unexpected writes: ${recorder.paths.join(', ')}`);
  for (const name of edited) {
    const write = recorder.paths.find((path) => path.startsWith(join(botHome, name)));
    assert.ok(write, `${name} was never written`);
    assert.ok(isTempSiblingOf(join(botHome, name), write), `${name} was written in place: ${write}`);
  }
  const yaml = await fixtureRead(join(botHome, 'profile.yaml'), 'utf8');
  assert.equal(parseDescription(yaml), 'Now reviews patches');
  assert.equal(await fixtureRead(join(botHome, 'SOUL.md'), 'utf8'), 'New soul.');
  const config = await fixtureRead(join(botHome, 'config.yaml'), 'utf8');
  assert.deepEqual(parseModelPin(config), { default: null, provider: null });
  assert.deepEqual(
    (await readdir(botHome)).sort(),
    ['.env', 'SOUL.md', 'config.yaml', 'profile.yaml'],
  );
});
