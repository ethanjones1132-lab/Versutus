import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createRegistryMethods } from '../core/capabilities/registry-methods.mjs';
import { CliEnvironmentStore } from '../core/cli-environments/store.mjs';
import { ProviderStore } from '../core/providers/store.mjs';
import { validEnvironment } from './fixtures/cli-environment.mjs';

const roots = [];
const locks = [];

// A locked directory is `0o555`, and on POSIX unlinking a file out of it needs
// write permission on the directory — so `rm -r` of the temp tree fails with
// EACCES (which `fs.rm` does not retry). The permissions have to go back before
// the tree is removed, or the cleanup rejects and fails the test that locked it.
afterEach(async () => {
  await Promise.all(locks.splice(0).map((restore) => restore()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempHome(prefix) {
  const gateHome = await mkdtemp(join(tmpdir(), prefix));
  roots.push(gateHome);
  return gateHome;
}

function environmentFile(gateHome, id) {
  return join(gateHome, 'config', 'environments', `${id}.json`);
}

function providerConfigFile(gateHome, id) {
  return join(gateHome, 'config', 'providers', `${id}.json`);
}

function providerStateFile(gateHome, id) {
  return join(gateHome, 'state', 'providers', `${id}.json`);
}

function provider(id = 'openai-main') {
  return {
    schemaVersion: 2,
    kind: 'provider',
    id,
    label: 'OpenAI API',
    providerType: 'openai',
    enabled: true,
    registration: {
      mode: 'api_key',
      protocol: 'openai_chat',
      baseUrl: 'https://api.openai.com/v1',
      credentialRef: `provider/${id}/api-key`,
    },
    catalogPolicy: { ttlSeconds: 300, allowLastKnownGood: true },
    requestPolicy: { timeoutMs: 120000 },
  };
}

function providerState(generation) {
  return { catalog: { source: 'live', state: 'fresh', generation, models: [] } };
}

/**
 * Records the paths a module passes to `node:fs/promises`. The Gate's ESM named
 * imports are snapshots of the CommonJS export object, so patching that object
 * and re-syncing is the only way to watch a write without touching the code
 * under test.
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

/** Captures what a run logged, so "logs once" is an assertion and not a hope. */
async function captureLogs(run) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    return { value: await run(), lines };
  } finally {
    console.error = original;
  }
}

/**
 * Makes the filesystem refuse to replace a record in place: the record is
 * read-only, inside a read-only directory. Windows refuses the rename (EPERM),
 * POSIX refuses creating the temp (EACCES) — either way the live record is left
 * exactly as it was, which a delete-then-rename write cannot promise. The
 * `afterEach` hook restores both modes before it removes the temp tree.
 */
async function lockAgainstReplacement(path) {
  await chmod(path, 0o444);
  await chmod(dirname(path), 0o555);
  locks.push(async () => {
    await chmod(dirname(path), 0o755);
    await chmod(path, 0o644);
  });
}

/** The name writeFileAtomic gives the temp sibling it renames over the record. */
function isTempSiblingOf(recordPath, writtenPath) {
  return /^\.\d+\.[0-9a-f]{12}\.tmp$/.test(writtenPath.slice(recordPath.length));
}

/**
 * Refuses the first `times` reads of each named path with `code`, the way
 * Windows refuses an open while a writer renames the file. `readJsonFile` calls
 * every non-ENOENT read failure `corrupt`, so the store has to recognise these
 * codes as transient and wait them out — otherwise a live record answers
 * "not found", which is the symptom this store exists to remove.
 */
function refuseReads(plan) {
  const original = fsPromises.readFile;
  const refusals = new Map(
    Object.entries(plan).map(([path, { code, times }]) => [path, { code, times, refused: 0, reads: 0 }]),
  );
  fsPromises.readFile = async (target, ...rest) => {
    const entry = refusals.get(String(target));
    if (!entry) return original(target, ...rest);
    entry.reads += 1;
    if (entry.refused < entry.times) {
      entry.refused += 1;
      const error = new Error(`${entry.code}: operation not permitted, open '${target}'`);
      error.code = entry.code;
      throw error;
    }
    return original(target, ...rest);
  };
  syncBuiltinESMExports();
  return {
    reads: (path) => refusals.get(path).reads,
    restore() {
      fsPromises.readFile = original;
      syncBuiltinESMExports();
    },
  };
}

// ─── a reader never loses a record to a save in flight ─────────────────────
//
// Two readers, because they can be trusted in different ways. The directory
// reader is hot: it never opens the record, so it cannot starve the writer's
// own rename on Windows, and it samples exactly the window a delete-then-rename
// write left open — which is also the window that made `list()` skip a live
// record. The `get` reader is paced instead: a free-running `get` opens the
// record thousands of times a second, and the writer's rename then loses its
// retries. That is a property of Windows file locking, not of the code under
// test, and a test that fails on it tests nothing.

test('an environment record is never absent from its directory while it is being saved', async () => {
  const gateHome = await tempHome('gate-env-atomic-');
  const store = new CliEnvironmentStore(gateHome);
  const record = validEnvironment();
  await store.put(record);
  const dir = join(gateHome, 'config', 'environments');

  let samples = 0;
  let absent = 0;
  let saving = true;
  const watcher = (async () => {
    while (saving) {
      samples += 1;
      if (!(await readdir(dir)).includes('hermes-local.json')) absent += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  for (let generation = 0; generation < 300; generation += 1) {
    await store.put({ ...record, label: `Hermes ${generation}` });
  }
  saving = false;
  await watcher;

  assert.ok(samples > 300, `the watcher never raced the writer (only ${samples} samples)`);
  assert.equal(absent, 0, `the record was absent from the directory ${absent} times mid-save`);
});

test('an environment never goes missing from a read while it is being saved', async () => {
  const gateHome = await tempHome('gate-env-atomic-');
  const store = new CliEnvironmentStore(gateHome);
  const record = validEnvironment();
  await store.put(record);

  let reads = 0;
  let missing = 0;
  let saving = true;
  const reader = (async () => {
    while (saving) {
      reads += 1;
      if ((await store.get('hermes-local')) === null) missing += 1;
      // Paced, not free-running: see the note above these tests.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  for (let generation = 0; generation < 400; generation += 1) {
    await store.put({ ...record, label: `Hermes ${generation}` });
  }
  saving = false;
  await reader;

  assert.ok(reads > 5, `the reader never raced the writer (only ${reads} reads)`);
  assert.equal(missing, 0, `the environment vanished ${missing} times mid-save`);
});

test("a provider's two records are never absent from their directories while they are being saved", async () => {
  const gateHome = await tempHome('gate-prov-atomic-');
  const store = new ProviderStore(gateHome);
  await store.put(provider(), providerState(0));
  const configDir = join(gateHome, 'config', 'providers');
  const stateDir = join(gateHome, 'state', 'providers');

  let samples = 0;
  let absent = 0;
  let saving = true;
  const watcher = (async () => {
    while (saving) {
      samples += 1;
      // Each directory is checked on its own: the two files are written one
      // after the other, so pooling their names would let one of them mask the
      // other's absence.
      const configs = await readdir(configDir);
      const states = await readdir(stateDir);
      if (!configs.includes('openai-main.json') || !states.includes('openai-main.json')) absent += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  for (let generation = 1; generation <= 300; generation += 1) {
    await store.put({ ...provider(), label: `OpenAI ${generation}` }, providerState(generation));
  }
  saving = false;
  await watcher;

  assert.ok(samples > 300, `the watcher never raced the writer (only ${samples} samples)`);
  assert.equal(absent, 0, `a provider record was absent from its directory ${absent} times mid-save`);
});

test('a provider never goes missing from a read while it is being saved', async () => {
  const gateHome = await tempHome('gate-prov-atomic-');
  const store = new ProviderStore(gateHome);
  await store.put(provider(), providerState(0));

  let reads = 0;
  let missing = 0;
  let bootstrapped = 0;
  let saving = true;
  // Both files are rewritten on every save, and a state file that cannot be
  // parsed falls back to the legacy bootstrap verdict — so an unatomic state
  // write shows up here as a live provider that suddenly claims to be legacy.
  const reader = (async () => {
    while (saving) {
      reads += 1;
      const record = await store.get('openai-main');
      if (record === null) missing += 1;
      else if (record.state?.catalog?.source === 'legacy_bootstrap') bootstrapped += 1;
      // Paced, not free-running: see the note above these tests.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  })();
  for (let generation = 1; generation <= 400; generation += 1) {
    await store.put({ ...provider(), label: `OpenAI ${generation}` }, providerState(generation));
  }
  saving = false;
  await reader;

  assert.ok(reads > 5, `the reader never raced the writer (only ${reads} reads)`);
  assert.equal(missing, 0, `the provider vanished ${missing} times mid-save`);
  assert.equal(bootstrapped, 0, `the provider's state file was caught mid-replace ${bootstrapped} times`);
});

// ─── a save never deletes the record it is replacing ───────────────────────

test('a saved environment is replaced by a rename, never unlinked first', async () => {
  const gateHome = await tempHome('gate-env-atomic-');
  const store = new CliEnvironmentStore(gateHome);
  const record = validEnvironment();
  await store.put(record);
  const file = environmentFile(gateHome, 'hermes-local');

  const writes = recordFsCalls('writeFile');
  const removals = recordFsCalls('rm');
  try {
    await store.put({ ...record, label: 'Second' });
  } finally {
    writes.restore();
    removals.restore();
  }

  assert.equal(writes.paths.length, 1, `unexpected writes: ${writes.paths.join(', ')}`);
  assert.ok(
    isTempSiblingOf(file, writes.paths[0]),
    `the live record was written in place: ${writes.paths[0]}`,
  );
  assert.deepEqual(removals.paths, [], 'the record was deleted before its replacement existed');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { ...record, label: 'Second' });
});

test("a saved provider's records are replaced by renames, never unlinked first", async () => {
  const gateHome = await tempHome('gate-prov-atomic-');
  const store = new ProviderStore(gateHome);
  await store.put(provider(), providerState(0));
  const configFile = providerConfigFile(gateHome, 'openai-main');
  const stateFile = providerStateFile(gateHome, 'openai-main');

  const writes = recordFsCalls('writeFile');
  const removals = recordFsCalls('rm');
  try {
    await store.put(provider(), providerState(1));
  } finally {
    writes.restore();
    removals.restore();
  }

  assert.equal(writes.paths.length, 2, `unexpected writes: ${writes.paths.join(', ')}`);
  assert.ok(isTempSiblingOf(configFile, writes.paths[0]), writes.paths[0]);
  assert.ok(isTempSiblingOf(stateFile, writes.paths[1]), writes.paths[1]);
  assert.deepEqual(removals.paths, [], 'a provider record was deleted before its replacement existed');
});

// ─── a save never leaves debris, and a refused one keeps the record ─────────

test('a saved environment leaves only its record behind', async () => {
  const gateHome = await tempHome('gate-env-atomic-');
  const store = new CliEnvironmentStore(gateHome);
  const record = validEnvironment();
  await store.put(record);
  await store.put({ ...record, label: 'Saved twice' });

  assert.deepEqual(await readdir(join(gateHome, 'config', 'environments')), ['hermes-local.json']);
});

test('a saved provider leaves only its two records behind', async () => {
  const gateHome = await tempHome('gate-prov-atomic-');
  const store = new ProviderStore(gateHome);
  await store.put(provider(), providerState(0));
  await store.put(provider(), providerState(1));

  assert.deepEqual(await readdir(join(gateHome, 'config', 'providers')), ['openai-main.json']);
  assert.deepEqual(await readdir(join(gateHome, 'state', 'providers')), ['openai-main.json']);
});

test('a refused environment save leaves the previous record intact and no temp file', async () => {
  const gateHome = await tempHome('gate-env-atomic-');
  const store = new CliEnvironmentStore(gateHome);
  const record = validEnvironment();
  await store.put(record);
  const file = environmentFile(gateHome, 'hermes-local');
  await lockAgainstReplacement(file);

  await assert.rejects(() => store.put({ ...record, label: 'Never lands' }), /EPERM|EACCES|denied/i);

  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), record, 'the refused save destroyed the record');
  assert.deepEqual(await readdir(join(gateHome, 'config', 'environments')), ['hermes-local.json']);
});

test('a refused provider save leaves the previous records intact and no temp file', async () => {
  const gateHome = await tempHome('gate-prov-atomic-');
  const store = new ProviderStore(gateHome);
  const config = provider();
  const state = providerState(1);
  await store.put(config, state);
  await lockAgainstReplacement(providerConfigFile(gateHome, 'openai-main'));

  await assert.rejects(() => store.put({ ...config, label: 'Never lands' }, providerState(2)), /EPERM|EACCES|denied/i);

  assert.deepEqual(JSON.parse(await readFile(providerConfigFile(gateHome, 'openai-main'), 'utf8')), config);
  assert.deepEqual(JSON.parse(await readFile(providerStateFile(gateHome, 'openai-main'), 'utf8')), state);
  assert.deepEqual(await readdir(join(gateHome, 'config', 'providers')), ['openai-main.json']);
});

// ─── a record that cannot be read says so instead of vanishing quietly ─────

test('an unreadable environment reads as absent, is logged once, and stays on disk', async () => {
  const gateHome = await tempHome('gate-env-atomic-');
  const store = new CliEnvironmentStore(gateHome);
  await store.put(validEnvironment());
  await store.put(validEnvironment({ id: 'second' }));
  const file = environmentFile(gateHome, 'hermes-local');
  await writeFile(file, '{ not json', 'utf8');

  const recorder = recordFsCalls('readFile');
  let result;
  try {
    result = await captureLogs(() => store.get('hermes-local'));
  } finally {
    recorder.restore();
  }

  assert.equal(result.value, null);
  assert.equal(result.lines.length, 1, `expected one loud line, got: ${result.lines.join(' | ')}`);
  assert.match(result.lines[0], /hermes-local\.json/);
  // Read twice, then a verdict: a read that raced a rename resolves on the
  // second attempt, a damaged record does not. A parse failure is not one of
  // the transient codes, so it is not waited out five times first — and it is
  // the one thing the log may call unreadable JSON.
  assert.equal(recorder.paths.filter((path) => path === file).length, 2);
  assert.match(result.lines[0], /not readable JSON/);
  assert.equal(await readFile(file, 'utf8'), '{ not json', 'the unreadable record was rewritten');
});

test('a listing skips the unreadable environment, keeps the rest, and says so', async () => {
  const gateHome = await tempHome('gate-env-atomic-');
  const store = new CliEnvironmentStore(gateHome);
  await store.put(validEnvironment());
  await store.put(validEnvironment({ id: 'second' }));
  await writeFile(environmentFile(gateHome, 'hermes-local'), '{ not json', 'utf8');

  const { value, lines } = await captureLogs(() => store.list());

  assert.deepEqual(value.map((record) => record.id), ['second']);
  assert.equal(lines.length, 1, `expected one loud line, got: ${lines.join(' | ')}`);
  assert.match(lines[0], /hermes-local\.json/);
});

test('an unreadable provider reads as absent, is logged once, and stays on disk', async () => {
  const gateHome = await tempHome('gate-prov-atomic-');
  const store = new ProviderStore(gateHome);
  await store.put(provider(), providerState(1));
  const file = providerConfigFile(gateHome, 'openai-main');
  await writeFile(file, '{ not json', 'utf8');

  const recorder = recordFsCalls('readFile');
  let result;
  try {
    result = await captureLogs(() => store.get('openai-main'));
  } finally {
    recorder.restore();
  }

  assert.equal(result.value, null);
  assert.equal(result.lines.length, 1, `expected one loud line, got: ${result.lines.join(' | ')}`);
  assert.match(result.lines[0], /openai-main\.json/);
  assert.equal(recorder.paths.filter((path) => path === file).length, 2);
  assert.equal(await readFile(file, 'utf8'), '{ not json', 'the unreadable record was rewritten');
});

test('a listing skips the unreadable provider, keeps the rest, and says so', async () => {
  const gateHome = await tempHome('gate-prov-atomic-');
  const store = new ProviderStore(gateHome);
  await store.put(provider(), providerState(1));
  await store.put(provider('acme'), providerState(1));
  await writeFile(providerConfigFile(gateHome, 'openai-main'), '{ not json', 'utf8');

  const { value, lines } = await captureLogs(() => store.list());

  assert.deepEqual(value.map((record) => record.config.id), ['acme']);
  assert.equal(lines.length, 1, `expected one loud line, got: ${lines.join(' | ')}`);
  assert.match(lines[0], /openai-main\.json/);
});

test('a provider whose state file is absent still reads, on the legacy bootstrap state', async () => {
  // The state file is optional until the first check/refresh, and a read that
  // cannot find one must still return the registration.
  const gateHome = await tempHome('gate-prov-atomic-');
  await mkdir(join(gateHome, 'config', 'providers'), { recursive: true });
  await writeFile(providerConfigFile(gateHome, 'openai-main'), JSON.stringify(provider(), null, 2), 'utf8');

  const { value, lines } = await captureLogs(() => new ProviderStore(gateHome).get('openai-main'));

  assert.equal(value.config.id, 'openai-main');
  assert.equal(value.state.catalog.source, 'legacy_bootstrap');
  assert.deepEqual(lines, [], 'a missing state file is not a corrupt record');
});

// ─── a transient read refusal is waited out, not called damage ──────────────

test('an environment that is briefly unreadable while it is replaced still reads', async () => {
  // A reader can lose a race with the writer's rename on Windows: the open is
  // refused for a few milliseconds. That is not a damaged record, and answering
  // `null` for it is `environment not found` for an environment that exists.
  const gateHome = await tempHome('gate-env-atomic-');
  const store = new CliEnvironmentStore(gateHome);
  const record = validEnvironment();
  await store.put(record);
  const file = environmentFile(gateHome, 'hermes-local');

  const refusal = refuseReads({ [file]: { code: 'EPERM', times: 2 } });
  let result;
  try {
    result = await captureLogs(() => store.get('hermes-local'));
  } finally {
    refusal.restore();
  }

  assert.equal(result.value.id, 'hermes-local', 'a transient refusal became "environment not found"');
  assert.equal(refusal.reads(file), 3, 'the record was not waited out');
  assert.deepEqual(result.lines, [], `a transient refusal was logged as damage: ${result.lines.join(' | ')}`);
});

test('a provider whose records are briefly unreadable still reads, with its state', async () => {
  const gateHome = await tempHome('gate-prov-atomic-');
  const store = new ProviderStore(gateHome);
  await store.put(provider(), providerState(1));
  const configFile = providerConfigFile(gateHome, 'openai-main');
  const stateFile = providerStateFile(gateHome, 'openai-main');

  const refusal = refuseReads({
    [configFile]: { code: 'EBUSY', times: 2 },
    [stateFile]: { code: 'EMFILE', times: 2 },
  });
  let result;
  try {
    result = await captureLogs(() => store.get('openai-main'));
  } finally {
    refusal.restore();
  }

  assert.equal(result.value.config.id, 'openai-main', 'a transient refusal became "provider not found"');
  // A state file caught mid-replace would masquerade as a legacy provider.
  assert.equal(result.value.state.catalog.source, 'live');
  assert.deepEqual(result.lines, [], `a transient refusal was logged as damage: ${result.lines.join(' | ')}`);
});

test('a record that stays unreadable is named by code, not accused of bad JSON', async () => {
  const gateHome = await tempHome('gate-env-atomic-');
  const store = new CliEnvironmentStore(gateHome);
  await store.put(validEnvironment());
  const file = environmentFile(gateHome, 'hermes-local');

  const refusal = refuseReads({ [file]: { code: 'EPERM', times: Number.POSITIVE_INFINITY } });
  let result;
  try {
    result = await captureLogs(() => store.get('hermes-local'));
  } finally {
    refusal.restore();
  }

  assert.equal(result.value, null);
  assert.equal(result.lines.length, 1, `expected one loud line, got: ${result.lines.join(' | ')}`);
  assert.match(result.lines[0], /hermes-local\.json/);
  assert.match(result.lines[0], /EPERM/, 'the log does not say why the read failed');
  assert.doesNotMatch(result.lines[0], /not readable JSON/, 'a refused open was called a broken file');
  assert.ok(refusal.reads(file) > 5, `the refusal was not waited out (${refusal.reads(file)} reads)`);
});

test('a provider record that stays unreadable is named by code too', async () => {
  const gateHome = await tempHome('gate-prov-atomic-');
  const store = new ProviderStore(gateHome);
  await store.put(provider(), providerState(1));
  const file = providerConfigFile(gateHome, 'openai-main');

  const refusal = refuseReads({ [file]: { code: 'EPERM', times: Number.POSITIVE_INFINITY } });
  let result;
  try {
    result = await captureLogs(() => store.get('openai-main'));
  } finally {
    refusal.restore();
  }

  assert.equal(result.value, null);
  assert.equal(result.lines.length, 1, `expected one loud line, got: ${result.lines.join(' | ')}`);
  assert.match(result.lines[0], /openai-main\.json/);
  assert.match(result.lines[0], /EPERM/);
  assert.doesNotMatch(result.lines[0], /not readable JSON/);
});

// ─── a capability instance is replaced by a rename, never truncated ─────────

async function registryHarness() {
  const root = await tempHome('gate-registry-atomic-');
  const kinds = new Map([['cron', {
    kind: 'cron',
    label: 'Cron',
    family: 'cron',
    configFields: [],
    validate: () => ({ ok: true, errors: [] }),
    createHandlers: () => ({}),
  }]]);
  let instances = [];
  const getState = () => ({ kinds, instances });
  const reload = async () => {
    const names = await readdir(join(root, 'registry')).catch(() => []);
    instances = [];
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
      const parsed = JSON.parse(await readFile(join(root, 'registry', name), 'utf8'));
      instances.push({
        id: name.slice(0, -'.json'.length),
        kind: parsed.kind,
        label: parsed.label,
        config: parsed.config,
      });
    }
    return getState();
  };
  return { root, methods: createRegistryMethods({ root, getState, reload }) };
}

test('an instance file is written to a temp sibling and renamed over the record', async () => {
  const { root, methods } = await registryHarness();
  const file = join(root, 'registry', 'standup.json');

  const recorder = recordFsCalls('writeFile');
  let created;
  try {
    created = await methods['registry.instances.create']({
      id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' },
    });
  } finally {
    recorder.restore();
  }

  assert.equal(created.id, 'standup');
  // A truncating write names the live record; an atomic one only ever names a
  // sibling of it, which is why a kill cannot leave a half-written instance.
  assert.equal(recorder.paths.length, 1, `unexpected writes: ${recorder.paths.join(', ')}`);
  assert.ok(
    isTempSiblingOf(file, recorder.paths[0]),
    `the live instance file was written in place: ${recorder.paths[0]}`,
  );
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' },
  });
  assert.deepEqual(await readdir(join(root, 'registry')), ['standup.json']);
});

test('an instance update is written to a temp sibling too', async () => {
  const { root, methods } = await registryHarness();
  await methods['registry.instances.create']({
    id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' },
  });
  const file = join(root, 'registry', 'standup.json');

  const recorder = recordFsCalls('writeFile');
  try {
    await methods['registry.instances.update']({ id: 'standup', label: 'Later', config: { schedule: '0 10 * * 1-5' } });
  } finally {
    recorder.restore();
  }

  assert.equal(recorder.paths.length, 1, `unexpected writes: ${recorder.paths.join(', ')}`);
  assert.ok(
    isTempSiblingOf(file, recorder.paths[0]),
    `the live instance file was written in place: ${recorder.paths[0]}`,
  );
  assert.equal(JSON.parse(await readFile(file, 'utf8')).config.schedule, '0 10 * * 1-5');
});

test('a refused instance save leaves the previous record intact and parses', async () => {
  const { root, methods } = await registryHarness();
  await methods['registry.instances.create']({
    id: 'standup', kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' },
  });
  const file = join(root, 'registry', 'standup.json');
  await lockAgainstReplacement(file);

  const recorder = recordFsCalls('writeFile');
  let refused = null;
  try {
    await assert.rejects(
      () => methods['registry.instances.update']({
        id: 'standup', label: 'Never lands', config: { schedule: '0 11 * * 1-5' },
      }),
      /EPERM|EACCES|denied/i,
    );
  } catch (error) {
    refused = error;
  } finally {
    recorder.restore();
  }
  assert.equal(refused, null, refused?.message);

  // The write only ever named a temp sibling, and the rename that could not
  // happen left the record that was already there, still parseable.
  assert.equal(recorder.paths.length, 1, `unexpected writes: ${recorder.paths.join(', ')}`);
  assert.ok(
    isTempSiblingOf(file, recorder.paths[0]),
    `the live instance file was written in place: ${recorder.paths[0]}`,
  );
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
    kind: 'cron', label: 'Standup', config: { schedule: '0 9 * * 1-5' },
  });
  assert.deepEqual(await readdir(join(root, 'registry')), ['standup.json'], 'a temp copy was left behind');
});
